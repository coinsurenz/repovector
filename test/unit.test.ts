import assert from 'node:assert/strict';
import type { IndexModel } from '@pinecone-database/pinecone';
import { describe, test } from 'node:test';
import { loadConfig, settingsHash, slug } from '../src/config';
import { OpenAICompatibleClient, openRouterClient } from '../src/embed/client';
import { gradeIndex, type EmbeddingMode } from '../src/embed/mode';
import { ConfigError, HttpError } from '../src/errors';
import { parseDotEnv } from '../src/env';
import { chooseMode, diffTooLarge, type CurrentSettings } from '../src/index/plan';
import { isRateLimitError, isRetryableError, withRetry } from '../src/index/retry';
import { TokenRateLimiter, estimateTokens } from '../src/index/throttle';
import { createLogger } from '../src/log';
import { matches, parseFilter } from '../src/store/filter';
import { defaultNamespace, resolveIdentity } from '../src/store/open';
import { toIndexFacts, toIndexRecord } from '../src/store/pinecone';
import type { IndexFacts, Sentinel } from '../src/types';
import { keywordEmbedder } from './helpers';

const base = { REPO_VECTOR_STORE: 'pinecone', PINECONE_API_KEY: 'pc-secret' };

describe('loadConfig', () => {
  test('defaults', () => {
    const cfg = loadConfig(base, '/work');
    assert.equal(cfg.store, 'pinecone');
    assert.equal(cfg.indexing.root, '/work');
    assert.equal(cfg.indexing.maxFileBytes, 512 * 1024);
    assert.deepEqual(cfg.indexing.chunk, { target: 1200, max: 2400 });
    assert.equal(cfg.indexing.history, true);
    assert.equal(cfg.server.host, '127.0.0.1');
    assert.equal(cfg.createIndex, false);
    assert.deepEqual(cfg.secrets, ['pc-secret']);
  });

  test('GITHUB_WORKSPACE is the root in CI, REPO_VECTOR_ROOT wins over it, empty strings are unset', () => {
    assert.equal(loadConfig({ ...base, GITHUB_WORKSPACE: '/gh' }, '/x').indexing.root, '/gh');
    assert.equal(loadConfig({ ...base, GITHUB_WORKSPACE: '/gh', REPO_VECTOR_ROOT: 'sub' }, '/x').indexing.root, '/x/sub');
    assert.equal(loadConfig({ ...base, REPO_VECTOR_INDEX: '  ' }).index, null);
  });

  test('reports every problem at once', () => {
    const err = (() => {
      try {
        loadConfig({ REPO_VECTOR_STORE: 'postgres', REPO_VECTOR_EMBEDDING_PROVIDER: 'openrouter', REPO_VECTOR_CHUNK_TARGET: '3000', REPO_VECTOR_CHUNK_MAX: '2000' });
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /DATABASE_URL is required/);
    assert.match(err.message, /OPENROUTER_API_KEY is required/);
    assert.match(err.message, /CHUNK_MAX must be at least/);
  });

  test('rejects bad values and impossible pairings', () => {
    assert.throws(() => loadConfig({}), /REPO_VECTOR_STORE is required/);
    assert.throws(() => loadConfig({ ...base, REPO_VECTOR_HISTORY: 'maybe' }), /true or false/);
    assert.throws(() => loadConfig({ ...base, REPO_VECTOR_NAMESPACE: 'has space' }), /REPO_VECTOR_NAMESPACE/);
    assert.throws(() => loadConfig({ ...base, REPO_VECTOR_INDEX: 'Bad_Name' }), /lowercase/);
    assert.throws(() => loadConfig({ REPO_VECTOR_STORE: 'postgres', DATABASE_URL: 'postgres://x', REPO_VECTOR_EMBEDDING_PROVIDER: 'pinecone' }), /Postgres cannot embed/);
    assert.throws(() => loadConfig({ ...base, REPO_VECTOR_BATCH_SIZE: '200' }), /BATCH_SIZE/);
  });

  test('booleans, excludes, and the database password is treated as a secret', () => {
    const cfg = loadConfig({ REPO_VECTOR_STORE: 'postgres', DATABASE_URL: 'postgres://u:p%40ss@h/db', REPO_VECTOR_HISTORY: 'false', REPO_VECTOR_EXCLUDE: '**/*.snap, docs/** ,' });
    assert.equal(cfg.indexing.history, false);
    assert.deepEqual(cfg.indexing.exclude, ['**/*.snap', 'docs/**']);
    assert.ok(cfg.secrets.includes('p@ss'));
  });

  test('slug and settings hash', () => {
    assert.equal(slug('Acme/My_Repo!!'), 'acme-my-repo');
    assert.equal(slug('feature/ABC-123 thing'), 'feature-abc-123-thing');
    assert.equal(slug('x'.repeat(60)).length, 40);
    const a = settingsHash({ exclude: ['b', 'a'], maxFileBytes: 1, chunk: { target: 1, max: 2 } });
    assert.equal(a, settingsHash({ exclude: ['a', 'b'], maxFileBytes: 1, chunk: { target: 1, max: 2 } }));
    assert.notEqual(a, settingsHash({ exclude: ['a'], maxFileBytes: 1, chunk: { target: 1, max: 2 } }));
  });
});

describe('identity', () => {
  test('namespace from repo and branch', () => {
    assert.equal(defaultNamespace('Acme/Shop', 'dev'), 'acme-shop--dev');
    assert.equal(defaultNamespace('folder', 'feature/x'), 'folder--feature-x');
  });

  test('GitHub variables, explicit overrides, and a helpful error without a branch', async () => {
    const cfg = loadConfig({ ...base, GITHUB_REPOSITORY: 'Acme/Shop', GITHUB_REF_NAME: 'main' });
    assert.deepEqual(await resolveIdentity(cfg, null), { repo: 'Acme/Shop', branch: 'main', index: 'shop', namespace: 'acme-shop--main', historyNamespace: 'acme-shop--main-history' });
    const fixed = loadConfig({ ...base, REPO_VECTOR_INDEX: 'code', REPO_VECTOR_NAMESPACE: 'ns1' });
    assert.equal((await resolveIdentity(fixed, null)).namespace, 'ns1');
    assert.equal((await resolveIdentity(cfg, null, 'dev')).namespace, 'acme-shop--dev');
    await assert.rejects(resolveIdentity(loadConfig({ ...base, REPO_VECTOR_REPO: 'a/b' }), null), /REPO_VECTOR_BRANCH/);
  });
});

describe('chooseMode', () => {
  const current: CurrentSettings = { head: 'b'.repeat(40), chunkerVersion: 'ts-4', settings: 's1', provider: 'pinecone', model: 'llama-text-embed-v2', dimension: 1024, dimensions: null };
  const sentinel: Sentinel = {
    kind: 'code', sha: 'a'.repeat(40), branch: 'main', repo: 'a/b', chunkerVersion: 'ts-4', toolVersion: '0', settings: 's1', provider: 'pinecone',
    model: 'llama-text-embed-v2', dimension: 1024, dimensions: null, indexedAt: '', files: 1, lastRun: { mode: 'full', filesIndexed: 1, filesRemoved: 0, recordsUpserted: 1, recordsDeleted: 0 },
  };
  const decide = (s: Partial<Sentinel> | null, o: { forceFull?: boolean; ancestor?: boolean } = {}) =>
    chooseMode({ sentinel: s === null ? null : { ...sentinel, ...s }, current, forceFull: o.forceFull ?? false, sentinelIsAncestor: o.ancestor ?? true });

  test('every branch', () => {
    assert.equal(decide(null).mode, 'full');
    assert.equal(decide({}, { forceFull: true }).mode, 'full');
    assert.match(decide({ chunkerVersion: 'ts-3' }).reason, /chunker changed/);
    assert.match(decide({ settings: 'other' }).reason, /settings changed/);
    assert.match(decide({ model: 'multilingual-e5-large' }).reason, /embedding model changed/);
    assert.match(decide({ dimension: 768 }).reason, /dimension changed/);
    assert.equal(decide({ sha: current.head }).mode, 'skipped');
    assert.match(decide({}, { ancestor: false }).reason, /not in this branch's history/);
    assert.equal(decide({}).mode, 'incremental');
  });

  test('diff threshold', () => {
    assert.equal(diffTooLarge(41, 100, 0.4), true);
    assert.equal(diffTooLarge(40, 100, 0.4), false);
    assert.equal(diffTooLarge(5, 0, 0.4), false);
  });
});

describe('gradeIndex', () => {
  const hosted: IndexFacts = { name: 'h', state: 'Ready', ready: true, embedModel: 'llama-text-embed-v2', textField: 'text', dimension: 1024 };
  const raw1024: IndexFacts = { name: 'r1', state: 'Ready', ready: true, embedModel: null, textField: null, dimension: 1024 };
  const raw1536: IndexFacts = { ...raw1024, name: 'r2', dimension: 1536 };
  const openai: EmbeddingMode = { provider: 'openai', model: 'text-embedding-3-small', dimension: 1536, client: keywordEmbedder };

  test('hosted needs a hosted model, a text field and the same model', () => {
    assert.deepEqual(gradeIndex(hosted, { provider: 'pinecone', model: 'llama-text-embed-v2' }), { usable: true });
    assert.match(gradeIndex(raw1024, { provider: 'pinecone', model: 'llama-text-embed-v2' }).reason!, /Stores raw vectors/);
    assert.match(gradeIndex({ ...hosted, textField: null }, { provider: 'pinecone', model: 'llama-text-embed-v2' }).reason!, /record field/);
    assert.equal(gradeIndex(hosted, { provider: 'pinecone', model: 'multilingual-e5-large' }).reason, 'Embeds with llama-text-embed-v2, not multilingual-e5-large');
  });

  test('external needs a vectors-only index of the same dimension', () => {
    assert.deepEqual(gradeIndex(raw1536, openai), { usable: true });
    assert.equal(gradeIndex(raw1024, openai).reason, 'Dimension 1024 does not match text-embedding-3-small (1536)');
    assert.match(gradeIndex(hosted, openai).reason!, /own hosted model/);
    assert.equal(gradeIndex({ ...raw1536, dimension: undefined }, openai).reason, 'Dimension unknown');
  });
});

describe('pacing and retry', () => {
  test('limiter waits for the trailing minute and allows one oversized request', async () => {
    let t = 0;
    const waits: number[] = [];
    const limiter = new TokenRateLimiter(250_000, () => t, async (ms) => { waits.push(ms); t += ms; });
    assert.equal(await limiter.take(100_000), 0);
    t += 10_000;
    assert.equal(await limiter.take(100_000), 0);
    t += 10_000;
    const waited = await limiter.take(100_000);
    assert.ok(waited > 39_000 && waited < 41_000);
    assert.equal(waits.length, 1);
    assert.equal(await new TokenRateLimiter(250_000).take(900_000), 0);
    assert.equal(await new TokenRateLimiter(null).take(1e9), 0);
    assert.equal(estimateTokens('x'.repeat(350)), 100);
  });

  test('rate limits back off on a minute scale; bad input and bugs are never retried', async () => {
    let calls = 0;
    const waits: number[] = [];
    const out = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw new HttpError(429, 'slow down');
      return 'ok';
    }, { attempts: 5, baseDelayMs: 1, rateLimitDelayMs: 2 }, (w) => waits.push(w.delayMs));
    assert.equal(out, 'ok');
    assert.deepEqual(waits, [2, 4]);
    assert.equal(isRateLimitError(new HttpError(429, 'x')), true);
    assert.equal(isRetryableError(new HttpError(400, 'x')), false);
    assert.equal(isRetryableError(new HttpError(503, 'x')), true);
    assert.equal(isRetryableError(new TypeError('bug')), false);
    assert.equal(isRetryableError(new ConfigError('bad')), false);
    assert.equal(isRetryableError(Object.assign(new Error('relation missing'), { code: '42P01' })), false);
    assert.equal(isRetryableError(Object.assign(new Error('connection reset'), { code: '08006' })), true);
    assert.equal(isRetryableError(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })), true);
    calls = 0;
    await assert.rejects(withRetry(async () => { calls += 1; throw new HttpError(400, 'bad'); }, { attempts: 3, baseDelayMs: 1 }), /bad/);
    assert.equal(calls, 1);
  });
});

describe('filters', () => {
  test('parse and match the supported subset; refuse the rest', () => {
    const c = parseFilter({ $and: [{ kind: { $eq: 'commit' } }, { authored_ts: { $gte: 10, $lte: 20 } }], author: 'Ada' });
    assert.equal(c.length, 4);
    assert.equal(matches({ kind: 'commit', authored_ts: 15, author: 'Ada' }, c), true);
    assert.equal(matches({ kind: 'commit', authored_ts: 25, author: 'Ada' }, c), false);
    assert.equal(matches({ kind: 'commit', authored_ts: '15', author: 'Ada' }, c), false);
    assert.throws(() => parseFilter({ $or: [] }), /Unsupported filter operator/);
    assert.throws(() => parseFilter({ a: { $in: [1] } }), /Unsupported operator/);
    assert.throws(() => parseFilter({ a: { $gte: 'x' } }), /needs a number/);
    assert.throws(() => parseFilter({ a: [1] }), /string, number or boolean/);
    assert.deepEqual(parseFilter(undefined), []);
  });
});

describe('embedding client', () => {
  const fakeFetch = (status: number, body: unknown, seen?: Array<{ url: string; body: Record<string, unknown> }>) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen?.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

  test('embeds in input order, probes the dimension, and sends OpenRouter data-collection preferences', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = openRouterClient('k', 'deny', fakeFetch(200, { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { total_tokens: 7 } }, seen));
    assert.deepEqual(await client.embed('m', ['a', 'b']), { vectors: [[1, 0], [0, 1]], tokens: 7 });
    assert.equal(seen[0]!.url, 'https://openrouter.ai/api/v1/embeddings');
    assert.deepEqual(seen[0]!.body.provider, { data_collection: 'deny' });
    assert.deepEqual(await client.embed('m', []), { vectors: [], tokens: 0 });
  });

  test('maps provider errors to clear messages and statuses', async () => {
    const mk = (status: number) => new OpenAICompatibleClient({ name: 'OpenAI', baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl: fakeFetch(status, { error: { message: 'nope' } }) });
    await assert.rejects(mk(401).embed('m', ['a']), (e: HttpError) => e.status === 401 && /rejected the API key: nope/.test(e.message));
    await assert.rejects(mk(404).embed('m', ['a']), /does not know the model "m"/);
    await assert.rejects(mk(429).embed('m', ['a']), (e: HttpError) => e.status === 429);
    await assert.rejects(mk(500).embed('m', ['a']), (e: HttpError) => e.status === 502);
    const short = new OpenAICompatibleClient({ name: 'OpenAI', baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl: fakeFetch(200, { data: [] }) });
    await assert.rejects(short.embed('m', ['a']), /returned 0 embeddings for 1 inputs/);
  });
});

describe('pinecone helpers', () => {
  const model = (o: Record<string, unknown>) => ({ name: 'x', host: 'h', status: { state: 'Ready', ready: true }, schema: { fields: {} }, ...o }) as unknown as IndexModel;

  test('reads the embedded text field from the field map or the schema', () => {
    assert.equal(toIndexFacts(model({ embed: { model: 'llama-text-embed-v2', fieldMap: { text: 'text' } }, dimension: 1024 })).textField, 'text');
    const s = toIndexFacts(model({ embed: { model: 'multilingual-e5-large' }, schema: { fields: { chunk_text: { type: 'semantic_text' }, _values: { type: 'dense_vector', dimension: 1024 } } } }));
    assert.equal(s.textField, 'chunk_text');
    assert.equal(s.dimension, 1024);
    assert.equal(toIndexFacts(model({ schema: { fields: { _values: { type: 'dense_vector', dimension: 1536 } } } })).embedModel, null);
  });

  test('renames chunk_text to the index field', () => {
    const r = { _id: 'd:0', chunk_text: 'hello', source: 'a' };
    assert.deepEqual(toIndexRecord(r, 'text'), { _id: 'd:0', text: 'hello', source: 'a' });
    assert.equal(toIndexRecord(r, 'chunk_text'), r);
  });
});

describe('log and env', () => {
  test('workflow commands under Actions, plain lines elsewhere', () => {
    const lines: string[] = [];
    const gh = createLogger({ GITHUB_ACTIONS: 'true' }, (l) => lines.push(l));
    gh.error('bad\nthing 100%');
    gh.mask('s3cret');
    gh.mask('');
    const plain = createLogger({}, (l) => lines.push(l));
    plain.warn('careful');
    plain.mask('s3cret');
    assert.deepEqual(lines, ['::error::bad%0Athing 100%25', '::add-mask::s3cret', 'warning: careful']);
  });

  test('parses .env files', () => {
    assert.deepEqual(parseDotEnv('# c\nA=1\nexport B="two"\nC=\'3\'\nbad\n=x\n'), { A: '1', B: 'two', C: '3' });
  });
});
