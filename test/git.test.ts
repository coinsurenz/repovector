import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_EXCLUDES, fileSelector, isAncestor, parseNameStatus, parseRemote, trackedFiles } from '../src/git/files';
import { listCommits, parseLog } from '../src/git/history';
import { commitText } from '../src/index/records';
import { FixtureRepo } from './helpers';

describe('parseNameStatus', () => {
  test('reads adds, modifies, deletes, renames and copies from -z output', () => {
    const out = ['A', 'new.ts', 'M', 'mod.ts', 'D', 'gone.ts', 'R087', 'old/x.ts', 'new/x.ts', 'C100', 'a.ts', 'b.ts', 'T', 'link', ''].join('\0');
    assert.deepEqual(parseNameStatus(out), {
      changed: ['b.ts', 'link', 'mod.ts', 'new.ts', 'new/x.ts'],
      removed: ['gone.ts', 'old/x.ts'],
      entries: 6,
    });
  });

  test('a path both removed and re-added counts as changed only', () => {
    assert.deepEqual(parseNameStatus(['R100', 'a.ts', 'b.ts', 'A', 'a.ts', ''].join('\0')).removed, []);
  });
});

describe('parseRemote', () => {
  test('https and ssh forms', () => {
    assert.equal(parseRemote('https://github.com/acme/shop.git'), 'acme/shop');
    assert.equal(parseRemote('git@github.com:acme/shop.git'), 'acme/shop');
    assert.equal(parseRemote('https://github.com/acme/shop'), 'acme/shop');
    assert.equal(parseRemote('nonsense'), null);
  });
});

describe('fileSelector on the sample repo', () => {
  const root = path.resolve(import.meta.dirname, 'fixtures/sample-repo');
  const select = fileSelector({ root, exclude: [], maxFileBytes: 1_000_000 });

  test('keeps source and docs, drops node_modules, lockfiles, secrets and binaries', async () => {
    for (const keep of ['src/services/webhooks.ts', 'src/services/refunds.py', 'README.md', 'scripts/Makefile']) assert.deepEqual(await select(keep), { ok: true }, keep);
    assert.deepEqual(await select('node_modules/dep/index.js'), { ok: false, reason: 'excluded' });
    assert.deepEqual(await select('package-lock.json'), { ok: false, reason: 'excluded' });
    assert.deepEqual(await select('.env.local'), { ok: false, reason: 'sensitive' });
    assert.deepEqual(await select('config/.aws/credentials'), { ok: false, reason: 'sensitive' });
    assert.deepEqual(await select('logo.png'), { ok: false, reason: 'unsupported' });
    assert.deepEqual(await select('src/missing.ts'), { ok: false, reason: 'missing' });
    assert.deepEqual(await select('src'), { ok: false, reason: 'not-a-file' });
  });

  test('extra excludes and the size cap', async () => {
    const strict = fileSelector({ root, exclude: ['**/*.py'], maxFileBytes: 50 });
    assert.deepEqual(await strict('src/services/refunds.py'), { ok: false, reason: 'excluded' });
    assert.deepEqual(await strict('src/services/webhooks.ts'), { ok: false, reason: 'too-large' });
  });

  test('default excludes match at the root and nested', async () => {
    assert.ok(DEFAULT_EXCLUDES.includes('**/dist/**'));
    const s = fileSelector({ root, exclude: [], maxFileBytes: 1_000_000 });
    assert.equal((await s('dist/x.js')).ok, false);
    assert.equal((await s('apps/web/dist/x.js')).ok, false);
    assert.equal((await s('lib/foo.min.js')).ok, false);
  });
});

describe('git history', () => {
  let repo: FixtureRepo;
  before(async () => {
    repo = await FixtureRepo.create();
    await repo.write('a.ts', 'export const a = 1;\n');
    repo.commit('feat: add a\n\nFirst line of body.\nSecond line of body.');
    repo.git('checkout', '-q', '-b', 'side');
    await repo.write('b.ts', 'export const b = 2;\n');
    repo.commit('feat: add b on a side branch');
    repo.git('checkout', '-q', 'main');
    await repo.write('c.ts', 'export const c = 3;\n');
    repo.commit('feat: add c');
    repo.git('merge', '-q', '--no-ff', '-m', 'Merge branch side', 'side');
  });
  after(async () => {
    await repo.remove();
  });

  test('lists commits newest first with paths, bodies, authors and merges', async () => {
    const commits = await listCommits(repo.root, 'HEAD');
    assert.equal(commits.length, 4);
    const [merge, c, b, a] = commits as [typeof commits[0], typeof commits[0], typeof commits[0], typeof commits[0]];
    assert.equal(merge.subject, 'Merge branch side');
    assert.equal(merge.parents.length, 2);
    assert.deepEqual(merge.paths, []);
    assert.deepEqual(c.paths, ['c.ts']);
    assert.ok([b, c].every((x) => x.parents.length === 1));
    assert.equal(a.body, 'First line of body.\nSecond line of body.');
    assert.equal(a.author, 'Ada Lovelace');
    assert.equal(a.authoredAt.slice(0, 10), '2026-01-02');
    assert.equal(a.authoredTs, Date.UTC(2026, 0, 2) / 1000);
  });

  test('ranges and ancestry', async () => {
    const all = await listCommits(repo.root, 'HEAD');
    const oldest = all.at(-1)!.sha;
    assert.equal((await listCommits(repo.root, `${oldest}..HEAD`)).length, 3);
    assert.equal(await isAncestor(repo.root, oldest), true);
    assert.equal(await isAncestor(repo.root, 'deadbeef'.repeat(5)), false);
    assert.deepEqual(await trackedFiles(repo.root), ['a.ts', 'b.ts', 'c.ts']);
  });

  test('parseLog ignores junk and commitText caps the path list', () => {
    assert.deepEqual(parseLog('\n\n'), []);
    const commit = { sha: 'x', author: 'a', authoredAt: '', authoredTs: 0, parents: [], subject: 'fix: many', body: '', paths: Array.from({ length: 200 }, (_, i) => `src/file-${i}.ts`) };
    const text = commitText(commit, 300);
    assert.ok(text.length <= 300);
    assert.match(text, /^fix: many\n\nFiles:\nsrc\/file-0\.ts/);
    assert.match(text, /\.\.\. and \d+ more$/);
    assert.equal(commitText({ ...commit, paths: ['a.ts'] }, 300), 'fix: many\n\nFiles:\na.ts');
  });
});
