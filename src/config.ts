import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { ConfigError } from './errors';
import type { EmbeddingProviderName } from './types';

const bool = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .refine((v) => ['true', 'false', '1', '0', 'yes', 'no'].includes(v), 'must be true or false')
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const schema = z.object({
  REPO_VECTOR_STORE: z.enum(['pinecone', 'postgres']).optional(),
  PINECONE_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  REPO_VECTOR_INDEX: z.string().optional(),
  REPO_VECTOR_NAMESPACE: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/, 'letters, digits, ".", "_" and "-" only, at most 128 characters').optional(),
  REPO_VECTOR_REPO: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must look like owner/name').optional(),
  REPO_VECTOR_BRANCH: z.string().optional(),
  REPO_VECTOR_CREATE_INDEX: bool.optional(),
  PINECONE_CLOUD: z.enum(['aws', 'gcp', 'azure']).default('aws'),
  PINECONE_REGION: z.string().default('us-east-1'),
  PINECONE_RERANK_MODEL: z.string().default('bge-reranker-v2-m3'),

  REPO_VECTOR_EMBEDDING_PROVIDER: z.enum(['pinecone', 'openrouter', 'openai']).optional(),
  REPO_VECTOR_EMBEDDING_MODEL: z.string().optional(),
  REPO_VECTOR_EMBEDDING_DIMENSIONS: int(1, 8192).optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  REPO_VECTOR_EMBED_TOKENS_PER_MINUTE: int(1000, 100_000_000).optional(),
  REPO_VECTOR_OPENROUTER_DATA_COLLECTION: z.enum(['deny', 'allow']).default('deny'),

  REPO_VECTOR_ROOT: z.string().optional(),
  GITHUB_WORKSPACE: z.string().optional(),
  REPO_VECTOR_EXCLUDE: z.string().optional(),
  REPO_VECTOR_MAX_FILE_KB: int(1, 65536).default(512),
  REPO_VECTOR_CHUNK_TARGET: int(200, 20000).default(1200),
  REPO_VECTOR_CHUNK_MAX: int(400, 40000).default(2400),
  REPO_VECTOR_BATCH_SIZE: int(1, 96).default(48),
  REPO_VECTOR_FULL_REINDEX: bool.optional(),
  REPO_VECTOR_MAX_DIFF_RATIO: z.coerce.number().min(0).max(1).default(0.4),
  REPO_VECTOR_HISTORY: bool.optional(),
  REPO_VECTOR_HISTORY_MAX_COMMITS: int(1, 1_000_000).default(20000),

  REPO_VECTOR_SERVER_TOKEN: z.string().optional(),
  REPO_VECTOR_SERVER_HOST: z.string().optional(),
  REPO_VECTOR_SERVER_PORT: int(1, 65535).default(8080),
  REPO_VECTOR_SERVER_CORS_ORIGIN: z.string().optional(),
  REPO_VECTOR_TOPK_MAX: int(1, 1000).default(100),

  GITHUB_REPOSITORY: z.string().optional(),
  GITHUB_REF_NAME: z.string().optional(),
  GITHUB_ACTIONS: z.string().optional(),
  REPO_VECTOR_IN_DOCKER: z.string().optional(),
});

export type StoreKind = 'pinecone' | 'postgres';

export interface Config {
  store: StoreKind;
  pineconeApiKey: string | null;
  databaseUrl: string | null;
  /** Explicit index name; null means derive it from the repository (see resolveIdentity). */
  index: string | null;
  /** Explicit namespace; null means derive it from repository and branch. */
  namespace: string | null;
  /** owner/name override for places without a checkout (the HTTP server). */
  repo: string | null;
  branch: string | null;
  createIndex: boolean;
  cloud: 'aws' | 'gcp' | 'azure';
  region: string;
  rerankModel: string;
  embedding: {
    /** Null on the query side means "take it from the sentinel". */
    provider: EmbeddingProviderName | null;
    model: string | null;
    dimensions: number | null;
    openrouterApiKey: string | null;
    openaiApiKey: string | null;
    openaiBaseUrl: string;
    /** Explicit pace; null means the provider default (250k for Pinecone hosted, unpaced otherwise). */
    tokensPerMinute: number | null;
    openrouterDataCollection: 'deny' | 'allow';
  };
  indexing: {
    root: string;
    exclude: string[];
    maxFileBytes: number;
    chunk: { target: number; max: number };
    batchSize: number;
    fullReindex: boolean;
    maxDiffRatio: number;
    history: boolean;
    historyMaxCommits: number;
  };
  server: {
    token: string | null;
    host: string;
    port: number;
    corsOrigin: string | null;
    topKMax: number;
  };
  /** Values that must never appear in a log; masked first thing in the action. */
  secrets: string[];
  githubRepository: string | null;
  githubRefName: string | null;
}

export type Env = Record<string, string | undefined>;

/** Parse and validate the environment. Every problem is reported at once. Empty strings count as unset. */
export function loadConfig(env: Env = process.env, cwd: string = process.cwd()): Config {
  const cleaned = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === undefined || v.trim() === '' ? undefined : v.trim()]));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration:\n  ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ')}`);
  }
  const e = parsed.data;
  const problems: string[] = [];
  if (!e.REPO_VECTOR_STORE) problems.push('REPO_VECTOR_STORE is required: pinecone or postgres');
  if (e.REPO_VECTOR_STORE === 'pinecone' && !e.PINECONE_API_KEY) problems.push('PINECONE_API_KEY is required when REPO_VECTOR_STORE=pinecone');
  if (e.REPO_VECTOR_STORE === 'postgres' && !e.DATABASE_URL) problems.push('DATABASE_URL is required when REPO_VECTOR_STORE=postgres');
  if (e.REPO_VECTOR_STORE === 'postgres' && e.REPO_VECTOR_EMBEDDING_PROVIDER === 'pinecone') {
    problems.push('REPO_VECTOR_EMBEDDING_PROVIDER=pinecone needs REPO_VECTOR_STORE=pinecone; Postgres cannot embed text, use openrouter or openai');
  }
  if (e.REPO_VECTOR_EMBEDDING_PROVIDER === 'openrouter' && !e.OPENROUTER_API_KEY) problems.push('OPENROUTER_API_KEY is required when REPO_VECTOR_EMBEDDING_PROVIDER=openrouter');
  if (e.REPO_VECTOR_EMBEDDING_PROVIDER === 'openai' && !e.OPENAI_API_KEY) problems.push('OPENAI_API_KEY is required when REPO_VECTOR_EMBEDDING_PROVIDER=openai');
  if (e.REPO_VECTOR_CHUNK_MAX < e.REPO_VECTOR_CHUNK_TARGET) problems.push('REPO_VECTOR_CHUNK_MAX must be at least REPO_VECTOR_CHUNK_TARGET');
  if (e.REPO_VECTOR_INDEX && e.REPO_VECTOR_STORE === 'pinecone' && !PINECONE_INDEX_RE.test(e.REPO_VECTOR_INDEX)) {
    problems.push('REPO_VECTOR_INDEX: Pinecone index names are lowercase letters, digits and hyphens, 1 to 45 characters');
  }
  if (problems.length > 0) throw new ConfigError(`Invalid configuration:\n  ${problems.join('\n  ')}`);

  const inDocker = e.REPO_VECTOR_IN_DOCKER === 'true';
  return {
    store: e.REPO_VECTOR_STORE!,
    pineconeApiKey: e.PINECONE_API_KEY ?? null,
    databaseUrl: e.DATABASE_URL ?? null,
    index: e.REPO_VECTOR_INDEX ?? null,
    namespace: e.REPO_VECTOR_NAMESPACE ?? null,
    repo: e.REPO_VECTOR_REPO ?? null,
    branch: e.REPO_VECTOR_BRANCH ?? null,
    createIndex: e.REPO_VECTOR_CREATE_INDEX ?? false,
    cloud: e.PINECONE_CLOUD,
    region: e.PINECONE_REGION,
    rerankModel: e.PINECONE_RERANK_MODEL,
    embedding: {
      provider: e.REPO_VECTOR_EMBEDDING_PROVIDER ?? null,
      model: e.REPO_VECTOR_EMBEDDING_MODEL ?? null,
      dimensions: e.REPO_VECTOR_EMBEDDING_DIMENSIONS ?? null,
      openrouterApiKey: e.OPENROUTER_API_KEY ?? null,
      openaiApiKey: e.OPENAI_API_KEY ?? null,
      openaiBaseUrl: e.OPENAI_BASE_URL.replace(/\/$/, ''),
      tokensPerMinute: e.REPO_VECTOR_EMBED_TOKENS_PER_MINUTE ?? null,
      openrouterDataCollection: e.REPO_VECTOR_OPENROUTER_DATA_COLLECTION,
    },
    indexing: {
      root: path.resolve(cwd, e.REPO_VECTOR_ROOT ?? e.GITHUB_WORKSPACE ?? '.'),
      exclude: (e.REPO_VECTOR_EXCLUDE ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      maxFileBytes: e.REPO_VECTOR_MAX_FILE_KB * 1024,
      chunk: { target: e.REPO_VECTOR_CHUNK_TARGET, max: e.REPO_VECTOR_CHUNK_MAX },
      batchSize: e.REPO_VECTOR_BATCH_SIZE,
      fullReindex: e.REPO_VECTOR_FULL_REINDEX ?? false,
      maxDiffRatio: e.REPO_VECTOR_MAX_DIFF_RATIO,
      history: e.REPO_VECTOR_HISTORY ?? true,
      historyMaxCommits: e.REPO_VECTOR_HISTORY_MAX_COMMITS,
    },
    server: {
      token: e.REPO_VECTOR_SERVER_TOKEN ?? null,
      host: e.REPO_VECTOR_SERVER_HOST ?? (inDocker ? '0.0.0.0' : '127.0.0.1'),
      port: e.REPO_VECTOR_SERVER_PORT,
      corsOrigin: e.REPO_VECTOR_SERVER_CORS_ORIGIN ?? null,
      topKMax: e.REPO_VECTOR_TOPK_MAX,
    },
    secrets: [e.PINECONE_API_KEY, e.DATABASE_URL, passwordOf(e.DATABASE_URL), e.OPENROUTER_API_KEY, e.OPENAI_API_KEY, e.REPO_VECTOR_SERVER_TOKEN].filter(
      (v): v is string => typeof v === 'string' && v !== '',
    ),
    githubRepository: e.GITHUB_REPOSITORY ?? null,
    githubRefName: e.GITHUB_REF_NAME ?? null,
  };
}

/** Pinecone index names: lowercase letters, digits and hyphens, 1 to 45 characters, no leading or trailing hyphen. */
export const PINECONE_INDEX_RE = /^[a-z0-9]([a-z0-9-]{0,43}[a-z0-9])?$/;

/** Lowercase; runs of anything outside [a-z0-9] become "-"; trimmed; at most `max` characters. */
export function slug(value: string, max = 40): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/** Hash of the settings that decide which records exist; stored in the sentinel so a change forces a full run. */
export function settingsHash(cfg: Pick<Config['indexing'], 'exclude' | 'maxFileBytes' | 'chunk'>): string {
  const canonical = JSON.stringify({ exclude: [...cfg.exclude].sort(), maxFileBytes: cfg.maxFileBytes, chunk: cfg.chunk });
  return createHash('sha1').update(canonical).digest('hex').slice(0, 12);
}

function passwordOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
}
