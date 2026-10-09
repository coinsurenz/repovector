import path from 'node:path';

/** Extensions read as UTF-8 text. Extensionless files (Makefile, Dockerfile) pass and are sniffed for binary content. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.text', '.md', '.markdown', '.mdx', '.rst', '.org', '.adoc', '.tex',
  '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties',
  '.csv', '.tsv', '.xml', '.html', '.htm', '.svg', '.css', '.scss', '.less',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts',
  '.swift', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.php', '.sh', '.zsh', '.bash', '.fish',
  '.sql', '.graphql', '.proto', '.prisma', '.lua', '.pl', '.r', '.scala', '.clj', '.ex', '.exs', '.hs',
  '.dart', '.m', '.mm', '.vue', '.svelte', '.astro', '.dockerfile', '.tf', '.hcl', '.gradle',
]);

/** Whether a path names a text format worth indexing. */
export function isSupportedFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (ext === '') return true;
  return TEXT_EXTENSIONS.has(ext);
}

/** A NUL byte in the first 8 KB is a reliable sign of a binary file. */
export function looksBinary(buffer: Uint8Array): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

/** Strip BOM, unify line endings, trim trailing spaces, collapse blank-line runs. */
export function normalizeText(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
