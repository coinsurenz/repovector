/** Metadata fields written on every record. Code chunks add the symbol fields; commits add their own (see git/history.ts). */
export const RECORD_FIELDS = {
  text: 'chunk_text',
  source: 'source',
  fileName: 'file_name',
  chunkIndex: 'chunk_index',
  totalChunks: 'total_chunks',
  ext: 'ext',
  ingestedAt: 'ingested_at',
  kind: 'kind',
  contentHash: 'content_hash',
  language: 'language',
  symbol: 'symbol',
  symbolKind: 'symbol_kind',
  startLine: 'start_line',
  endLine: 'end_line',
  repo: 'repo',
  branch: 'branch',
  commit: 'commit',
} as const;

/** What a record holds: a code chunk, a commit, or the per-namespace sentinel that records the last indexed SHA. */
export type RecordKind = 'code' | 'commit' | 'sentinel';

export type Scalar = string | number | boolean;

/** One record as written to the store: an id plus flat metadata. The text lives in `chunk_text`. */
export type StoreRecord = { _id: string } & Record<string, Scalar | string[]>;

/**
 * Pinecone-style metadata filter: `{ field: value }`, `{ field: { $eq: value } }`,
 * `{ field: { $gte | $lte | $gt | $lt: number } }` and `$and` of those.
 * Stores refuse anything else rather than silently ignoring it.
 */
export type Filter = Record<string, unknown>;

export interface SearchHit {
  id: string;
  score: number;
  text: string;
  /** Path relative to the repository root (code), or empty (commits). */
  source: string;
  fileName: string;
  chunkIndex: number;
  totalChunks: number;
  kind: RecordKind;
  language?: string;
  symbol?: string;
  symbolKind?: string;
  startLine?: number;
  endLine?: number;
  commit?: string;
  branch?: string;
  metadata: Record<string, unknown>;
}

export interface SearchUsage {
  readUnits: number;
  embedTotalTokens?: number;
  rerankUnits?: number;
}

export interface SearchResponse {
  hits: SearchHit[];
  usage: SearchUsage;
  tookMs: number;
  namespace: string;
}

/** An index as its store describes it, before grading against an embedding mode. */
export interface IndexFacts {
  name: string;
  state: string;
  ready: boolean;
  /** Hosted embedding model (Pinecone integrated inference), or null for a vectors-only index. */
  embedModel: string | null;
  /** Record field a hosted index embeds: "text" for console-made indexes, "chunk_text" for ones this tool creates. */
  textField: string | null;
  dimension?: number;
  metric?: string;
  host?: string;
  /** Postgres only: the model recorded when the table was created. */
  vectorModel?: string;
}

export interface NamespaceStats {
  name: string;
  recordCount: number;
}

export interface IndexStats {
  indexName: string;
  dimension?: number;
  totalRecordCount: number;
  namespaces: NamespaceStats[];
}

export type EmbeddingProviderName = 'pinecone' | 'openrouter' | 'openai';

/** Written after every successful run, one per namespace; tells the next run where it left off. */
export interface Sentinel {
  kind: 'code' | 'commit';
  sha: string;
  branch: string;
  repo: string;
  chunkerVersion: string;
  toolVersion: string;
  /** Hash of the settings that change which records exist (excludes, size cap, chunk sizes); a change forces a full run. */
  settings: string;
  provider: EmbeddingProviderName | 'memory';
  model: string;
  /** Vector size actually stored (null for hosted indexes that report none). */
  dimension: number | null;
  /** Truncation requested from the provider (REPO_VECTOR_EMBEDDING_DIMENSIONS); queries must send the same. */
  dimensions: number | null;
  indexedAt: string;
  /** Eligible files at `sha` (code), or commits indexed in total (history). */
  files: number;
  lastRun: { mode: 'full' | 'incremental'; filesIndexed: number; filesRemoved: number; recordsUpserted: number; recordsDeleted: number };
}

export const SENTINEL_ID = '__repo_vector__';
