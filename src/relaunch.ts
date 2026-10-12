import { spawn } from 'node:child_process';

/**
 * Keep V8 on its baseline WebAssembly compiler. On Node 24, V8 recompiles the
 * tree-sitter grammars' huge parse-table functions with its optimising tier as
 * soon as they run hot, which briefly takes about 2 GB of native memory even
 * on a ten-file repository and gets a small runner killed. Baseline code parses
 * fast enough. The flag only works on the command line (V8 fixes its
 * WebAssembly settings at start-up), so the entry points re-run themselves once
 * with it.
 */
export const BASELINE_WASM_FLAG = '--liftoff-only';

/**
 * Re-run this process with BASELINE_WASM_FLAG, sharing stdio and forwarding
 * SIGINT/SIGTERM, and resolve with the child's exit code. Returns null when the
 * flag is already set, so the caller carries on in this process.
 */
export function relaunchWithBaselineWasm(): Promise<number> | null {
  if (process.execArgv.includes(BASELINE_WASM_FLAG)) return null;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BASELINE_WASM_FLAG, ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.on('error', (err) => {
      process.stderr.write(`repo-vector: could not restart Node with ${BASELINE_WASM_FLAG}: ${err.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
