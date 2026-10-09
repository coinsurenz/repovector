import { notFound } from '../errors';
import { RECORD_FIELDS, SENTINEL_ID, type IndexFacts, type IndexStats, type SearchResponse, type Sentinel, type StoreRecord } from '../types';
import { matches, parseFilter } from './filter';
import { toSearchHit } from './hits';
import { chunkIndexOf, type Backend, type SearchParams } from './types';

/**
 * In-process store for tests and --dry-run. Scores by term overlap rather
 * than embeddings; nothing persists past the process.
 */
export class MemoryStore implements Backend {
  readonly kind = 'memory' as const;
  readonly canRerank = false;
  private readonly namespaces = new Map<string, Map<string, StoreRecord>>();
  private readonly sentinels = new Map<string, Sentinel>();
  /** Every upsert batch, in order; tests assert on write volume. */
  readonly writes: Array<{ namespace: string; ids: string[] }> = [];

  constructor(private readonly indexName = 'memory') {}

  private facts(): IndexFacts {
    return { name: this.indexName, state: 'Ready', ready: true, embedModel: 'memory', textField: RECORD_FIELDS.text, dimension: 0, metric: 'overlap' };
  }

  async describe(name: string): Promise<IndexFacts | null> {
    return name === this.indexName ? this.facts() : null;
  }

  async create(name: string): Promise<IndexFacts> {
    if (name !== this.indexName) throw notFound(`The memory store only has the index "${this.indexName}"`);
    return this.facts();
  }

  async waitUntilReady(): Promise<IndexFacts> {
    return this.facts();
  }

  use(): void {}

  setMode(): void {}

  async upsertRecords(namespace: string, records: StoreRecord[]): Promise<void> {
    const space = this.space(namespace);
    for (const record of records) space.set(record._id, { ...record });
    this.writes.push({ namespace, ids: records.map((r) => r._id) });
  }

  async deleteByPrefix(namespace: string, prefix: string, keepBelow: number): Promise<number> {
    const space = this.space(namespace);
    const stale = [...space.keys()].filter((id) => chunkIndexOf(id, prefix) >= keepBelow);
    for (const id of stale) space.delete(id);
    return stale.length;
  }

  async deleteExcept(namespace: string, keep: ReadonlySet<string>): Promise<number> {
    const space = this.space(namespace);
    const stale = [...space.keys()].filter((id) => !keep.has(id));
    for (const id of stale) space.delete(id);
    return stale.length;
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    const started = performance.now();
    const terms = tokenize(params.query);
    const conditions = parseFilter(params.filter);
    const hits = [...this.space(params.namespace).values()]
      .filter((r) => matches(r, conditions))
      .map((r) => ({ r, score: overlapScore(terms, tokenize(String(r[RECORD_FIELDS.text] ?? ''))) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.r._id.localeCompare(b.r._id))
      .slice(0, params.topK)
      .map(({ r, score }) => {
        const { _id, ...fields } = r;
        return toSearchHit(_id, score, fields);
      });
    return { hits, usage: { readUnits: 0, embedTotalTokens: terms.length }, tookMs: Math.round(performance.now() - started), namespace: params.namespace };
  }

  async readSentinel(namespace: string): Promise<Sentinel | null> {
    return this.sentinels.get(namespace) ?? null;
  }

  async writeSentinel(namespace: string, sentinel: Sentinel): Promise<void> {
    this.sentinels.set(namespace, sentinel);
  }

  async stats(): Promise<IndexStats> {
    const namespaces = [...this.namespaces.entries()]
      .map(([name, space]) => ({ name, recordCount: space.size + (this.sentinels.has(name) ? 1 : 0) }))
      .filter((ns) => ns.recordCount > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { indexName: this.indexName, dimension: 0, totalRecordCount: namespaces.reduce((n, ns) => n + ns.recordCount, 0), namespaces };
  }

  async deleteNamespace(namespace: string): Promise<void> {
    this.namespaces.delete(namespace);
    this.sentinels.delete(namespace);
  }

  async close(): Promise<void> {}

  /** Ids currently stored in a namespace, sorted; for tests. */
  ids(namespace: string): string[] {
    return [...this.space(namespace).keys()].filter((id) => id !== SENTINEL_ID).sort();
  }

  record(namespace: string, id: string): StoreRecord | undefined {
    return this.space(namespace).get(id);
  }

  private space(namespace: string): Map<string, StoreRecord> {
    let space = this.namespaces.get(namespace);
    if (!space) {
      space = new Map();
      this.namespaces.set(namespace, space);
    }
    return space;
  }
}

/** Words of two or more letters or digits; camelCase is split so `verifySignature` matches "verify signature". */
function tokenize(text: string): string[] {
  return text.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
}

/** Fraction of distinct query terms present in the document, weighted by repeat hits. */
function overlapScore(queryTerms: string[], docTerms: string[]): number {
  if (queryTerms.length === 0 || docTerms.length === 0) return 0;
  const doc = new Map<string, number>();
  for (const t of docTerms) doc.set(t, (doc.get(t) ?? 0) + 1);
  const distinct = new Set(queryTerms);
  let matched = 0;
  let weight = 0;
  for (const term of distinct) {
    const count = doc.get(term) ?? 0;
    if (count > 0) {
      matched += 1;
      weight += Math.min(count, 3) / 3;
    }
  }
  return Number(((matched + 0.25 * weight) / (1.25 * distinct.size)).toFixed(4));
}
