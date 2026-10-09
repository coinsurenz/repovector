import { lstat } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { isSensitivePath } from '../files/sensitive';
import { isSupportedFile } from '../files/text';
import { git, gitRaw } from './exec';

/** Folders and files no one wants embedded. REPO_VECTOR_EXCLUDE adds to these; nothing removes them. */
export const DEFAULT_EXCLUDES = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/out/**', '**/.next/**', '**/.turbo/**',
  '**/coverage/**', '**/target/**', '**/vendor/**', '**/.venv/**', '**/__pycache__/**', '**/__snapshots__/**',
  '**/*.lock', '**/*-lock.json', '**/*-lock.yaml', '**/*.min.*', '**/*.map', '**/*.g.dart', '**/*.freezed.dart', '**/*.pb.*',
];

export interface SelectOptions {
  root: string;
  exclude: string[];
  maxFileBytes: number;
}

export type Selection = { ok: true } | { ok: false; reason: 'excluded' | 'sensitive' | 'unsupported' | 'not-a-file' | 'too-large' | 'missing' };

/** Builds the eligibility check once (glob compilation is the costly part) and applies it per repository-relative path. */
export function fileSelector(opts: SelectOptions): (relPath: string) => Promise<Selection> {
  const isExcluded = picomatch([...DEFAULT_EXCLUDES, ...opts.exclude], { dot: true });
  return async (relPath) => {
    if (isExcluded(relPath)) return { ok: false, reason: 'excluded' };
    if (isSensitivePath(relPath)) return { ok: false, reason: 'sensitive' };
    if (!isSupportedFile(relPath)) return { ok: false, reason: 'unsupported' };
    const info = await lstat(path.join(opts.root, relPath)).catch(() => null);
    if (!info) return { ok: false, reason: 'missing' };
    // Symlinks and submodule gitlinks are skipped: only regular files are content of this repository.
    if (!info.isFile()) return { ok: false, reason: 'not-a-file' };
    if (info.size > opts.maxFileBytes) return { ok: false, reason: 'too-large' };
    return { ok: true };
  };
}

export async function isGitCheckout(root: string): Promise<boolean> {
  const result = await gitRaw(root, ['rev-parse', '--is-inside-work-tree']).catch(() => null);
  return result?.code === 0 && result.stdout.trim() === 'true';
}

/** Every tracked file, repository-relative with forward slashes. Untracked files are never indexed. */
export async function trackedFiles(root: string): Promise<string[]> {
  const out = await git(root, ['ls-files', '-z', '--cached']);
  return out.split('\0').filter((p) => p !== '');
}

export async function headSha(root: string): Promise<string> {
  return (await git(root, ['rev-parse', 'HEAD'])).trim();
}

export async function currentBranch(root: string): Promise<string> {
  return (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

/** True when `ancestor` is in HEAD's history. False when it is not, or when this clone does not have it. */
export async function isAncestor(root: string, ancestor: string, descendant = 'HEAD'): Promise<boolean> {
  const result = await gitRaw(root, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return result.code === 0;
}

/** owner/name from the origin remote (https or ssh form), or null. Lets a laptop and CI agree on the namespace. */
export async function originRepo(root: string): Promise<string | null> {
  const result = await gitRaw(root, ['remote', 'get-url', 'origin']).catch(() => null);
  if (!result || result.code !== 0) return null;
  return parseRemote(result.stdout.trim());
}

export function parseRemote(url: string): string | null {
  const match = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

export interface DiffChanges {
  /** Added, modified or type-changed paths, plus the new side of renames: (re)index these. */
  changed: string[];
  /** Deleted paths, plus the old side of renames: delete their records. */
  removed: string[];
  /** Raw number of entries, for the full-run threshold. */
  entries: number;
}

/** Changes between `base` and HEAD, rename aware. */
export async function diffSince(root: string, base: string): Promise<DiffChanges> {
  return parseNameStatus(await git(root, ['diff', '-z', '--name-status', '-M', base, 'HEAD']));
}

/** Parse `git diff -z --name-status -M`: status NUL path NUL, with two paths for renames and copies. */
export function parseNameStatus(out: string): DiffChanges {
  const parts = out.split('\0');
  const changed = new Set<string>();
  const removed = new Set<string>();
  let entries = 0;
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (!status) continue;
    entries += 1;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const from = parts[i++]!;
      const to = parts[i++]!;
      if (code === 'R') removed.add(from);
      changed.add(to);
      continue;
    }
    const file = parts[i++]!;
    if (code === 'D') removed.add(file);
    else changed.add(file);
  }
  for (const p of changed) removed.delete(p);
  return { changed: [...changed].sort(), removed: [...removed].sort(), entries };
}
