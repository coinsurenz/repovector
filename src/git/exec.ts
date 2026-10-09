import { execFile } from 'node:child_process';

export interface GitResult {
  stdout: string;
  code: number;
  stderr: string;
}

/** Run git with an argument array (never a shell string) and return output and exit code without throwing. */
export function gitRaw(root: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', root, ...args], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && typeof (err as NodeJS.ErrnoException).code === 'string') {
        // ENOENT and friends: git itself could not be started.
        reject(new Error(`Could not run git: ${err.message}`));
        return;
      }
      const code = err ? Number((err as { code?: number }).code ?? 1) : 0;
      resolve({ stdout, stderr, code });
    });
  });
}

/** Run git and return stdout; a non-zero exit becomes an error carrying git's message. */
export async function git(root: string, args: string[]): Promise<string> {
  const result = await gitRaw(root, args);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
  return result.stdout;
}
