import type { Logger } from '../log';
import type { VectorStore } from '../store/types';
import { RECORD_FIELDS, type StoreRecord } from '../types';
import { DEFAULT_RETRY, describeWait, withRetry, type RetryPolicy } from './retry';
import { estimateTokens, type TokenRateLimiter } from './throttle';

export interface WriterOptions {
  store: Pick<VectorStore, 'upsertRecords'>;
  namespace: string;
  batchSize: number;
  log: Logger;
  throttle?: TokenRateLimiter;
  retry?: RetryPolicy;
}

/**
 * Accumulates records across small files so upserts stay close to the batch
 * size. Work queued with `after` (stale-tail deletes) runs only once the
 * records added before it are stored, so a failed run never deletes good data.
 */
export class RecordWriter {
  private records: StoreRecord[] = [];
  private pending: Array<() => Promise<void>> = [];
  upserted = 0;
  tokens = 0;

  constructor(private readonly opts: WriterOptions) {}

  async add(records: StoreRecord[], after?: () => Promise<void>): Promise<void> {
    this.records.push(...records);
    if (after) this.pending.push(after);
    if (this.records.length >= this.opts.batchSize) await this.flush();
  }

  async flush(): Promise<void> {
    const { opts } = this;
    for (let i = 0; i < this.records.length; i += opts.batchSize) {
      const batch = this.records.slice(i, i + opts.batchSize);
      const tokens = batch.reduce((n, r) => n + estimateTokens(String(r[RECORD_FIELDS.text] ?? '')), 0);
      if (opts.throttle) {
        const waited = await opts.throttle.take(tokens);
        if (waited > 0) opts.log.info(`Paced: waited ${Math.round(waited / 1000)} s to stay under ${opts.throttle.limit?.toLocaleString('en-GB')} embedding tokens per minute`);
      }
      await withRetry(() => opts.store.upsertRecords(opts.namespace, batch), opts.retry ?? DEFAULT_RETRY, (wait) => opts.log.warn(describeWait('Upsert', wait)));
      this.upserted += batch.length;
      this.tokens += tokens;
    }
    this.records = [];
    const pending = this.pending;
    this.pending = [];
    for (const task of pending) await task();
  }
}
