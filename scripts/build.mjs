// Bundle the action and the CLI with esbuild, then copy the tree-sitter WASM files beside them.
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const require = createRequire(import.meta.url);

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'grammars'), { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  legalComments: 'none',
  logLevel: 'warning',
  // CommonJS dependencies (the Pinecone SDK) call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __rvCreateRequire } from 'node:module'; const require = __rvCreateRequire(import.meta.url);" },
};

await build({ ...shared, entryPoints: [path.join(root, 'src/action.ts')], outfile: path.join(dist, 'action.js') });
await build({ ...shared, entryPoints: [path.join(root, 'src/cli.ts')], outfile: path.join(dist, 'cli.js') });

// The web-tree-sitter runtime.
await copyFile(require.resolve('web-tree-sitter/tree-sitter.wasm'), path.join(dist, 'tree-sitter.wasm'));

// One grammar per entry in GRAMMARS (read from the source so the two never drift).
const chunker = await readFile(path.join(root, 'src/chunk/code.ts'), 'utf8');
const grammars = [...chunker.matchAll(/^\s+\w+: def\('(\w+)'/gm)].map((m) => m[1]);
const grammarSource = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
for (const g of grammars) await copyFile(path.join(grammarSource, `tree-sitter-${g}.wasm`), path.join(dist, 'grammars', `tree-sitter-${g}.wasm`));

const size = async (f) => ((await stat(path.join(dist, f))).size / 1024 / 1024).toFixed(1);
let grammarBytes = 0;
for (const g of grammars) grammarBytes += (await stat(path.join(dist, 'grammars', `tree-sitter-${g}.wasm`))).size;
console.log(`dist/action.js ${await size('action.js')} MB, dist/cli.js ${await size('cli.js')} MB, ${grammars.length} grammars ${(grammarBytes / 1024 / 1024).toFixed(1)} MB`);
