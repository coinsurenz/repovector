import { loadConfig, type Config, type Env } from './config';
import { badRequest } from './errors';
import { matches, parseFilter } from './store/filter';
import { defaultNamespace, openForQuery, resolveIdentity, type Identity, type Opened } from './store/open';
import type { Backend } from './store/types';
import type { Filter, IndexStats, SearchResponse, Sentinel } from './types';

export interface CodeSearchRequest {
  query: string;
  topK?: number;
  /** Search another branch's namespace in the same index. */
  branch?: string;
  language?: string;
  ext?: string;
  fileName?: string;
  symbolKind?: string;
  /** Only hits whose path starts with this (applied to a wider candidate set, since neither store filters by prefix). */
  pathPrefix?: string;
  /** Extra Pinecone-style metadata filter, ANDed with the above. */
  filter?: Filter;
  /** Pinecone store only. */
  rerank?: boolean;
}

export interface HistorySearchRequest {
  query: string;
  topK?: number;
  branch?: string;
  /** ISO date or date-time; commits authored on or after. */
  since?: string;
  /** ISO date or date-time; commits authored on or before. */
  until?: string;
  /** Exact author name. */
  author?: string;
}

export interface StatusResponse {
  repo: string;
  branch: string;
  index: string;
  store: Config['store'];
  namespace: string;
  historyNamespace: string;
  embedding: { provider: string; model: string; dimension: number | null };
  code: Sentinel | null;
  history: Sentinel | null;
  stats: IndexStats;
}

export interface ClientOptions {
  env?: Env;
  /** Checkout used to infer repository and branch; null for none (the HTTP server). Defaults to the configured root. */
  root?: string | null;
  branch?: string;
  /** Tests inject a store. */
  backend?: Backend;
  /** Never run schema migrations, so a SELECT-only database role is enough (the HTTP server sets this). */
  readOnly?: boolean;
}

/** Search a repository index from code: what the CLI, HTTP server and MCP server all wrap. */
export class RepoVectorClient {
  constructor(
    private readonly cfg: Config,
    readonly identity: Identity,
    private readonly opened: Opened & { sentinel: Sentinel | null },
  ) {}

  get store(): Backend {
    return this.opened.backend;
  }

  async search(req: CodeSearchRequest): Promise<SearchResponse> {
    const topK = this.topK(req.topK);
    const conditions: Filter[] = [{ kind: { $eq: 'code' } }];
    if (req.language) conditions.push({ language: { $eq: req.language } });
    if (req.ext) conditions.push({ ext: { $eq: req.ext.replace(/^\./, '').toLowerCase() } });
    if (req.fileName) conditions.push({ file_name: { $eq: req.fileName } });
    if (req.symbolKind) conditions.push({ symbol_kind: { $eq: req.symbolKind } });
    if (req.filter) {
      parseFilter(req.filter); // reject unsupported operators up front, on every store
      conditions.push(req.filter);
    }
    const prefix = req.pathPrefix?.replace(/^\.?\//, '');
    const candidates = prefix ? Math.min(topK * 3, this.cfg.server.topKMax) : topK;
    const res = await this.store.search({ query: req.query, topK: candidates, namespace: this.namespaceFor(req.branch), filter: { $and: conditions }, rerank: req.rerank });
    return prefix ? { ...res, hits: res.hits.filter((h) => h.source.startsWith(prefix)).slice(0, topK) } : res;
  }

  async searchHistory(req: HistorySearchRequest): Promise<SearchResponse> {
    const conditions: Filter[] = [{ kind: { $eq: 'commit' } }];
    if (req.since) conditions.push({ authored_ts: { $gte: toEpoch(req.since, 'since') } });
    if (req.until) conditions.push({ authored_ts: { $lte: toEpoch(req.until, 'until', true) } });
    if (req.author) conditions.push({ author: { $eq: req.author } });
    const res = await this.store.search({ query: req.query, topK: this.topK(req.topK), namespace: `${this.namespaceFor(req.branch)}-history`, filter: { $and: conditions } });
    // Defensive: a store that ignored a range would be caught here rather than returning wrong commits.
    const parsed = parseFilter({ $and: conditions });
    return { ...res, hits: res.hits.filter((h) => matches(h.metadata, parsed)) };
  }

  async status(): Promise<StatusResponse> {
    const [code, history, stats] = await Promise.all([
      this.store.readSentinel(this.identity.namespace),
      this.store.readSentinel(this.identity.historyNamespace),
      this.store.stats(),
    ]);
    return {
      repo: this.identity.repo,
      branch: this.identity.branch,
      index: this.identity.index,
      store: this.cfg.store,
      namespace: this.identity.namespace,
      historyNamespace: this.identity.historyNamespace,
      embedding: { provider: this.opened.embedding.provider, model: this.opened.embedding.model, dimension: this.opened.embedding.dimension },
      code,
      history,
      stats,
    };
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private namespaceFor(branch: string | undefined): string {
    if (!branch || branch === this.identity.branch) return this.identity.namespace;
    if (this.cfg.namespace) throw badRequest('REPO_VECTOR_NAMESPACE is fixed on this server, so another branch cannot be searched');
    return defaultNamespace(this.identity.repo, branch);
  }

  private topK(requested: number | undefined): number {
    const topK = requested ?? 10;
    if (!Number.isInteger(topK) || topK < 1) throw badRequest('topK must be a positive integer');
    return Math.min(topK, this.cfg.server.topKMax);
  }
}

export async function createClient(opts: ClientOptions = {}): Promise<RepoVectorClient> {
  const cfg = loadConfig(opts.env ?? process.env);
  const root = opts.root === undefined ? cfg.indexing.root : opts.root;
  const identity = await resolveIdentity(cfg, root, opts.branch);
  const opened = await openForQuery(cfg, identity, opts.backend, { readOnly: opts.readOnly });
  return new RepoVectorClient(cfg, identity, opened);
}

function toEpoch(value: string, name: string, endOfDay = false): number {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const ms = Date.parse(dateOnly ? `${value}T${endOfDay ? '23:59:59' : '00:00:00'}Z` : value);
  if (Number.isNaN(ms)) throw badRequest(`${name} must be an ISO date such as 2026-01-31`);
  return Math.floor(ms / 1000);
}
