import postgres, { type PendingQuery, type Row, type Sql } from 'postgres';
import { describeMode, isExternal, type EmbeddingMode, type ExternalMode } from '../embed/mode';
import { ConfigError, badRequest, unavailable } from '../errors';
import { RECORD_FIELDS, type IndexFacts, type IndexStats, type SearchResponse, type Sentinel, type StoreRecord } from '../types';
import { parseFilter, type Condition } from './filter';
import { metadataOf, parseSentinel, toSearchHit } from './hits';
import { safeKey, tableNameFor, vectorLiteral } from './sql';
import type { Backend, SearchParams } from './types';

interface IndexRow {
  name: string;
  table_name: string;
  dimension: number;
  model: string;
}

type Fragment = PendingQuery<Row[]>;

/**
 * Backend over Postgres with pgvector. One table per logical index (its
 * dimension is part of the column type), vectors as halfvec with an HNSW
 * cosine index, metadata as jsonb, sentinels in their own small table.
 * Vectors come from an external embedding client; Postgres cannot embed text.
 */
export class PostgresStore implements Backend {
  readonly kind = 'postgres' as const;
  readonly canRerank = false;
  private table: string | null = null;

  constructor(
    private readonly sql: Sql,
    private mode: EmbeddingMode,
  ) {}

  setMode(mode: EmbeddingMode): void {
    this.mode = mode;
  }

  static fromUrl(url: string, mode: EmbeddingMode): PostgresStore {
    return new PostgresStore(postgres(url, { max: 4, onnotice: () => {} }), mode);
  }

  /** Idempotent schema bootstrap. Runs on every open. */
  async migrate(): Promise<void> {
    const [present] = await this.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'vector'`;
    if (!present?.n) {
      try {
        await this.sql`CREATE EXTENSION IF NOT EXISTS vector`;
      } catch (err) {
        if ((err as { code?: string }).code === '42501') {
          throw new ConfigError('pgvector is not enabled and this role cannot enable it; ask your database administrator to run CREATE EXTENSION vector');
        }
        throw err;
      }
    }
    await this.sql`CREATE TABLE IF NOT EXISTS vector_indexes (
      name text PRIMARY KEY, table_name text NOT NULL UNIQUE, dimension integer NOT NULL,
      model text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
    await this.sql`CREATE TABLE IF NOT EXISTS repo_vector_sentinels (
      table_name text NOT NULL, namespace text NOT NULL, data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (table_name, namespace))`;
  }

  // ---------- IndexManager ----------

  async describe(name: string): Promise<IndexFacts | null> {
    // A read-only role never migrates, so before the first index run the table may not exist yet.
    const rows = await missingAsEmpty(this.sql<IndexRow[]>`SELECT name, table_name, dimension, model FROM vector_indexes WHERE name = ${name}`);
    return rows[0] ? toFacts(rows[0]) : null;
  }

  async create(name: string): Promise<IndexFacts> {
    const mode = this.mode;
    if (!isExternal(mode)) throw badRequest(`Postgres cannot store vectors for ${describeMode(mode)}; use openrouter or openai`);
    const table = tableNameFor(name);
    await this.sql.begin(async (tx) => {
      await tx`INSERT INTO vector_indexes (name, table_name, dimension, model) VALUES (${name}, ${table}, ${mode.dimension}, ${mode.model})`;
      await tx.unsafe(`CREATE TABLE "${table}" (
        id text NOT NULL, namespace text NOT NULL, embedding halfvec(${mode.dimension}) NOT NULL,
        chunk_text text NOT NULL, metadata jsonb NOT NULL, PRIMARY KEY (namespace, id))`);
      await tx.unsafe(`CREATE INDEX "${table}_embedding_idx" ON "${table}" USING hnsw (embedding halfvec_cosine_ops)`);
      await tx.unsafe(`CREATE INDEX "${table}_namespace_idx" ON "${table}" (namespace)`);
    });
    return toFacts({ name, table_name: table, dimension: mode.dimension, model: mode.model });
  }

  async waitUntilReady(name: string): Promise<IndexFacts> {
    const facts = await this.describe(name);
    if (!facts) throw unavailable(`No index named "${name}" in this database`);
    return facts;
  }

  use(index: IndexFacts): void {
    this.table = tableNameFor(index.name);
  }

  // ---------- VectorStore ----------

  async upsertRecords(namespace: string, records: StoreRecord[]): Promise<void> {
    if (records.length === 0) return;
    const { table, mode } = this.target();
    const texts = records.map((r) => String(r[RECORD_FIELDS.text] ?? ''));
    const { vectors } = await mode.client.embed(mode.model, texts, mode.dimensions);
    const rows = records.map((r, i) => {
      const { [RECORD_FIELDS.text]: _text, ...metadata } = metadataOf(r);
      return { id: r._id, namespace, embedding: vectorLiteral(vectors[i] ?? []), chunk_text: texts[i] ?? '', metadata: this.sql.json(metadata as never) };
    });
    await this.sql`INSERT INTO ${this.sql(table)} ${this.sql(rows, 'id', 'namespace', 'embedding', 'chunk_text', 'metadata')}
      ON CONFLICT (namespace, id) DO UPDATE SET embedding = EXCLUDED.embedding, chunk_text = EXCLUDED.chunk_text, metadata = EXCLUDED.metadata`;
  }

  async deleteByPrefix(namespace: string, prefix: string, keepBelow: number): Promise<number> {
    const table = this.requireTable();
    const from = prefix.length + 1;
    const deleted = await this.sql`DELETE FROM ${this.sql(table)}
      WHERE namespace = ${namespace} AND starts_with(id, ${prefix})
        AND (CASE WHEN substr(id, ${from}) ~ '^[0-9]+$' THEN substr(id, ${from})::bigint ELSE -1 END) >= ${keepBelow}
      RETURNING id`;
    return deleted.length;
  }

  async deleteExcept(namespace: string, keep: ReadonlySet<string>): Promise<number> {
    const table = this.requireTable();
    const deleted = await this.sql`DELETE FROM ${this.sql(table)} WHERE namespace = ${namespace} AND NOT (id = ANY(${[...keep]}::text[])) RETURNING id`;
    return deleted.length;
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    if (params.rerank) throw badRequest('Reranking is only available on the Pinecone store');
    const started = performance.now();
    const { table, mode } = this.target();
    const conditions = parseFilter(params.filter);
    const { vectors, tokens } = await mode.client.embed(mode.model, [params.query], mode.dimensions);
    const vector = vectorLiteral(vectors[0] ?? []);
    const rows = await this.sql<Array<{ id: string; chunk_text: string; metadata: Record<string, unknown>; score: number }>>`
      SELECT id, chunk_text, metadata, 1 - (embedding <=> ${vector}::halfvec) AS score
      FROM ${this.sql(table)}
      WHERE namespace = ${params.namespace} ${this.where(conditions)}
      ORDER BY embedding <=> ${vector}::halfvec
      LIMIT ${params.topK}`;
    return {
      hits: rows.map((row) => toSearchHit(row.id, Number(row.score), { ...row.metadata, [RECORD_FIELDS.text]: row.chunk_text })),
      usage: { readUnits: 0, embedTotalTokens: tokens },
      tookMs: Math.round(performance.now() - started),
      namespace: params.namespace,
    };
  }

  async readSentinel(namespace: string): Promise<Sentinel | null> {
    const table = this.requireTable();
    const [row] = await missingAsEmpty(this.sql<Array<{ data: unknown }>>`SELECT data FROM repo_vector_sentinels WHERE table_name = ${table} AND namespace = ${namespace}`);
    return row ? parseSentinel(JSON.stringify(row.data)) : null;
  }

  async writeSentinel(namespace: string, sentinel: Sentinel): Promise<void> {
    const table = this.requireTable();
    await this.sql`INSERT INTO repo_vector_sentinels (table_name, namespace, data) VALUES (${table}, ${namespace}, ${this.sql.json(sentinel as never)})
      ON CONFLICT (table_name, namespace) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
  }

  async stats(): Promise<IndexStats> {
    const table = this.requireTable();
    const counts = await this.sql<Array<{ namespace: string; n: number }>>`SELECT namespace, count(*)::int AS n FROM ${this.sql(table)} GROUP BY namespace ORDER BY namespace`;
    const [row] = await this.sql<IndexRow[]>`SELECT name, table_name, dimension, model FROM vector_indexes WHERE table_name = ${table}`;
    const namespaces = counts.map((c) => ({ name: c.namespace, recordCount: c.n }));
    return { indexName: row?.name ?? table, dimension: row?.dimension, totalRecordCount: namespaces.reduce((n, ns) => n + ns.recordCount, 0), namespaces };
  }

  async deleteNamespace(namespace: string): Promise<void> {
    const table = this.requireTable();
    await this.sql`DELETE FROM ${this.sql(table)} WHERE namespace = ${namespace}`;
    await this.sql`DELETE FROM repo_vector_sentinels WHERE table_name = ${table} AND namespace = ${namespace}`;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  // ---------- internals ----------

  /** ` AND ...` for each condition: jsonb equality by containment, numeric ranges by cast. Empty when there are none. */
  private where(conditions: Condition[]): Fragment {
    return conditions.reduce<Fragment>((acc, c) => {
      const key = safeKey(c.field);
      if (c.op === '$eq') return this.sql`${acc} AND metadata @> ${this.sql.json({ [key]: c.value } as never)}::jsonb`;
      const cast = this.sql`(metadata->>${key})::numeric`;
      const op = { $gte: this.sql`>=`, $lte: this.sql`<=`, $gt: this.sql`>`, $lt: this.sql`<` }[c.op];
      return this.sql`${acc} AND ${cast} ${op} ${c.value}`;
    }, this.sql``);
  }

  private requireTable(): string {
    if (!this.table) throw unavailable('No Postgres index selected');
    return this.table;
  }

  private target(): { table: string; mode: ExternalMode } {
    const table = this.requireTable();
    if (!isExternal(this.mode)) throw unavailable(`Postgres needs an external embedding provider, not ${describeMode(this.mode)}`);
    return { table, mode: this.mode };
  }
}

function toFacts(row: IndexRow): IndexFacts {
  return { name: row.name, state: 'Ready', ready: true, embedModel: null, textField: null, dimension: row.dimension, metric: 'cosine', vectorModel: row.model };
}

/** undefined_table (42P01) reads as no rows: the indexer has not created the schema yet. */
async function missingAsEmpty<T>(query: PromiseLike<T[]>): Promise<T[]> {
  try {
    return await query;
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') return [];
    throw err;
  }
}
