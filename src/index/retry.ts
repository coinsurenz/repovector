import { Errors } from '@pinecone-database/pinecone';
import { ConfigError, HttpError } from '../errors';

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  /** Base wait after a rate-limit answer; grows with the attempt because the windows are per minute. */
  rateLimitDelayMs?: number;
  shouldRetry?: (err: unknown) => boolean;
}

export interface RetryWait {
  attempt: number;
  delayMs: number;
  rateLimited: boolean;
  reason: string;
}

/** Long enough for a per-minute token window to clear across a few attempts, short enough to fail a dead service. */
export const DEFAULT_RETRY: RetryPolicy = { attempts: 8, baseDelayMs: 500, rateLimitDelayMs: 20_000 };

/** Pinecone answers 429 as an unmapped error whose message carries the code; the embedding clients raise HttpError 429. */
export function isRateLimitError(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429;
  if (err instanceof Errors.BasePineconeError) return /\b429\b|RESOURCE_EXHAUSTED|rate limit|per minute/i.test(err.message);
  return false;
}

const PINECONE_PERMANENT = [
  Errors.PineconeBadRequestError,
  Errors.PineconeAuthorizationError,
  Errors.PineconePaymentRequiredError,
  Errors.PineconeNotFoundError,
  Errors.PineconeUnprocessableEntityError,
  Errors.PineconeArgumentError,
];

/** SQLSTATE classes worth retrying: connection exceptions, insufficient resources, operator intervention, serialisation and deadlock. */
const RETRYABLE_SQLSTATE = /^(08|53|57P|40001|40P01)/;

/** Retry only what time can fix: 429, 5xx, network and connection trouble. Never bad input, bad credentials or bugs. */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof ConfigError || err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError) return false;
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  if (PINECONE_PERMANENT.some((cls) => err instanceof cls)) return false;
  const sqlstate = (err as { code?: unknown } | null)?.code;
  if (typeof sqlstate === 'string' && /^[0-9A-Z]{5}$/.test(sqlstate)) return RETRYABLE_SQLSTATE.test(sqlstate);
  return true;
}

export async function withRetry<T>(fn: () => Promise<T>, policy: RetryPolicy, onWait?: (wait: RetryWait) => void): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const rateLimited = isRateLimitError(err);
      const retryable = rateLimited || (policy.shouldRetry ?? isRetryableError)(err);
      if (!retryable || attempt >= policy.attempts) throw err;
      const delayMs = rateLimited ? (policy.rateLimitDelayMs ?? 20_000) * Math.min(attempt, 3) : policy.baseDelayMs * 2 ** (attempt - 1);
      onWait?.({ attempt, delayMs, rateLimited, reason: err instanceof Error ? err.message : String(err) });
      await sleep(delayMs);
    }
  }
}

export function describeWait(what: string, wait: RetryWait): string {
  const seconds = Math.round(wait.delayMs / 1000);
  return wait.rateLimited
    ? `${what}: rate limited by the embedding service (${wait.reason}). Waiting ${seconds} s before attempt ${wait.attempt + 1}.`
    : `${what}: attempt ${wait.attempt} failed (${wait.reason}). Retrying in ${seconds} s.`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
