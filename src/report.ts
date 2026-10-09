import type { IndexOutcome } from './indexer';
import type { SearchResponse } from './types';

/** `key=value` pairs for GITHUB_OUTPUT. */
export function actionOutputs(o: IndexOutcome): Record<string, string> {
  return {
    mode: o.code.mode,
    sha: o.sha,
    namespace: o.namespace,
    files_indexed: String(o.code.filesIndexed),
    files_removed: String(o.code.filesRemoved),
    records_upserted: String(o.code.recordsUpserted + (o.history?.recordsUpserted ?? 0)),
    records_deleted: String(o.code.recordsDeleted + (o.history?.recordsDeleted ?? 0)),
    commits_indexed: String(o.history?.commitsIndexed ?? 0),
  };
}

/** Markdown for GITHUB_STEP_SUMMARY and the CLI. */
export function summaryMarkdown(o: IndexOutcome): string {
  const rows: Array<[string, string]> = [
    ['Repository', `${o.identity.repo} @ ${o.identity.branch}`],
    ['Commit', `\`${o.sha.slice(0, 12)}\``],
    ['Store / index', `${o.store} / \`${o.identity.index}\``],
    ['Embedding', o.embedding],
    ['Code namespace', `\`${o.namespace}\``],
    ['Code mode', `${o.code.mode} (${o.code.reason})`],
    ['Files indexed / removed', `${o.code.filesIndexed} / ${o.code.filesRemoved}`],
    ['Records upserted / deleted', `${o.code.recordsUpserted} / ${o.code.recordsDeleted}`],
  ];
  if (o.history) {
    rows.push(['History namespace', `\`${o.historyNamespace}\``], ['History mode', `${o.history.mode} (${o.history.reason})`], ['Commits indexed', String(o.history.commitsIndexed)]);
  }
  rows.push(['Duration', `${(o.durationMs / 1000).toFixed(1)} s`]);
  const title = o.dryRun ? '### repo-vector dry run (nothing written)' : '### repo-vector';
  return [title, '', '| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, '\\|')} |`), ''].join('\n');
}

/** Extra lines for --dry-run: what the run would cost. */
export function dryRunLines(o: IndexOutcome, tokensPerMinute: number | null): string[] {
  const tokens = o.code.estimatedTokens + (o.history?.estimatedTokens ?? 0);
  const lines = [
    `Would write ${o.code.recordsUpserted} code records from ${o.code.filesIndexed} files and remove ${o.code.filesRemoved} files' records`,
    ...(o.history ? [`Would write ${o.history.commitsIndexed} commit records`] : []),
    `Estimated embedding tokens: ${tokens.toLocaleString('en-GB')}`,
  ];
  if (tokensPerMinute) lines.push(`At ${tokensPerMinute.toLocaleString('en-GB')} tokens per minute that is at least ${(tokens / tokensPerMinute).toFixed(1)} minutes`);
  return lines;
}

/** Human-readable hits: `path:start-end  symbol  score`, then the snippet indented. */
export function formatHits(res: SearchResponse, snippetLines = 6): string {
  if (res.hits.length === 0) return `No results in namespace ${res.namespace}.`;
  return res.hits
    .map((h) => {
      const where = h.kind === 'commit' ? `${String(h.metadata.short_sha ?? h.id.slice(0, 7))}  ${String(h.metadata.authored_at ?? '').slice(0, 10)}  ${String(h.metadata.author ?? '')}` : `${h.source}:${h.startLine ?? '?'}-${h.endLine ?? '?'}`;
      const label = h.kind === 'commit' ? String(h.metadata.subject ?? '') : (h.symbol ?? '');
      const body = h.text.split('\n').slice(h.kind === 'commit' ? 0 : 1, snippetLines + 1).map((l) => `    ${l}`).join('\n');
      return `${where}  ${label}  ${h.score.toFixed(3)}\n${body}`;
    })
    .join('\n\n');
}
