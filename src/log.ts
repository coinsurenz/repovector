/** Tiny logger: GitHub workflow commands under Actions, plain lines elsewhere. Logs go to stderr so `--json` output stays clean. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Hide a value in every later line of the Actions log. No-op outside Actions. */
  mask(value: string): void;
}

export function createLogger(env: Record<string, string | undefined> = process.env, write: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): Logger {
  const actions = env.GITHUB_ACTIONS === 'true';
  return {
    info: (m) => write(m),
    warn: (m) => write(actions ? `::warning::${escape(m)}` : `warning: ${m}`),
    error: (m) => write(actions ? `::error::${escape(m)}` : `error: ${m}`),
    mask: (v) => {
      if (actions && v.trim() !== '') write(`::add-mask::${v}`);
    },
  };
}

/** A logger that records lines; for tests. */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(m),
    warn: (m) => lines.push(`warning: ${m}`),
    error: (m) => lines.push(`error: ${m}`),
    mask: () => {},
  };
}

/** Workflow command data must escape %, CR and LF. */
const escape = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
