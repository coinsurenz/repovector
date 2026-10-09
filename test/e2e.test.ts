import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import postgres from 'postgres';
import { tableNameFor } from '../src/store/sql';
import { FixtureRepo, tsFunctions } from './helpers';

const root = path.resolve(import.meta.dirname, '..');
const actionJs = path.join(root, 'dist/action.js');
const cliJs = path.join(root, 'dist/cli.js');
const url = process.env.TEST_DATABASE_URL;
const DIM = 64;
const KEY = 'sk-test-e2e-secret-value';

/** Hashed bag of words: texts sharing words point the same way, so search order is meaningful without a model. */
function embedText(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  const words = text.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  for (const w of words) {
    const slot = createHash('md5').update(w).digest()[0]! % DIM;
    v[slot] = (v[slot] ?? 0) + 1;
  }
  if (!v.some((x) => x !== 0)) v[0] = 1;
  return v;
}

/** Minimal OpenAI-compatible /embeddings endpoint that checks the bearer key. */
function fakeEmbeddings(): Promise<{ server: Server; baseUrl: string; calls: () => number }> {
  let calls = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
        return;
      }
      calls += 1;
      const input = (JSON.parse(body) as { input: string[] }).input;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: embedText(t) })), usage: { total_tokens: input.length } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls: () => calls })));
}

function run(script: string, args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), ...env }, cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

const skip = !url ? 'TEST_DATABASE_URL not set' : !existsSync(actionJs) ? 'dist/ not built; run npm run build' : false;

describe('bundled action and CLI end to end (Postgres + fake OpenAI-compatible embeddings)', { skip }, () => {
  let repo: FixtureRepo;
  let fake: Awaited<ReturnType<typeof fakeEmbeddings>>;
  let work: string;
  const index = `rv-e2e-${Date.now().toString(36)}`;
  const sql = postgres(url ?? 'postgres://unused', { max: 1, onnotice: () => {} });
  let env: Record<string, string>;

  before(async () => {
    repo = await FixtureRepo.create();
    fake = await fakeEmbeddings();
    work = await mkdtemp(path.join(os.tmpdir(), 'repo-vector-gh-'));
    env = {
      GITHUB_ACTIONS: 'true',
      GITHUB_WORKSPACE: repo.root,
      GITHUB_REPOSITORY: 'acme/shop',
      GITHUB_REF_NAME: 'main',
      GITHUB_OUTPUT: path.join(work, 'output'),
      GITHUB_STEP_SUMMARY: path.join(work, 'summary'),
      REPO_VECTOR_STORE: 'postgres',
      DATABASE_URL: url!,
      REPO_VECTOR_INDEX: index,
      REPO_VECTOR_EMBEDDING_PROVIDER: 'openai',
      REPO_VECTOR_EMBEDDING_MODEL: 'fake-bag-of-words',
      OPENAI_API_KEY: KEY,
      OPENAI_BASE_URL: fake.baseUrl,
    };
  });
  after(async () => {
    await sql.unsafe(`DROP TABLE IF EXISTS "${tableNameFor(index)}"`);
    await sql`DELETE FROM vector_indexes WHERE name = ${index}`;
    await sql`DELETE FROM repo_vector_sentinels WHERE table_name = ${tableNameFor(index)}`;
    await sql.end();
    fake.server.close();
    await repo.remove();
    await rm(work, { recursive: true, force: true });
  });

  const outputs = async () => Object.fromEntries((await readFile(env.GITHUB_OUTPUT!, 'utf8')).trim().split('\n').map((l) => l.split('=') as [string, string]));

  test('first push: full run, outputs and summary written, exit 0, key masked', async () => {
    await repo.write('src/webhooks.ts', tsFunctions(['verifyWebhookSignature', 'dispatchWebhook', 'retryWebhookDelivery']));
    await repo.write('src/refunds.ts', tsFunctions(['issueRefund', 'cancelRefund']));
    await repo.write('README.md', '# Shop\n\nTakes payments and issues refunds.\n');
    const sha = repo.commit('feat: shop with webhooks and refunds');
    const r = await run(actionJs, [], env, repo.root);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stderr.split('\n')[0]!.startsWith('::add-mask::'), 'masking happens before any other output');
    assert.ok(!r.stderr.replace(/::add-mask::.*\n/g, '').includes(KEY), 'the key is never printed outside the mask command');
    const out = await outputs();
    assert.equal(out.mode, 'full');
    assert.equal(out.sha, sha);
    assert.equal(out.files_indexed, '3');
    assert.equal(out.namespace, 'acme-shop--main');
    assert.equal(out.commits_indexed, '1');
    const summary = await readFile(env.GITHUB_STEP_SUMMARY!, 'utf8');
    assert.match(summary, /\| Code mode \| full \(first run for this namespace\) \|/);
  });

  test('second push touching one file: incremental, one file indexed', async () => {
    await writeFile(env.GITHUB_OUTPUT!, '');
    await repo.write('src/refunds.ts', tsFunctions(['issueRefund', 'cancelRefund', 'refundStatus']));
    repo.commit('feat: refund status');
    const before = fake.calls();
    const r = await run(actionJs, [], env, repo.root);
    assert.equal(r.code, 0, r.stderr);
    const out = await outputs();
    assert.equal(out.mode, 'incremental');
    assert.equal(out.files_indexed, '1');
    assert.equal(out.commits_indexed, '1');
    assert.ok(fake.calls() - before <= 4, 'only the changed file and the new commit were embedded (plus one dimension probe)');
  });

  test('the bundled CLI searches what the action wrote, taking the model from the sentinel', async () => {
    const queryEnv = { REPO_VECTOR_STORE: 'postgres', DATABASE_URL: url!, REPO_VECTOR_INDEX: index, REPO_VECTOR_REPO: 'acme/shop', REPO_VECTOR_BRANCH: 'main', OPENAI_API_KEY: KEY, OPENAI_BASE_URL: fake.baseUrl };
    const r = await run(cliJs, ['search', 'verify webhook signature', '--top', '3', '--json'], queryEnv, work);
    assert.equal(r.code, 0, r.stderr);
    const res = JSON.parse(r.stdout) as { hits: Array<{ source: string; symbol?: string }> };
    assert.equal(res.hits[0]!.source, 'src/webhooks.ts');
    assert.equal(res.hits[0]!.symbol, 'verifyWebhookSignature');
    const status = await run(cliJs, ['status'], queryEnv, work);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /Code {4}acme-shop--main: [0-9a-f]{12} indexed .* \(3 files; last run incremental\)/);
    const history = await run(cliJs, ['history', 'refund status', '--top', '1'], queryEnv, work);
    assert.match(history.stdout, /feat: refund status/);
  });

  test('a wrong key fails with exit 1, one ::error:: line, and the key never printed', async () => {
    await repo.write('src/refunds.ts', tsFunctions(['issueRefund']));
    repo.commit('refactor: fewer refund helpers');
    const bad = 'sk-wrong-key-should-not-leak';
    const r = await run(actionJs, [], { ...env, OPENAI_API_KEY: bad }, repo.root);
    assert.equal(r.code, 1);
    const errors = r.stderr.split('\n').filter((l) => l.startsWith('::error::'));
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /OpenAI rejected the API key/);
    assert.ok(!r.stderr.replace(/::add-mask::.*\n/g, '').includes(bad));
    assert.ok(!r.stdout.includes(bad));
  });

  test('a non-checkout fails clearly', async () => {
    const r = await run(actionJs, [], { ...env, GITHUB_WORKSPACE: work }, work);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /::error::.*is not a git checkout\. In a workflow, run actions\/checkout/);
  });
});
