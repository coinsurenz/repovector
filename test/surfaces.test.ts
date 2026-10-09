import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RepoVectorClient } from '../src/client';
import { loadConfig } from '../src/config';
import { runIndex } from '../src/index/run';
import { memoryLogger } from '../src/log';
import { createMcpServer } from '../src/mcp';
import { formatHits } from '../src/report';
import { createHandler, serve } from '../src/server';
import { MemoryStore } from '../src/store/memory';
import { FixtureRepo, NO_RETRY, indexingConfig, tsFunctions } from './helpers';

const NS = 'acme-shop--main';

async function indexedClient(repo: FixtureRepo): Promise<RepoVectorClient> {
  const store = new MemoryStore('shop');
  await repo.write('src/webhooks.ts', tsFunctions(['verifyWebhookSignature', 'dispatchWebhook']));
  await repo.write('src/refunds.py', 'def issue_refund(order):\n    """Refund an order."""\n    return order.total\n');
  repo.commit('feat: webhook signatures and refunds');
  const embedding = { provider: 'memory' as const, model: 'memory', dimension: null, dimensions: null };
  await runIndex({ root: repo.root, repo: 'acme/shop', branch: 'main', namespace: NS, historyNamespace: `${NS}-history`, store, embedding, indexing: indexingConfig(), log: memoryLogger(), retry: NO_RETRY });
  const cfg = loadConfig({ REPO_VECTOR_STORE: 'pinecone', PINECONE_API_KEY: 'x', REPO_VECTOR_REPO: 'acme/shop', REPO_VECTOR_BRANCH: 'main' });
  return new RepoVectorClient(cfg, { repo: 'acme/shop', branch: 'main', index: 'shop', namespace: NS, historyNamespace: `${NS}-history` }, {
    backend: store, index: (await store.describe('shop'))!, mode: { provider: 'memory' }, sentinel: await store.readSentinel(NS), embedding,
  });
}

describe('HTTP server', () => {
  let repo: FixtureRepo;
  let server: Server;
  let base: string;
  const log = memoryLogger();

  before(async () => {
    repo = await FixtureRepo.create();
    const client = await indexedClient(repo);
    server = createServer(createHandler({ client, config: { store: 'pinecone', server: { token: 's3cret', host: '127.0.0.1', port: 0, corsOrigin: null, topKMax: 100 } }, log }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await repo.remove();
  });

  const post = (path: string, body: unknown, token: string | null = 's3cret', type = 'application/json') =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': type, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  test('health is open; everything else needs the token', async () => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, store: 'pinecone', index: 'shop', namespace: NS });
    assert.equal((await post('/search', { query: 'x' }, null)).status, 401);
    assert.equal((await post('/search', { query: 'x' }, 'wrong')).status, 401);
    assert.equal((await fetch(`${base}/status`)).status, 401);
  });

  test('search returns the right file first; history returns commits', async () => {
    const res = await post('/search', { query: 'verify webhook signature', topK: 3 });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { hits: Array<{ source: string; kind: string }> };
    assert.equal(body.hits[0]!.source, 'src/webhooks.ts');
    assert.ok(body.hits.every((h) => h.kind === 'code'));
    const history = (await (await post('/history/search', { query: 'webhook signatures refunds' })).json()) as { hits: Array<{ kind: string; metadata: { subject: string } }> };
    assert.equal(history.hits[0]!.metadata.subject, 'feat: webhook signatures and refunds');
    const status = (await (await fetch(`${base}/status`, { headers: { authorization: 'Bearer s3cret' } })).json()) as { code: { kind: string } };
    assert.equal(status.code.kind, 'code');
  });

  test('validation, limits and unknown routes', async () => {
    assert.equal((await post('/search', { query: '' })).status, 400);
    assert.equal((await post('/search', { query: 'x', unknown: 1 })).status, 400);
    assert.equal((await post('/search', 'not json')).status, 400);
    assert.equal((await post('/search', { query: 'x' }, 's3cret', 'text/plain')).status, 415);
    assert.equal((await post('/search', { query: 'x'.repeat(70_000) })).status, 413);
    assert.equal((await post('/search', { query: 'x', filter: { a: { $ne: 1 } } })).status, 400);
    assert.equal((await post('/search', { query: 'x', branch: 'dev' })).status, 200, 'another branch is just an empty namespace');
    assert.equal((await post('/nope', {})).status, 404);
    assert.equal((await fetch(`${base}/search`, { headers: { authorization: 'Bearer s3cret' } })).status, 405);
    assert.ok(log.lines.some((l) => /^POST \/search 200 \d+ms$/.test(l)));
    assert.ok(!log.lines.some((l) => l.includes('verify webhook signature')), 'request bodies are never logged');
  });

  test('before the index exists, /health answers 503 with the reason and caches it within the back-off window', async () => {
    let attempts = 0;
    const other = await FixtureRepo.create();
    const real = await indexedClient(other);
    const handler = createHandler({
      client: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('No index named "shop". Has the indexing action run yet?');
        return real;
      },
      config: { store: 'postgres', server: { token: null, host: '127.0.0.1', port: 0, corsOrigin: null, topKMax: 100 } },
      log: memoryLogger(),
    });
    const lazy = createServer(handler);
    await new Promise<void>((r) => lazy.listen(0, '127.0.0.1', r));
    const at = `http://127.0.0.1:${(lazy.address() as AddressInfo).port}`;
    const first = await fetch(`${at}/health`);
    assert.equal(first.status, 503);
    assert.match(((await first.json()) as { error: string }).error, /Has the indexing action run yet/);
    assert.equal((await fetch(`${at}/health`)).status, 503, 'within the back-off window the cached reason is returned');
    assert.equal(attempts, 1);
    lazy.close();
    await other.remove();
  });

  test('refuses to listen beyond loopback without a token', async () => {
    await assert.rejects(serve({ REPO_VECTOR_STORE: 'pinecone', PINECONE_API_KEY: 'x', REPO_VECTOR_SERVER_HOST: '0.0.0.0' }), /without REPO_VECTOR_SERVER_TOKEN/);
  });
});

describe('MCP server', () => {
  let repo: FixtureRepo;
  let mcp: Client;

  before(async () => {
    repo = await FixtureRepo.create();
    const server = createMcpServer(await indexedClient(repo));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    mcp = new Client({ name: 'test', version: '0' });
    await mcp.connect(clientSide);
  });
  after(async () => {
    await mcp.close();
    await repo.remove();
  });

  test('lists the three tools and search_code returns the right file', async () => {
    const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['index_status', 'search_code', 'search_history']);
    const res = (await mcp.callTool({ name: 'search_code', arguments: { query: 'verify webhook signature', topK: 2 } })) as { content: Array<{ text: string }>; isError?: boolean };
    assert.ok(!res.isError);
    assert.match(res.content[0]!.text, /^src\/webhooks\.ts:\d+-\d+ {2}verifyWebhookSignature/);
    const hist = (await mcp.callTool({ name: 'search_history', arguments: { query: 'refunds', since: 'not a date' } })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(hist.isError, true);
    assert.match(hist.content[0]!.text, /ISO date/);
    const status = (await mcp.callTool({ name: 'index_status', arguments: {} })) as { content: Array<{ text: string }> };
    assert.equal(JSON.parse(status.content[0]!.text).namespace, NS);
  });
});

describe('formatHits', () => {
  test('empty and commit forms', () => {
    assert.equal(formatHits({ hits: [], usage: { readUnits: 0 }, tookMs: 0, namespace: 'n' }), 'No results in namespace n.');
    const text = formatHits({
      hits: [{ id: 'abc', score: 0.5, text: 'fix: x\n\nFiles:\na.ts', source: '', fileName: '', chunkIndex: 0, totalChunks: 0, kind: 'commit', metadata: { short_sha: 'abc1234', authored_at: '2026-01-02T00:00:00Z', author: 'Ada', subject: 'fix: x' } }],
      usage: { readUnits: 0 }, tookMs: 0, namespace: 'n',
    });
    assert.match(text, /^abc1234 {2}2026-01-02 {2}Ada {2}fix: x {2}0\.500/);
  });
});
