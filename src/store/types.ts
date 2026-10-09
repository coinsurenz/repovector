import type { EmbeddingMode } from '../embed/mode';
import type { Filter, IndexFacts, IndexStats, SearchResponse, Sentinel, StoreRecord } from '../types';

export interface SearchParams {
  query: string;
  topK: number;
  namespace: string;
  filter?: Filter;
  rerank?: boolean;
}

/** Data-plane operations against one index. The embedding mode is fixed when the store is built. */
export interface VectorStore {
  upsertRecords(namespace: string, records: StoreRecord[]): Promise<void>;
  /** Delete ids `${prefix}${n}` with n >= keepBelow; keepBelow 0 deletes every id with the prefix. Returns the count. */
  deleteByPrefix(namespace: string, prefix: string, keepBelow: number): Promise<number>;
  /** Delete every record in the namespace whose id is not in `keep` (the sentinel is always kept). Returns the count. */
  deleteExcept(namespace: string, keep: ReadonlySet<string>): Promise<number>;
  search(params: SearchParams): Promise<SearchResponse>;
  readSentinel(namespace: string): Promise<Sentinel | null>;
  writeSentinel(namespace: string, sentinel: Sentinel): Promise<void>;
  stats(): Promise<IndexStats>;
  deleteNamespace(namespace: string): Promise<void>;
  close(): Promise<void>;
}

/** Control-plane operations. Nothing is created unless asked. */
export interface IndexManager {
  /** Facts about the named index, or null when it does not exist. */
  describe(name: string): Promise<IndexFacts | null>;
  /** Start creating an index for the store's embedding mode. */
  create(name: string): Promise<IndexFacts>;
  waitUntilReady(name: string, timeoutMs?: number): Promise<IndexFacts>;
}

export interface Backend extends VectorStore, IndexManager {
  readonly kind: 'pinecone' | 'postgres' | 'memory';
  /** Hosted reranking exists only on Pinecone. */
  readonly canRerank: boolean;
  /** Point the data plane at an index already described (and graded). */
  use(index: IndexFacts): void;
  /** Fix how vectors are computed; the query side learns it from the sentinel after opening. */
  setMode(mode: EmbeddingMode): void;
}

/** Numeric chunk index encoded after `prefix` in a record id, or -1 when it is not one of ours. */
export function chunkIndexOf(id: string, prefix: string): number {
  if (!id.startsWith(prefix)) return -1;
  const n = Number(id.slice(prefix.length));
  return Number.isInteger(n) && n >= 0 && id.length > prefix.length ? n : -1;
}
