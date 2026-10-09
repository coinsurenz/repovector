import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Where the tree-sitter WASM files live. A bundle (dist/action.js, dist/cli.js)
 * carries them beside itself; a source checkout reads them from node_modules.
 * REPO_VECTOR_GRAMMAR_DIR overrides the grammar folder for development.
 */
export function grammarDir(env: Record<string, string | undefined> = process.env): string {
  if (env.REPO_VECTOR_GRAMMAR_DIR) return env.REPO_VECTOR_GRAMMAR_DIR;
  const bundled = path.join(here, 'grammars');
  if (existsSync(bundled)) return bundled;
  return path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
}

/** The web-tree-sitter runtime (tree-sitter.wasm). */
export function runtimeWasm(): string {
  const bundled = path.join(here, 'tree-sitter.wasm');
  if (existsSync(bundled)) return bundled;
  return require.resolve('web-tree-sitter/tree-sitter.wasm');
}
