import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CHUNKER_VERSION, chunkCodeDetailed, languageOf } from '../chunk/code';
import { settingsHash, type Config } from '../config';
import { looksBinary, normalizeText } from '../files/text';
import { diffSince, fileSelector, headSha, isAncestor, trackedFiles } from '../git/files';
import { listCommits } from '../git/history';
import type { Logger } from '../log';
import type { VectorStore } from '../store/types';
import type { Sentinel } from '../types';
import { chooseMode, diffTooLarge, type CurrentSettings, type RunMode } from './plan';
import { buildCodeRecord, buildCommitRecord, fileId, type Provenance } from './records';
import type { RetryPolicy } from './retry';
import { DEFAULT_RETRY, withRetry } from './retry';
import { estimateTokens, type TokenRateLimiter } from './throttle';
import { RecordWriter } from './writer';

export const TOOL_VERSION = '0.1.0';
/** Bump when the commit record format changes; forces a full history run. */
export const HISTORY_VERSION = 'h1';

export interface EmbeddingIdentity {
  provider: Sentinel['provider'];
  model: string;
  dimension: number | null;
  dimensions: number | null;
}

export interface RunOptions {
  root: string;
  repo: string;
  branch: string;
  namespace: string;
  historyNamespace: string;
  store: VectorStore;
  embedding: EmbeddingIdentity;
  indexing: Config['indexing'];
  log: Logger;
  throttle?: TokenRateLimiter;
  retry?: RetryPolicy;
  /** Read the store and the checkout, chunk everything that would be sent, write nothing. */
  dryRun?: boolean;
  now?: () => Date;
}

export interface PartResult {
  mode: RunMode;
  reason: string;
  filesIndexed: number;
  filesRemoved: number;
  recordsUpserted: number;
  recordsDeleted: number;
  estimatedTokens: number;
}

export interface RunResult {
  sha: string;
  namespace: string;
  historyNamespace: string;
  code: PartResult;
  history: (PartResult & { commitsIndexed: number }) | null;
  dryRun: boolean;
  durationMs: number;
}

/** Bring the code namespace (and, when enabled, the history namespace) in line with HEAD. Throws on failure; the sentinel then stays where it was. */
export async function runIndex(opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const sha = await headSha(opts.root);
  const code = await indexCode(opts, sha);
  const history = opts.indexing.history ? await indexHistory(opts, sha) : null;
  return { sha, namespace: opts.namespace, historyNamespace: opts.historyNamespace, code, history, dryRun: Boolean(opts.dryRun), durationMs: Date.now() - started };
}

// ---------- code ----------

async function indexCode(opts: RunOptions, head: string): Promise<PartResult> {
  const { root, store, log, indexing } = opts;
  const ns = opts.namespace;
  const tracked = await trackedFiles(root);
  const sentinel = await store.readSentinel(ns);
  const current: CurrentSettings = { head, chunkerVersion: CHUNKER_VERSION, settings: settingsHash(indexing), ...opts.embedding };
  let decision = chooseMode({ sentinel, current, forceFull: indexing.fullReindex, sentinelIsAncestor: sentinel ? await isAncestor(root, sentinel.sha) : false });

  let changed: string[] = tracked;
  let removed: string[] = [];
  if (decision.mode === 'incremental' && sentinel) {
    const diff = await diffSince(root, sentinel.sha);
    if (diffTooLarge(diff.entries, tracked.length, indexing.maxDiffRatio)) {
      decision = { mode: 'full', reason: `${diff.entries} of ${tracked.length} files changed, above REPO_VECTOR_MAX_DIFF_RATIO ${indexing.maxDiffRatio}` };
    } else {
      changed = diff.changed;
      removed = diff.removed;
    }
  }
  log.info(`Code: ${decision.mode} (${decision.reason}) into namespace ${ns}`);
  const result: PartResult = { mode: decision.mode, reason: decision.reason, filesIndexed: 0, filesRemoved: 0, recordsUpserted: 0, recordsDeleted: 0, estimatedTokens: 0 };
  if (decision.mode === 'skipped') return result;

  const full = decision.mode === 'full';
  const select = fileSelector({ root, exclude: indexing.exclude, maxFileBytes: indexing.maxFileBytes });
  const eligible: string[] = [];
  const purge = [...removed];
  for (const rel of changed) {
    if ((await select(rel)).ok) eligible.push(rel);
    else if (!full) purge.push(rel); // was indexed before, now excluded, too large or gone: drop its records
  }
  const totalEligible = full ? eligible.length : await countEligible(tracked, select);

  const p: Provenance = { repo: opts.repo, branch: opts.branch, commit: head, ingestedAt: (opts.now?.() ?? new Date()).toISOString() };
  const writer = opts.dryRun ? null : new RecordWriter({ store, namespace: ns, batchSize: indexing.batchSize, log, throttle: opts.throttle, retry: opts.retry });
  const keep = new Set<string>();
  const fallbacks = new Set<string>();
  const retry = opts.retry ?? DEFAULT_RETRY;

  for (const [i, rel] of eligible.entries()) {
    const raw = await readFile(path.join(root, rel));
    if (looksBinary(raw)) {
      if (!full) purge.push(rel);
      continue;
    }
    const text = normalizeText(raw.toString('utf8'));
    const language = languageOf(rel);
    const chunked = text.length === 0 ? { chunks: [] } : await chunkCodeDetailed(text, language, rel, indexing.chunk);
    if ('fallbackReason' in chunked && chunked.fallbackReason && !fallbacks.has(language)) {
      fallbacks.add(language);
      log.warn(`${language}: parser failed on ${rel} (${chunked.fallbackReason}); files it cannot parse use the sliding-window chunker`);
    }
    const records = chunked.chunks.map((chunk, n) => buildCodeRecord(rel, chunk, n, chunked.chunks.length, p));
    for (const r of records) keep.add(r._id);
    result.filesIndexed += 1;
    result.estimatedTokens += records.reduce((n, r) => n + estimateTokens(String(r.chunk_text)), 0);
    if (writer) {
      const prefix = `${fileId(rel)}:`;
      // Incremental: a file that shrank leaves a tail of old chunk ids; delete it once the new chunks are stored.
      const after = full ? undefined : async () => {
        result.recordsDeleted += await withRetry(() => store.deleteByPrefix(ns, prefix, records.length), retry);
      };
      await writer.add(records, after);
    } else {
      result.recordsUpserted += records.length;
    }
    if ((i + 1) % 250 === 0) log.info(`  ${i + 1}/${eligible.length} files chunked`);
  }

  if (writer) {
    await writer.flush();
    result.recordsUpserted = writer.upserted;
    if (full) {
      // Sweep instead of emptying first: the namespace is never empty mid-run, and nothing races the upserts.
      result.recordsDeleted += await withRetry(() => store.deleteExcept(ns, keep), retry);
    } else {
      for (const rel of purge) result.recordsDeleted += await withRetry(() => store.deleteByPrefix(ns, `${fileId(rel)}:`, 0), retry);
    }
  }
  result.filesRemoved = full ? 0 : purge.length;
  log.info(`Code: ${result.filesIndexed} files indexed, ${result.filesRemoved} removed, ${result.recordsUpserted} records upserted, ${result.recordsDeleted} deleted`);

  if (writer) {
    await store.writeSentinel(ns, {
      kind: 'code', sha: head, branch: opts.branch, repo: opts.repo, chunkerVersion: CHUNKER_VERSION, toolVersion: TOOL_VERSION,
      settings: current.settings, ...opts.embedding, indexedAt: p.ingestedAt, files: totalEligible,
      lastRun: { mode: decision.mode as 'full' | 'incremental', filesIndexed: result.filesIndexed, filesRemoved: result.filesRemoved, recordsUpserted: result.recordsUpserted, recordsDeleted: result.recordsDeleted },
    });
  }
  return result;
}

async function countEligible(tracked: string[], select: (rel: string) => Promise<{ ok: boolean }>): Promise<number> {
  let n = 0;
  for (const rel of tracked) if ((await select(rel)).ok) n += 1;
  return n;
}

// ---------- history ----------

async function indexHistory(opts: RunOptions, head: string): Promise<PartResult & { commitsIndexed: number }> {
  const { root, store, log, indexing } = opts;
  const ns = opts.historyNamespace;
  const sentinel = await store.readSentinel(ns);
  const current: CurrentSettings = { head, chunkerVersion: HISTORY_VERSION, settings: `max${indexing.chunk.max}`, ...opts.embedding };
  const decision = chooseMode({ sentinel, current, forceFull: indexing.fullReindex, sentinelIsAncestor: sentinel ? await isAncestor(root, sentinel.sha) : false });
  log.info(`History: ${decision.mode} (${decision.reason}) into namespace ${ns}`);
  const result = { mode: decision.mode, reason: decision.reason, filesIndexed: 0, filesRemoved: 0, recordsUpserted: 0, recordsDeleted: 0, estimatedTokens: 0, commitsIndexed: 0 };
  if (decision.mode === 'skipped') return result;

  const full = decision.mode === 'full';
  const commits = full ? await listCommits(root, 'HEAD', indexing.historyMaxCommits) : await listCommits(root, `${sentinel!.sha}..HEAD`);
  const ingestedAt = (opts.now?.() ?? new Date()).toISOString();
  const records = commits.map((c) => buildCommitRecord(c, indexing.chunk.max, { repo: opts.repo, branch: opts.branch, ingestedAt }));
  result.commitsIndexed = records.length;
  result.estimatedTokens = records.reduce((n, r) => n + estimateTokens(String(r.chunk_text)), 0);
  if (opts.dryRun) {
    result.recordsUpserted = records.length;
    return result;
  }
  const writer = new RecordWriter({ store, namespace: ns, batchSize: indexing.batchSize, log, throttle: opts.throttle, retry: opts.retry });
  for (const r of records) await writer.add([r]);
  await writer.flush();
  result.recordsUpserted = writer.upserted;
  if (full) result.recordsDeleted = await withRetry(() => store.deleteExcept(ns, new Set(records.map((r) => r._id))), opts.retry ?? DEFAULT_RETRY);
  const total = full ? records.length : (sentinel?.files ?? 0) + records.length;
  log.info(`History: ${records.length} commits indexed`);
  await store.writeSentinel(ns, {
    kind: 'commit', sha: head, branch: opts.branch, repo: opts.repo, chunkerVersion: HISTORY_VERSION, toolVersion: TOOL_VERSION,
    settings: current.settings, ...opts.embedding, indexedAt: ingestedAt, files: total,
    lastRun: { mode: decision.mode as 'full' | 'incremental', filesIndexed: 0, filesRemoved: 0, recordsUpserted: result.recordsUpserted, recordsDeleted: result.recordsDeleted },
  });
  return result;
}
