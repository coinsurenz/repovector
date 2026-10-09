import { Errors, Pinecone, type IndexModel, type ScoredPineconeRecord } from '@pinecone-database/pinecone';
import { describeMode, isExternal, type EmbeddingMode, type ExternalMode } from '../embed/mode';
import { HttpError, badRequest, unavailable } from '../errors';
import { RECORD_FIELDS, SENTINEL_ID, type IndexFacts, type IndexStats, type SearchHit, type SearchResponse, type Sentinel, type StoreRecord } from '../types';
import { SENTINEL_FIELD, metadataOf, parseSentinel, toSearchHit } from './hits';
import { chunkIndexOf, type Backend, type SearchParams } from './types';

export interface PineconeStoreConfig {
  cloud: 'aws' | 'gcp' | 'azure';
  region: string;
  rerankModel: string;
}

const LIST_PAGE_SIZE = 100;
const DELETE_BATCH_SIZE = 1000;
const READY_POLL_MS = 5000;
const READY_TIMEOUT_MS = 10 * 60_000;
const RERANK_CANDIDATE_CAP = 100;
/** The hosted plane must embed something for every record, the sentinel included. */
const SENTINEL_TEXT = 'repo-vector sentinel';

/**
 * Pinecone serverless backend. Two data planes: integrated (the index embeds
 * text with its hosted model) and external (OpenRouter or OpenAI vectors
 * stored raw, every other field as metadata).
 */
export class PineconeStore implements Backend {
  readonly kind = 'pinecone' as const;
  readonly canRerank = true;
  private active: IndexFacts | null = null;

  constructor(
    private readonly pc: Pinecone,
    private readonly cfg: PineconeStoreConfig,
    private mode: EmbeddingMode,
  ) {}

  setMode(mode: EmbeddingMode): void {
    this.mode = mode;
  }

  static fromApiKey(apiKey: string, cfg: PineconeStoreConfig, mode: EmbeddingMode): PineconeStore {
    return new PineconeStore(new Pinecone({ apiKey }), cfg, mode);
  }

  // ---------- IndexManager ----------

  async describe(name: string): Promise<IndexFacts | null> {
    try {
      return toIndexFacts(await this.pc.indexes.describe(name));
    } catch (err) {
      if (err instanceof Errors.PineconeNotFoundError) return null;
      throw err;
    }
  }

  async create(name: string): Promise<IndexFacts> {
    const spec = { serverless: { cloud: this.cfg.cloud, region: this.cfg.region } };
    try {
      const mode = this.mode;
      const created = isExternal(mode)
        ? await this.pc.indexes.create({ name, dimension: mode.dimension, metric: 'cosine', spec, waitUntilReady: false })
        : mode.provider === 'pinecone'
          ? await this.pc.indexes.createForModel({ name, cloud: this.cfg.cloud, region: this.cfg.region, embed: { model: mode.model, fieldMap: { text: RECORD_FIELDS.text } }, waitUntilReady: false })
          : null;
      if (!created) throw badRequest(`Cannot create a Pinecone index for ${describeMode(mode)}`);
      return toIndexFacts(created);
    } catch (err) {
      if (err instanceof Errors.PineconeConflictError) throw new HttpError(409, err.message);
      throw err;
    }
  }

  async waitUntilReady(name: string, timeoutMs = READY_TIMEOUT_MS): Promise<IndexFacts> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const facts = await this.describe(name);
      if (!facts) throw new Error(`Index "${name}" disappeared while waiting for it to become ready`);
      if (facts.ready) return facts;
      if (/Failed/i.test(facts.state)) throw new Error(`Index "${name}" failed to initialise (${facts.state})`);
      if (Date.now() > deadline) throw new Error(`Index "${name}" was still ${facts.state} after ${Math.round(timeoutMs / 1000)} s`);
      await sleep(READY_POLL_MS);
    }
  }

  use(index: IndexFacts): void {
    this.active = index;
  }

  // ---------- VectorStore ----------

  async upsertRecords(namespace: string, records: StoreRecord[]): Promise<void> {
    if (records.length === 0) return;
    if (isExternal(this.mode)) return this.upsertVectors(namespace, records, this.mode);
    const textField = this.textField();
    await this.index(namespace).upsertRecords({ records: records.map((r) => toIndexRecord(r, textField)) });
  }

  async deleteByPrefix(namespace: string, prefix: string, keepBelow: number): Promise<number> {
    const stale = (await this.listIds(namespace, prefix)).filter((id) => chunkIndexOf(id, prefix) >= keepBelow);
    await this.deleteIds(namespace, stale);
    return stale.length;
  }

  async deleteExcept(namespace: string, keep: ReadonlySet<string>): Promise<number> {
    const stale = (await this.listIds(namespace)).filter((id) => id !== SENTINEL_ID && !keep.has(id));
    await this.deleteIds(namespace, stale);
    return stale.length;
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    if (isExternal(this.mode)) return this.searchVectors(params, this.mode);
    const started = performance.now();
    const textField = this.textField();
    const res = await this.index(params.namespace).searchRecords({
      query: { topK: params.topK, inputs: { text: params.query }, filter: params.filter },
      fields: Array.from(new Set([textField, ...Object.values(RECORD_FIELDS), 'sha', 'short_sha', 'author', 'authored_at', 'subject', 'paths', 'is_merge', 'files_changed'])),
      rerank: params.rerank ? { model: this.cfg.rerankModel, rankFields: [textField], topN: params.topK } : undefined,
    });
    return {
      hits: res.result.hits.map((hit) => toSearchHit(hit._id, hit._score, hit.fields as Record<string, unknown>, textField)),
      usage: { readUnits: res.usage.readUnits, embedTotalTokens: res.usage.embedTotalTokens, rerankUnits: res.usage.rerankUnits },
      tookMs: Math.round(performance.now() - started),
      namespace: params.namespace,
    };
  }

  async readSentinel(namespace: string): Promise<Sentinel | null> {
    try {
      const res = await this.index(namespace).fetch({ ids: [SENTINEL_ID] });
      return parseSentinel(res.records?.[SENTINEL_ID]?.metadata?.[SENTINEL_FIELD]);
    } catch (err) {
      if (err instanceof Errors.PineconeNotFoundError) return null;
      throw err;
    }
  }

  async writeSentinel(namespace: string, sentinel: Sentinel): Promise<void> {
    const fields = { kind: 'sentinel', [SENTINEL_FIELD]: JSON.stringify(sentinel) };
    if (isExternal(this.mode)) {
      // Cosine indexes reject all-zero vectors; a unit vector is valid and never close to a real query in practice.
      const values = Array.from({ length: this.mode.dimension }, (_, i) => (i === 0 ? 1 : 0));
      await this.index(namespace).upsert({ records: [{ id: SENTINEL_ID, values, metadata: fields }] });
      return;
    }
    await this.index(namespace).upsertRecords({ records: [{ _id: SENTINEL_ID, [this.textField()]: SENTINEL_TEXT, ...fields }] });
  }

  async stats(): Promise<IndexStats> {
    const active = this.requireActive();
    const stats = await this.index('__default__').describeIndexStats();
    const namespaces = Object.entries(stats.namespaces ?? {})
      .map(([name, ns]) => ({ name, recordCount: ns.recordCount }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      indexName: active.name,
      dimension: stats.dimension ?? active.dimension,
      totalRecordCount: stats.totalRecordCount ?? namespaces.reduce((n, ns) => n + ns.recordCount, 0),
      namespaces,
    };
  }

  async deleteNamespace(namespace: string): Promise<void> {
    try {
      await this.index(namespace).deleteAll();
    } catch (err) {
      // A namespace that was never written does not exist; it is already empty.
      if (!(err instanceof Errors.PineconeNotFoundError)) throw err;
    }
  }

  async close(): Promise<void> {}

  // ---------- external embedding data plane ----------

  private async upsertVectors(namespace: string, records: StoreRecord[], mode: ExternalMode): Promise<void> {
    const texts = records.map((r) => String(r[RECORD_FIELDS.text] ?? ''));
    const { vectors } = await mode.client.embed(mode.model, texts, mode.dimensions);
    await this.index(namespace).upsert({ records: records.map((r, i) => ({ id: r._id, values: vectors[i] ?? [], metadata: metadataOf(r) })) });
  }

  private async searchVectors(params: SearchParams, mode: ExternalMode): Promise<SearchResponse> {
    const started = performance.now();
    const { vectors, tokens } = await mode.client.embed(mode.model, [params.query], mode.dimensions);
    const candidates = params.rerank ? Math.min(RERANK_CANDIDATE_CAP, Math.max(params.topK * 4, 20)) : params.topK;
    const res = await this.index(params.namespace).query({ vector: vectors[0] ?? [], topK: candidates, includeMetadata: true, filter: params.filter });
    const found = res.matches.map(toVectorHit);
    const { hits, rerankUnits } = params.rerank && found.length > 0 ? await this.rerank(params, found) : { hits: found, rerankUnits: undefined };
    return {
      hits,
      usage: { readUnits: res.usage?.readUnits ?? 0, embedTotalTokens: tokens, rerankUnits },
      tookMs: Math.round(performance.now() - started),
      namespace: params.namespace,
    };
  }

  private async rerank(params: SearchParams, hits: SearchHit[]): Promise<{ hits: SearchHit[]; rerankUnits?: number }> {
    const ranked = await this.pc.inference.rerank({
      model: this.cfg.rerankModel,
      query: params.query,
      documents: hits.map((h) => ({ text: h.text })),
      rankFields: ['text'],
      topN: params.topK,
      returnDocuments: false,
    });
    const reordered = ranked.data.map((d) => (hits[d.index] ? { ...hits[d.index]!, score: d.score } : null)).filter((h): h is SearchHit => h !== null);
    return { hits: reordered, rerankUnits: ranked.usage?.rerankUnits };
  }

  // ---------- internals ----------

  private async listIds(namespace: string, prefix?: string): Promise<string[]> {
    const idx = this.index(namespace);
    const ids: string[] = [];
    try {
      let token: string | undefined;
      do {
        const page = await idx.listPaginated({ ...(prefix ? { prefix } : {}), limit: LIST_PAGE_SIZE, paginationToken: token });
        for (const v of page.vectors ?? []) if (typeof v.id === 'string') ids.push(v.id);
        token = page.pagination?.next;
      } while (token);
    } catch (err) {
      if (err instanceof Errors.PineconeNotFoundError) return [];
      throw err;
    }
    return ids;
  }

  private async deleteIds(namespace: string, ids: string[]): Promise<void> {
    const idx = this.index(namespace);
    for (let i = 0; i < ids.length; i += DELETE_BATCH_SIZE) await idx.deleteMany({ ids: ids.slice(i, i + DELETE_BATCH_SIZE) });
  }

  private index(namespace: string) {
    const active = this.requireActive();
    return this.pc.index({ name: active.name, host: active.host, namespace });
  }

  /** The record field the active index embeds: chunk_text for indexes this tool creates, usually "text" for console-made ones. */
  private textField(): string {
    return this.requireActive().textField ?? RECORD_FIELDS.text;
  }

  private requireActive(): IndexFacts {
    if (!this.active) throw unavailable('No Pinecone index selected');
    return this.active;
  }
}

export function toIndexFacts(model: IndexModel): IndexFacts {
  const fields = Object.entries(model.schema?.fields ?? {}) as Array<[string, { type?: string; dimension?: number; metric?: string }]>;
  const dense = fields.find(([, f]) => f.type === 'dense_vector');
  const semantic = fields.find(([, f]) => f.type === 'semantic_text');
  const embedModel = model.embed?.model ?? null;
  return {
    name: model.name,
    state: model.status.state,
    ready: model.status.ready,
    embedModel,
    textField: embedModel ? (model.embed?.fieldMap?.text ?? semantic?.[0] ?? null) : null,
    dimension: model.dimension ?? dense?.[1].dimension,
    metric: model.metric ?? dense?.[1].metric,
    host: model.host,
  };
}

/** Rename this tool's text field to the one the index embeds, leaving metadata untouched. */
export function toIndexRecord(record: StoreRecord, textField: string): StoreRecord {
  if (textField === RECORD_FIELDS.text) return record;
  const { [RECORD_FIELDS.text]: text, ...rest } = record;
  return { ...rest, [textField]: text } as StoreRecord;
}

function toVectorHit(match: ScoredPineconeRecord): SearchHit {
  return toSearchHit(match.id, match.score ?? 0, (match.metadata ?? {}) as Record<string, unknown>);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
