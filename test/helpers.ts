import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config';
import type { EmbeddingClient } from '../src/embed/client';

/** A throwaway git repository with deterministic authorship. */
export class FixtureRepo {
  private tick = 0;
  private constructor(readonly root: string) {}

  static async create(): Promise<FixtureRepo> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'repo-vector-fixture-'));
    const repo = new FixtureRepo(root);
    repo.git('init', '-q', '-b', 'main');
    repo.git('config', 'user.name', 'Ada Lovelace');
    repo.git('config', 'user.email', 'ada@example.com');
    repo.git('config', 'commit.gpgsign', 'false');
    return repo;
  }

  git(...args: string[]): string {
    const date = new Date(Date.UTC(2026, 0, 1) + this.tick * 86_400_000).toISOString();
    return execFileSync('git', ['-C', this.root, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  }

  async write(rel: string, content: string): Promise<void> {
    const abs = path.join(this.root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }

  commit(message: string): string {
    this.tick += 1;
    this.git('add', '-A');
    this.git('commit', '-q', '-m', message);
    return this.git('rev-parse', 'HEAD').trim();
  }

  async remove(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

export function indexingConfig(overrides: Partial<Config['indexing']> = {}): Config['indexing'] {
  return {
    root: '.',
    exclude: [],
    maxFileBytes: 512 * 1024,
    chunk: { target: 1200, max: 2400 },
    batchSize: 48,
    fullReindex: false,
    maxDiffRatio: 0.9,
    history: true,
    historyMaxCommits: 20000,
    ...overrides,
  };
}

/** Deterministic 4-d vectors chosen by keyword, so nearest-neighbour order is predictable. */
export const keywordEmbedder: EmbeddingClient = {
  name: 'fake',
  embed: async (_m, inputs) => ({
    vectors: inputs.map((t) => (/refund/i.test(t) ? [1, 0, 0, 0] : /webhook|signature/i.test(t) ? [0, 1, 0, 0] : /terminal/i.test(t) ? [0, 0, 1, 0] : [0, 0, 0, 1])),
    tokens: inputs.length,
  }),
  probeDimension: async () => 4,
};

export const NO_RETRY = { attempts: 1, baseDelayMs: 1 };

/** TypeScript function of `lines` lines, for growing and shrinking files. */
export function tsFunctions(names: string[], bodyLines = 2): string {
  return names
    .map((n) => `/** ${n} does a thing. */\nexport function ${n}(x: number): number {\n${Array.from({ length: bodyLines }, (_, i) => `  x += ${i};`).join('\n')}\n  return x;\n}\n`)
    .join('\n');
}
