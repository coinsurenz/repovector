import { loadConfig, type Config, type Env } from './config';
import { describeMode, gradeIndex, isExternal, modeIdentity } from './embed/mode';
import { ConfigError } from './errors';
import { isGitCheckout } from './git/files';
import { runIndex, type RunResult } from './index/run';
import { TokenRateLimiter } from './index/throttle';
import type { Logger } from './log';
import { MemoryStore } from './store/memory';
import { buildMode, defaultPace, makeBackend, openForIndexing, resolveIdentity, type Identity } from './store/open';
import type { Backend } from './store/types';

export interface IndexRequest {
  env?: Env;
  log: Logger;
  dryRun?: boolean;
  /** Overrides on top of env (CLI flags). */
  root?: string;
  fullReindex?: boolean;
  history?: boolean;
  /** Tests inject a store. */
  backend?: Backend;
}

export interface IndexOutcome extends RunResult {
  identity: Identity;
  store: Config['store'];
  embedding: string;
  /** Embedding tokens per minute this run was held to; null when unpaced. */
  tokensPerMinute: number | null;
}

/** Everything `repo-vector index` and the action do: config, identity, open, run, close. Throws on failure. */
export async function indexRepository(req: IndexRequest): Promise<IndexOutcome> {
  const base = loadConfig(req.env ?? process.env);
  for (const secret of base.secrets) req.log.mask(secret);
  const cfg: Config = {
    ...base,
    indexing: {
      ...base.indexing,
      root: req.root ?? base.indexing.root,
      fullReindex: req.fullReindex ?? base.indexing.fullReindex,
      history: req.history ?? base.indexing.history,
    },
  };
  const root = cfg.indexing.root;
  if (!(await isGitCheckout(root))) {
    throw new ConfigError(`${root} is not a git checkout. In a workflow, run actions/checkout (with fetch-depth: 0) before this step, or set REPO_VECTOR_ROOT`);
  }
  const identity = await resolveIdentity(cfg, root);
  req.log.info(`repo-vector: ${identity.repo}@${identity.branch} -> ${cfg.store} index ${identity.index}`);

  const opened = req.dryRun ? await openDryRun(cfg, identity, req) : await openForIndexing(cfg, identity, req.log, req.backend);
  try {
    const pace = defaultPace(cfg, opened.embedding.provider);
    const result = await runIndex({
      root,
      repo: identity.repo,
      branch: identity.branch,
      namespace: identity.namespace,
      historyNamespace: identity.historyNamespace,
      store: opened.backend,
      embedding: opened.embedding,
      indexing: cfg.indexing,
      log: req.log,
      throttle: pace === null ? undefined : new TokenRateLimiter(pace),
      dryRun: req.dryRun,
    });
    return { ...result, identity, store: cfg.store, embedding: describeMode(opened.mode), tokensPerMinute: pace };
  } finally {
    if (!req.backend) await opened.backend.close();
  }
}

/**
 * Read-only open for --dry-run: the real store is described and its sentinel
 * read, but nothing is created or written. A missing index is planned as a
 * first run against an empty stand-in.
 */
async function openDryRun(cfg: Config, identity: Identity, req: IndexRequest) {
  const { provider, model } = cfg.embedding;
  if (!provider || !model) throw new ConfigError('REPO_VECTOR_EMBEDDING_PROVIDER and REPO_VECTOR_EMBEDDING_MODEL are required, even for a dry run');
  const mode = await buildMode(cfg, provider, model, undefined, cfg.embedding.dimensions);
  const backend = req.backend ?? (await makeBackend(cfg, mode));
  backend.setMode(mode);
  const index = await backend.describe(identity.index);
  const dimensions = isExternal(mode) ? (mode.dimensions ?? null) : null;
  if (!index) {
    if (!req.backend) await backend.close();
    req.log.info(`Index ${identity.index} does not exist yet; planning a first run`);
    const standIn = new MemoryStore(identity.index);
    return { backend: standIn as Backend, mode, embedding: { provider, model, dimension: isExternal(mode) ? mode.dimension : null, dimensions } };
  }
  const grade = gradeIndex(index, mode);
  if (!grade.usable) throw new ConfigError(`Index "${identity.index}" cannot be used with ${describeMode(mode)}: ${grade.reason}`);
  backend.use(index);
  return { backend, mode, embedding: { ...modeIdentity(mode, index), dimensions } };
}
