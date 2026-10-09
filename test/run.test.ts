import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { memoryLogger } from '../src/log';
import { fileId } from '../src/index/records';
import { runIndex, type RunOptions } from '../src/index/run';
import { MemoryStore } from '../src/store/memory';
import { FixtureRepo, NO_RETRY, indexingConfig, tsFunctions } from './helpers';

const NS = 'acme-shop--main';
const HNS = `${NS}-history`;
const embedding = { provider: 'memory' as const, model: 'memory', dimension: null, dimensions: null };

/** Expected ids for a file with n chunks. */
const ids = (rel: string, n: number) => Array.from({ length: n }, (_, i) => `${fileId(rel)}:${i}`);

describe('runIndex against a fixture repository', () => {
  let repo: FixtureRepo;
  const store = new MemoryStore();
  const log = memoryLogger();
  const run = (overrides: Partial<RunOptions> = {}) =>
    runIndex({ root: repo.root, repo: 'acme/shop', branch: 'main', namespace: NS, historyNamespace: HNS, store, embedding, indexing: indexingConfig(), log, retry: NO_RETRY, ...overrides });

  before(async () => {
    repo = await FixtureRepo.create();
  });
  after(async () => {
    await repo.remove();
  });

  test('1. first run indexes every eligible file in full and skips secrets, lockfiles and binaries', async () => {
    await repo.write('src/a.ts', tsFunctions(['alpha', 'beta', 'gamma']));
    await repo.write('src/b.ts', tsFunctions(['one', 'two', 'three', 'four']));
    await repo.write('src/c.py', 'def refund(order):\n    """Issue a refund."""\n    return order.total\n');
    await repo.write('docs/guide.md', '# Guide\n\nHow refunds work.\n');
    await repo.write('.env', 'SECRET=1\n');
    await repo.write('package-lock.json', '{}\n');
    await repo.write('logo.bin', 'abc\0def');
    await repo.write('empty.txt', '');
    const sha = repo.commit('feat: initial shop\n\nAdds refunds and helpers.');

    const result = await run();
    assert.equal(result.code.mode, 'full');
    assert.equal(result.sha, sha);
    assert.deepEqual(store.ids(NS), [...ids('src/a.ts', 3), ...ids('src/b.ts', 4), ...ids('src/c.py', 1), ...ids('docs/guide.md', 1)].sort());
    const sentinel = await store.readSentinel(NS);
    assert.equal(sentinel?.sha, sha);
    assert.equal(sentinel?.files, 5, 'a, b, c, guide and empty.txt pass the filters; .bin is not a text extension');
    const rec = store.record(NS, `${fileId('src/a.ts')}:0`)!;
    assert.equal(rec.source, 'src/a.ts');
    assert.equal(rec.symbol, 'alpha');
    assert.equal(rec.repo, 'acme/shop');
    assert.equal(rec.branch, 'main');
    assert.equal(rec.commit, sha);
    assert.equal(rec.kind, 'code');
    assert.equal(result.history?.mode, 'full');
    assert.equal(result.history?.commitsIndexed, 1);
  });

  test('2. modify one file and shrink another: only those are re-written, the shrunken tail is deleted', async () => {
    await repo.write('src/a.ts', tsFunctions(['alpha', 'beta', 'gamma', 'delta']));
    await repo.write('src/b.ts', tsFunctions(['one', 'two']));
    repo.commit('refactor: grow a, shrink b');
    const writesBefore = store.writes.length;

    const result = await run();
    assert.equal(result.code.mode, 'incremental');
    assert.equal(result.code.filesIndexed, 2);
    assert.equal(result.code.recordsUpserted, 6);
    assert.equal(result.code.recordsDeleted, 2, 'b.ts went from 4 chunks to 2');
    assert.deepEqual(store.ids(NS), [...ids('src/a.ts', 4), ...ids('src/b.ts', 2), ...ids('src/c.py', 1), ...ids('docs/guide.md', 1)].sort());
    const written = store.writes.slice(writesBefore).filter((w) => w.namespace === NS).flatMap((w) => w.ids);
    assert.ok(written.every((id) => id.startsWith(fileId('src/a.ts')) || id.startsWith(fileId('src/b.ts'))), 'unchanged files were not re-sent');
  });

  test('3. rename: the old path is deleted, the new path indexed', async () => {
    repo.git('mv', 'src/c.py', 'src/refunds.py');
    repo.commit('chore: rename c.py');
    const result = await run();
    assert.equal(result.code.mode, 'incremental');
    assert.equal(result.code.filesIndexed, 1);
    assert.equal(result.code.filesRemoved, 1);
    assert.deepEqual(store.ids(NS), [...ids('src/a.ts', 4), ...ids('src/b.ts', 2), ...ids('src/refunds.py', 1), ...ids('docs/guide.md', 1)].sort());
    assert.equal(store.record(NS, `${fileId('src/refunds.py')}:0`)?.source, 'src/refunds.py');
  });

  test('4. delete: its records go', async () => {
    repo.git('rm', '-q', 'docs/guide.md');
    repo.commit('docs: drop the guide');
    const result = await run();
    assert.equal(result.code.filesRemoved, 1);
    assert.deepEqual(store.ids(NS), [...ids('src/a.ts', 4), ...ids('src/b.ts', 2), ...ids('src/refunds.py', 1)].sort());
  });

  test('5. no change: skipped, nothing written', async () => {
    const writesBefore = store.writes.length;
    const result = await run();
    assert.equal(result.code.mode, 'skipped');
    assert.equal(result.history?.mode, 'skipped');
    assert.equal(store.writes.length, writesBefore);
  });

  test('a file that grows past the size cap loses its records on an incremental run', async () => {
    await repo.write('src/b.ts', `${tsFunctions(['one', 'two'])}\n// ${'x'.repeat(600 * 1024)}\n`);
    repo.commit('chore: vendor a huge blob into b');
    const result = await run();
    assert.equal(result.code.mode, 'incremental');
    assert.equal(result.code.filesIndexed, 0);
    assert.equal(result.code.filesRemoved, 1);
    assert.deepEqual(store.ids(NS), [...ids('src/a.ts', 4), ...ids('src/refunds.py', 1)].sort());
  });

  test('changing the excludes forces a full run that sweeps the excluded records', async () => {
    const result = await run({ indexing: indexingConfig({ exclude: ['**/*.py'] }) });
    assert.equal(result.code.mode, 'full');
    assert.match(result.code.reason, /settings changed/);
    assert.ok(!store.ids(NS).some((id) => id.startsWith(fileId('src/refunds.py'))));
    assert.ok(result.code.recordsDeleted >= 1);
  });

  test('rewritten history (amend + force) triggers full code and history runs', async () => {
    await repo.write('src/a.ts', tsFunctions(['alpha', 'beta']));
    repo.commit('feat: shrink a');
    await run({ indexing: indexingConfig({ exclude: ['**/*.py'] }) });
    const before = (await store.readSentinel(HNS))!.sha;
    repo.git('commit', '-q', '--amend', '-m', 'feat: shrink a (reworded)');
    const result = await run({ indexing: indexingConfig({ exclude: ['**/*.py'] }) });
    assert.notEqual((await store.readSentinel(HNS))!.sha, before);
    assert.equal(result.code.mode, 'full');
    assert.match(result.code.reason, /not in this branch's history/);
    assert.equal(result.history?.mode, 'full');
    assert.ok(!store.ids(HNS).includes(before), 'the orphaned commit was swept from the history namespace');
    assert.ok(store.ids(HNS).includes(result.sha));
  });

  test('full reindex flag and dry run write nothing in dry-run mode', async () => {
    const writesBefore = store.writes.length;
    const result = await run({ dryRun: true, indexing: indexingConfig({ fullReindex: true, exclude: ['**/*.py'] }) });
    assert.equal(result.code.mode, 'full');
    assert.ok(result.code.recordsUpserted > 0);
    assert.ok(result.code.estimatedTokens > 0);
    assert.equal(store.writes.length, writesBefore);
  });
});
