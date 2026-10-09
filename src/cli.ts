#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createClient } from './client';
import { loadDotEnv } from './env';
import { errorMessage } from './errors';
import { indexRepository } from './indexer';
import { TOOL_VERSION } from './index/run';
import { createLogger } from './log';
import { dryRunLines, formatHits, summaryMarkdown } from './report';

const HELP = `repo-vector ${TOOL_VERSION}: semantic search over a git repository, kept current by CI

Usage:
  repo-vector index   [--root DIR] [--full] [--no-history] [--dry-run]
  repo-vector search  "<query>" [--top 10] [--branch B] [--language ts] [--ext ts] [--path apps/api] [--rerank] [--json]
  repo-vector history "<query>" [--top 10] [--branch B] [--since 2026-01-01] [--until 2026-12-31] [--author NAME] [--json]
  repo-vector status  [--branch B] [--json]
  repo-vector serve   HTTP API (REPO_VECTOR_SERVER_* settings)
  repo-vector mcp     MCP server on stdio

Configuration comes from the environment (and a .env file in the current folder).
Required: REPO_VECTOR_STORE plus PINECONE_API_KEY or DATABASE_URL. See the README.`;

const shared = {
  help: { type: 'boolean', short: 'h' },
  json: { type: 'boolean' },
  branch: { type: 'string' },
  top: { type: 'string', short: 'k' },
} as const;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return command ? 0 : 1;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${TOOL_VERSION}\n`);
    return 0;
  }
  loadDotEnv();
  const log = createLogger();
  switch (command) {
    case 'index':
      return indexCommand(rest, log);
    case 'search':
      return searchCommand(rest);
    case 'history':
      return historyCommand(rest);
    case 'status':
      return statusCommand(rest);
    case 'serve': {
      const { serve } = await import('./server');
      await serve();
      return -1; // keep running
    }
    case 'mcp': {
      const { runMcp } = await import('./mcp');
      await runMcp();
      return -1;
    }
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}\n`);
      return 1;
  }
}

async function indexCommand(args: string[], log: ReturnType<typeof createLogger>): Promise<number> {
  const { values } = parseArgs({ args, options: { root: { type: 'string' }, full: { type: 'boolean' }, 'no-history': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' } }, strict: true });
  const outcome = await indexRepository({ log, root: values.root, fullReindex: values.full || undefined, history: values['no-history'] ? false : undefined, dryRun: values['dry-run'] });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  } else {
    process.stdout.write(`${summaryMarkdown(outcome)}\n`);
    if (outcome.dryRun) process.stdout.write(`${dryRunLines(outcome, outcome.tokensPerMinute).join('\n')}\n`);
  }
  return 0;
}

async function searchCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...shared, language: { type: 'string' }, ext: { type: 'string' }, path: { type: 'string' }, rerank: { type: 'boolean' } },
  });
  const query = positionals.join(' ').trim();
  if (!query) throw new Error('Give a query, e.g. repo-vector search "where are webhooks verified"');
  const client = await createClient({ branch: values.branch });
  try {
    const res = await client.search({ query, topK: toInt(values.top), language: values.language, ext: values.ext, pathPrefix: values.path, rerank: values.rerank });
    process.stdout.write(values.json ? `${JSON.stringify(res, null, 2)}\n` : `${formatHits(res)}\n`);
  } finally {
    await client.close();
  }
  return 0;
}

async function historyCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...shared, since: { type: 'string' }, until: { type: 'string' }, author: { type: 'string' } },
  });
  const query = positionals.join(' ').trim();
  if (!query) throw new Error('Give a query, e.g. repo-vector history "when did refunds start retrying"');
  const client = await createClient({ branch: values.branch });
  try {
    const res = await client.searchHistory({ query, topK: toInt(values.top), since: values.since, until: values.until, author: values.author });
    process.stdout.write(values.json ? `${JSON.stringify(res, null, 2)}\n` : `${formatHits(res)}\n`);
  } finally {
    await client.close();
  }
  return 0;
}

async function statusCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: shared });
  const client = await createClient({ branch: values.branch });
  try {
    const s = await client.status();
    if (values.json) {
      process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
      return 0;
    }
    const line = (label: string, sentinel: typeof s.code) =>
      sentinel ? `${label}: ${sentinel.sha.slice(0, 12)} indexed ${sentinel.indexedAt} (${sentinel.files} ${sentinel.kind === 'code' ? 'files' : 'commits'}; last run ${sentinel.lastRun.mode})` : `${label}: not indexed yet`;
    process.stdout.write(
      [
        `${s.repo} @ ${s.branch}  ->  ${s.store} index ${s.index}`,
        `Embedding: ${s.embedding.provider} ${s.embedding.model}${s.embedding.dimension ? ` (${s.embedding.dimension} d)` : ''}`,
        line(`Code    ${s.namespace}`, s.code),
        line(`History ${s.historyNamespace}`, s.history),
        `Namespaces in the index: ${s.stats.namespaces.map((n) => `${n.name} (${n.recordCount})`).join(', ') || 'none'}`,
      ].join('\n') + '\n',
    );
  } finally {
    await client.close();
  }
  return 0;
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error('--top must be a positive whole number');
  return n;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    createLogger().error(errorMessage(err));
    process.exitCode = 1;
  },
);
