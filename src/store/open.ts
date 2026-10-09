import path from 'node:path';
import { slug, type Config } from '../config';
import { openAIClient, openRouterClient, type EmbeddingClient } from '../embed/client';
import { describeMode, gradeIndex, isExternal, modeIdentity, type EmbeddingMode } from '../embed/mode';
import { ConfigError } from '../errors';
import { currentBranch, isGitCheckout, originRepo } from '../git/files';
import type { EmbeddingIdentity } from '../index/run';
import type { Logger } from '../log';
import type { EmbeddingProviderName, IndexFacts, Sentinel } from '../types';
import { MemoryStore } from './memory';
import { PineconeStore } from './pinecone';
import { PostgresStore } from './postgres';
import type { Backend } from './types';

export interface Identity {
  /** owner/name, or a folder name when there is no remote. */
  repo: string;
  branch: string;
  index: string;
  namespace: string;
  historyNamespace: string;
}

/**
 * Work out repository, branch, index and namespace. Explicit env values win;
 * then GitHub's variables; then the checkout (origin remote, current branch),
 * so a laptop and CI agree on the namespace without extra settings.
 */
export async function resolveIdentity(cfg: Config, root: string | null, branchOverride?: string): Promise<Identity> {
  const git = root !== null && (await isGitCheckout(root));
  // The folder name is a last resort for a checkout with no origin remote; a plain folder (a container's /app) names nothing.
  const repo = cfg.repo ?? cfg.githubRepository ?? (git ? ((await originRepo(root!)) ?? path.basename(root!)) : null);
  let branch = branchOverride ?? cfg.branch ?? cfg.githubRefName ?? (git ? await currentBranch(root!) : null);
  if (branch === 'HEAD') branch = null;

  const index = cfg.index ?? (repo ? slug(repo.split('/').pop()!, 45) : null);
  if (!index) throw new ConfigError('Cannot name the index: set REPO_VECTOR_INDEX, or REPO_VECTOR_REPO (owner/name)');
  if (cfg.namespace && !branchOverride) {
    return { repo: repo ?? index, branch: branch ?? 'unknown', index, namespace: cfg.namespace, historyNamespace: `${cfg.namespace}-history` };
  }
  if (!repo || !branch) {
    throw new ConfigError('Cannot name the namespace: set REPO_VECTOR_NAMESPACE, or REPO_VECTOR_REPO and REPO_VECTOR_BRANCH (a detached HEAD has no branch)');
  }
  const namespace = defaultNamespace(repo, branch);
  return { repo, branch, index, namespace, historyNamespace: `${namespace}-history` };
}

/** `<owner>-<repo>--<branch>`, or `<folder>--<branch>` without an owner; slugged and within Pinecone's limits. */
export function defaultNamespace(repo: string, branch: string): string {
  const [owner, name] = repo.includes('/') ? repo.split('/') : [null, repo];
  const left = owner ? `${slug(owner)}-${slug(name!)}` : slug(name!);
  return `${left}--${slug(branch)}`;
}

/** Throughput default per provider: Pinecone Starter allows 250k tokens per minute per model; the others are unpaced. */
export function defaultPace(cfg: Config, provider: Sentinel['provider']): number | null {
  return cfg.embedding.tokensPerMinute ?? (provider === 'pinecone' ? 250_000 : null);
}

function clientFor(cfg: Config, provider: 'openrouter' | 'openai'): EmbeddingClient {
  if (provider === 'openrouter') {
    if (!cfg.embedding.openrouterApiKey) throw new ConfigError('OPENROUTER_API_KEY is required: this index is embedded with OpenRouter');
    return openRouterClient(cfg.embedding.openrouterApiKey, cfg.embedding.openrouterDataCollection);
  }
  if (!cfg.embedding.openaiApiKey) throw new ConfigError('OPENAI_API_KEY is required: this index is embedded with OpenAI');
  return openAIClient(cfg.embedding.openaiApiKey, cfg.embedding.openaiBaseUrl);
}

/** Build the embedding mode; an external model's dimension comes from `knownDimension` or one probe request. */
export async function buildMode(cfg: Config, provider: EmbeddingProviderName, model: string, knownDimension?: number | null, dimensions?: number | null): Promise<EmbeddingMode> {
  if (provider === 'pinecone') {
    if (cfg.store !== 'pinecone') throw new ConfigError('Pinecone-hosted embedding needs REPO_VECTOR_STORE=pinecone');
    return { provider, model };
  }
  const client = clientFor(cfg, provider);
  const requested = dimensions ?? undefined;
  const dimension = knownDimension ?? (await client.probeDimension(model, requested));
  return { provider, model, dimension, dimensions: requested, client };
}

/** A backend for the configured store, not yet pointed at an index. Postgres is migrated on open. */
export async function makeBackend(cfg: Config, mode: EmbeddingMode): Promise<Backend> {
  if (cfg.store === 'pinecone') {
    return PineconeStore.fromApiKey(cfg.pineconeApiKey!, { cloud: cfg.cloud, region: cfg.region, rerankModel: cfg.rerankModel }, mode);
  }
  const store = PostgresStore.fromUrl(cfg.databaseUrl!, mode);
  try {
    await store.migrate();
  } catch (err) {
    await store.close();
    throw err;
  }
  return store;
}

export interface Opened {
  backend: Backend;
  index: IndexFacts;
  mode: EmbeddingMode;
  embedding: EmbeddingIdentity;
}

/**
 * Open the store for writing: build the mode from env, find or create the
 * index, and refuse an index that cannot hold this model's vectors.
 */
export async function openForIndexing(cfg: Config, identity: Identity, log: Logger, backendOverride?: Backend): Promise<Opened> {
  const { provider, model } = cfg.embedding;
  if (!provider) throw new ConfigError('REPO_VECTOR_EMBEDDING_PROVIDER is required for indexing: pinecone, openrouter or openai');
  if (!model) throw new ConfigError('REPO_VECTOR_EMBEDDING_MODEL is required for indexing, e.g. llama-text-embed-v2 or openai/text-embedding-3-small');
  const mode = await buildMode(cfg, provider, model, undefined, cfg.embedding.dimensions);
  const backend = backendOverride ?? (await makeBackend(cfg, mode));
  backend.setMode(mode);
  try {
    let index = await backend.describe(identity.index);
    if (!index) {
      if (backend.kind === 'pinecone' && !cfg.createIndex) {
        throw new ConfigError(`Pinecone index "${identity.index}" does not exist. Create it, or set REPO_VECTOR_CREATE_INDEX=true to let the action create one for ${describeMode(mode)}`);
      }
      log.info(`Creating index ${identity.index} for ${describeMode(mode)}`);
      index = await backend.create(identity.index);
    }
    if (!index.ready) {
      log.info(`Waiting for index ${identity.index} to become ready`);
      index = await backend.waitUntilReady(identity.index);
    }
    const grade = gradeIndex(index, mode);
    if (!grade.usable) throw new ConfigError(`Index "${identity.index}" cannot be used with ${describeMode(mode)}: ${grade.reason}`);
    backend.use(index);
    return { backend, index, mode, embedding: { ...modeIdentity(mode, index), dimensions: isExternal(mode) ? (mode.dimensions ?? null) : null } };
  } catch (err) {
    if (!backendOverride) await backend.close();
    throw err;
  }
}

/**
 * Open the store for searching. The embedding provider and model default to
 * what the code sentinel recorded, so a consumer needs only store credentials
 * plus the provider key; explicit env values must agree with the sentinel.
 */
export async function openForQuery(cfg: Config, identity: Identity, backendOverride?: Backend): Promise<Opened & { sentinel: Sentinel | null }> {
  const backend = backendOverride ?? (await makeBackend(cfg, { provider: 'memory' }));
  try {
    const index = await backend.describe(identity.index);
    if (!index) throw new ConfigError(`No index named "${identity.index}" in this ${cfg.store === 'pinecone' ? 'Pinecone project' : 'database'}. Has the indexing action run yet?`);
    backend.use(index);
    const sentinel = await backend.readSentinel(identity.namespace);
    if (backend.kind === 'memory') {
      return { backend, index, mode: { provider: 'memory' }, sentinel, embedding: { provider: 'memory', model: 'memory', dimension: null, dimensions: null } };
    }
    const provider = cfg.embedding.provider ?? sentinel?.provider ?? (index.embedModel ? 'pinecone' : null);
    const model = cfg.embedding.model ?? sentinel?.model ?? index.embedModel;
    if (!provider || !model || provider === 'memory') {
      throw new ConfigError(`Namespace "${identity.namespace}" has not been indexed yet, so its embedding model is unknown. Run the action, or set REPO_VECTOR_EMBEDDING_PROVIDER and REPO_VECTOR_EMBEDDING_MODEL`);
    }
    if (sentinel && (sentinel.provider !== provider || sentinel.model !== model)) {
      throw new ConfigError(`Namespace "${identity.namespace}" was indexed with ${sentinel.provider} ${sentinel.model}, but the environment asks for ${provider} ${model}. Unset REPO_VECTOR_EMBEDDING_PROVIDER/MODEL to use the indexed model.`);
    }
    const sameModel = sentinel?.model === model;
    const dimensions = cfg.embedding.dimensions ?? (sameModel ? (sentinel?.dimensions ?? null) : null);
    const knownDimension = sameModel ? (sentinel?.dimension ?? index.dimension) : undefined;
    const mode = await buildMode(cfg, provider, model, knownDimension, dimensions);
    const grade = gradeIndex(index, mode);
    if (!grade.usable) throw new ConfigError(`Index "${identity.index}" cannot be searched with ${describeMode(mode)}: ${grade.reason}`);
    backend.setMode(mode);
    return { backend, index, mode, sentinel, embedding: { ...modeIdentity(mode, index), dimensions: dimensions ?? null } };
  } catch (err) {
    if (!backendOverride) await backend.close();
    throw err;
  }
}

/** For tests and dry runs: an in-memory backend that grades as usable for anything. */
export function memoryBackend(name: string): Backend {
  return new MemoryStore(name);
}
