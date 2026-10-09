import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import postgres from 'postgres';
import { RepoVectorClient } from '../src/client';
import { loadConfig } from '../src/config';
import type { EmbeddingMode } from '../src/embed/mode';
import { fileId } from '../src/index/records';
import { runIndex, type RunOptions } from '../src/index/run';
import { memoryLogger } from '../src/log';
import { PostgresStore } from '../src/store/postgres';
import { safeKey, tableNameFor, vectorLiteral } from '../src/store/sql';
import { FixtureRepo, NO_RETRY, indexingConfig, keywordEmbedder, tsFunctions } from './helpers';

describe('sql helpers', () => {
  test('table names are safe identifiers', () => {
    assert.equal(tableNameFor('My Repo-Code!'), 'vec_my_repo_code');
    assert.throws(() => tableNameFor('---'));
  });
  test('vector literal and metadata keys', () => {
    assert.equal(vectorLiteral([0.5, -1, Number.NaN]), '[0.5,-1,0]');
    assert.equal(safeKey('authored_ts'), 'authored_ts');
    assert.throws(() => safeKey("x'); drop table y; --"), /not a valid metadata name/);
  });
});

const url = process.env.TEST_DATABASE_URL;
const mode: EmbeddingMode = { provider: 'openai', model: 'fake-4d', dimension: 4, client: keywordEmbedder };

describe('PostgresStore and the indexer (live, TEST_DATABASE_URL)', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  const sql = postgres(url ?? 'postgres://unused', { max: 2, onnotice: () => {} });
  const store = new PostgresStore(sql, mode);
  const name = `rv-test-${Date.now().toString(36)}`;
  const ns = 'acme-shop--main';
  let repo: FixtureRepo;
  const log = memoryLogger();
  const run = (o: Partial<RunOptions> = {}) =>
    runIndex({ root: repo.root, repo: 'acme/shop', branch: 'main', namespace: ns, historyNamespace: `${ns}-history`, store, embedding: { provider: 'openai', model: 'fake-4d', dimension: 4, dimensions: null }, indexing: indexingConfig(), log, retry: NO_RETRY, ...o });
  const idsIn = async (namespace: string) => (await sql<Array<{ id: string }>>`SELECT id FROM ${sql(tableNameFor(name))} WHERE namespace = ${namespace} ORDER BY id`).map((r) => r.id);
  const ids = (rel: string, n: number) => Array.from({ length: n }, (_, i) => `${fileId(rel)}:${i}`);

  before(async () => {
    await store.migrate();
    await store.migrate(); // idempotent
    repo = await FixtureRepo.create();
  });
  after(async () => {
    await sql.unsafe(`DROP TABLE IF EXISTS "${tableNameFor(name)}"`);
    await sql`DELETE FROM vector_indexes WHERE name = ${name}`;
    await sql`DELETE FROM repo_vector_sentinels WHERE table_name = ${tableNameFor(name)}`;
    await store.close();
    await repo.remove();
  });

  test('create, describe and use an index', async () => {
    assert.equal(await store.describe(name), null);
    const facts = await store.create(name);
    assert.deepEqual({ ...facts }, { name, state: 'Ready', ready: true, embedModel: null, textField: null, dimension: 4, metric: 'cosine', vectorModel: 'fake-4d' });
    await assert.rejects(store.create(name));
    store.use(facts);
  });

  test('the fixture flow: add, modify and shrink, rename, delete, no-op', async () => {
    await repo.write('src/refunds.ts', tsFunctions(['issueRefund', 'refundStatus', 'refundQueue']));
    await repo.write('src/webhooks.ts', tsFunctions(['verifySignature', 'dispatchWebhook']));
    await repo.write('src/terminal.ts', tsFunctions(['openTerminal']));
    repo.commit('feat: shop');
    assert.equal((await run()).code.mode, 'full');
    assert.deepEqual(await idsIn(ns), [...ids('src/refunds.ts', 3), ...ids('src/webhooks.ts', 2), ...ids('src/terminal.ts', 1)].sort());

    await repo.write('src/refunds.ts', tsFunctions(['issueRefund']));
    await repo.write('src/webhooks.ts', tsFunctions(['verifySignature', 'dispatchWebhook', 'retryWebhook']));
    repo.commit('refactor: shrink refunds, grow webhooks');
    const second = await run();
    assert.equal(second.code.mode, 'incremental');
    assert.equal(second.code.recordsDeleted, 2);
    assert.deepEqual(await idsIn(ns), [...ids('src/refunds.ts', 1), ...ids('src/webhooks.ts', 3), ...ids('src/terminal.ts', 1)].sort());

    repo.git('mv', 'src/terminal.ts', 'src/pos.ts');
    repo.commit('chore: rename terminal');
    await run();
    repo.git('rm', '-q', 'src/refunds.ts');
    repo.commit('chore: drop refunds');
    const fourth = await run();
    assert.equal(fourth.code.filesRemoved, 1);
    assert.deepEqual(await idsIn(ns), [...ids('src/webhooks.ts', 3), ...ids('src/pos.ts', 1)].sort());
    assert.equal((await run()).code.mode, 'skipped');

    const sentinel = await store.readSentinel(ns);
    assert.equal(sentinel?.sha, repo.git('rev-parse', 'HEAD').trim());
    assert.equal(sentinel?.model, 'fake-4d');
    assert.equal((await store.readSentinel(`${ns}-history`))?.files, 4, 'four commits');
  });

  test('client search: kind filter, language filter, path prefix, history date range', async () => {
    const cfg = loadConfig({ REPO_VECTOR_STORE: 'postgres', DATABASE_URL: 'postgres://x', REPO_VECTOR_INDEX: name, REPO_VECTOR_NAMESPACE: ns });
    const client = new RepoVectorClient(cfg, { repo: 'acme/shop', branch: 'main', index: name, namespace: ns, historyNamespace: `${ns}-history` }, {
      backend: store, index: (await store.describe(name))!, mode, sentinel: null, embedding: { provider: 'openai', model: 'fake-4d', dimension: 4, dimensions: null },
    });
    const hits = (await client.search({ query: 'where is the webhook signature checked', topK: 3 })).hits;
    assert.equal(hits[0]!.source, 'src/webhooks.ts');
    assert.ok(hits.every((h) => h.kind === 'code'));
    assert.equal((await client.search({ query: 'webhook', language: 'python' })).hits.length, 0);
    assert.ok((await client.search({ query: 'webhook', pathPrefix: 'src/pos' })).hits.every((h) => h.source === 'src/pos.ts'));

    const all = await client.searchHistory({ query: 'refunds', topK: 10 });
    assert.equal(all.hits.length, 4);
    assert.ok(all.hits.every((h) => h.kind === 'commit'));
    // Fixture commits are dated 2026-01-02 to 2026-01-05, one day apart.
    const late = await client.searchHistory({ query: 'refunds', topK: 10, since: '2026-01-04' });
    assert.deepEqual(late.hits.map((h) => h.metadata.authored_at).sort(), ['2026-01-04T00:00:00+00:00', '2026-01-05T00:00:00+00:00']);
    const early = await client.searchHistory({ query: 'refunds', topK: 10, until: '2026-01-02' });
    assert.deepEqual(early.hits.map((h) => h.metadata.subject), ['feat: shop']);
    assert.equal((await client.searchHistory({ query: 'x', author: 'Nobody' })).hits.length, 0);
    await assert.rejects(client.search({ query: 'x', filter: { a: { $ne: 1 } } }), /Unsupported operator/);
    await assert.rejects(client.search({ query: 'x', rerank: true }), /only available on the Pinecone/);

    const status = await client.status();
    assert.equal(status.code?.kind, 'code');
    assert.ok(status.stats.namespaces.some((n) => n.name === ns));
  });
});
