import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CodeChunk } from '../chunk/code';
import type { Commit } from '../git/history';
import { RECORD_FIELDS, type StoreRecord } from '../types';

/** Stable id for a file, from its repository-relative path, so every runner produces the same ids. */
export function fileId(relPath: string): string {
  return createHash('sha1').update(relPath).digest('hex').slice(0, 16);
}

export interface Provenance {
  repo: string;
  branch: string;
  commit: string;
  ingestedAt: string;
}

export function buildCodeRecord(relPath: string, chunk: CodeChunk, chunkIndex: number, totalChunks: number, p: Provenance): StoreRecord {
  const record: StoreRecord = {
    _id: `${fileId(relPath)}:${chunkIndex}`,
    [RECORD_FIELDS.text]: chunk.text,
    [RECORD_FIELDS.source]: relPath,
    [RECORD_FIELDS.fileName]: path.posix.basename(relPath),
    [RECORD_FIELDS.chunkIndex]: chunkIndex,
    [RECORD_FIELDS.totalChunks]: totalChunks,
    [RECORD_FIELDS.ext]: path.posix.extname(relPath).toLowerCase().replace(/^\./, '') || 'none',
    [RECORD_FIELDS.ingestedAt]: p.ingestedAt,
    [RECORD_FIELDS.kind]: 'code',
    [RECORD_FIELDS.contentHash]: createHash('sha1').update(chunk.text).digest('hex').slice(0, 16),
    [RECORD_FIELDS.language]: chunk.language,
    [RECORD_FIELDS.startLine]: chunk.startLine,
    [RECORD_FIELDS.endLine]: chunk.endLine,
    [RECORD_FIELDS.repo]: p.repo,
    [RECORD_FIELDS.branch]: p.branch,
    [RECORD_FIELDS.commit]: p.commit,
  };
  if (chunk.symbol) record[RECORD_FIELDS.symbol] = chunk.symbol;
  if (chunk.kind) record[RECORD_FIELDS.symbolKind] = chunk.kind;
  return record;
}

const MAX_PATHS = 50;

/** One record per commit: message plus touched paths as text; author name only, never the email. */
export function buildCommitRecord(commit: Commit, maxChars: number, p: Omit<Provenance, 'commit'>): StoreRecord {
  return {
    _id: commit.sha,
    [RECORD_FIELDS.text]: commitText(commit, maxChars),
    [RECORD_FIELDS.kind]: 'commit',
    sha: commit.sha,
    short_sha: commit.sha.slice(0, 7),
    author: commit.author,
    authored_at: commit.authoredAt,
    authored_ts: commit.authoredTs,
    subject: commit.subject,
    files_changed: commit.paths.length,
    paths: commit.paths.slice(0, MAX_PATHS),
    is_merge: commit.parents.length > 1,
    [RECORD_FIELDS.repo]: p.repo,
    [RECORD_FIELDS.branch]: p.branch,
    [RECORD_FIELDS.commit]: commit.sha,
    [RECORD_FIELDS.ingestedAt]: p.ingestedAt,
  };
}

/** `subject`, blank line, body, blank line, `Files:` and one path per line, cut to maxChars with an "and N more" tail. */
export function commitText(commit: Commit, maxChars: number): string {
  const head = [commit.subject, commit.body].filter((s) => s.trim() !== '').join('\n\n');
  if (commit.paths.length === 0) return head.slice(0, maxChars);
  let text = `${head}\n\nFiles:`;
  for (const [i, p] of commit.paths.entries()) {
    const remaining = commit.paths.length - i;
    const tail = `\n... and ${remaining} more`;
    if (text.length + 1 + p.length + (remaining > 1 ? tail.length : 0) > maxChars) {
      return text.length + tail.length <= maxChars ? `${text}${tail}` : text.slice(0, maxChars);
    }
    text += `\n${p}`;
  }
  return text;
}
