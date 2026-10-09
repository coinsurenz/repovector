import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Minimal .env loader for the CLI, server and MCP entry points (the action
 * never reads one). Values already in the environment always win.
 */
export function loadDotEnv(file: string = path.join(process.cwd(), '.env'), env: Record<string, string | undefined> = process.env): boolean {
  if (!existsSync(file)) return false;
  for (const [key, value] of Object.entries(parseDotEnv(readFileSync(file, 'utf8')))) {
    if (env[key] === undefined) env[key] = value;
  }
  return true;
}

export function parseDotEnv(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}
