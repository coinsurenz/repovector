import type { IndexFacts } from '../types';
import type { EmbeddingClient } from './client';

/** Pinecone-hosted dense text embedding models usable with integrated inference. */
export const HOSTED_EMBED_MODELS = ['llama-text-embed-v2', 'multilingual-e5-large'] as const;

export type ExternalProvider = 'openrouter' | 'openai';

export interface ExternalMode {
  provider: ExternalProvider;
  model: string;
  /** Probed output size. */
  dimension: number;
  /** Requested truncation size, forwarded on every request. */
  dimensions?: number;
  client: EmbeddingClient;
}

/** How vectors are computed for one run. Fixed for the life of a store. */
export type EmbeddingMode = { provider: 'pinecone'; model: string } | { provider: 'memory' } | ExternalMode;

export const isExternal = (mode: EmbeddingMode): mode is ExternalMode => mode.provider === 'openrouter' || mode.provider === 'openai';

export interface IndexGrade {
  usable: boolean;
  reason?: string;
}

/** Can this index hold and search vectors produced under `mode`? Pure, so it is unit-tested directly. */
export function gradeIndex(index: IndexFacts, mode: EmbeddingMode): IndexGrade {
  switch (mode.provider) {
    case 'memory':
      return { usable: true };
    case 'pinecone':
      if (!index.embedModel) return { usable: false, reason: 'Stores raw vectors; Pinecone-hosted embedding needs an index created with a hosted model' };
      if (!index.textField) return { usable: false, reason: 'Does not declare which record field it embeds' };
      if (mode.model && index.embedModel !== mode.model) return { usable: false, reason: `Embeds with ${index.embedModel}, not ${mode.model}` };
      return { usable: true };
    case 'openrouter':
    case 'openai':
      if (index.embedModel) return { usable: false, reason: `Has its own hosted model (${index.embedModel}); external vectors need a vectors-only index` };
      if (index.dimension === undefined) return { usable: false, reason: 'Dimension unknown' };
      if (index.dimension !== mode.dimension) return { usable: false, reason: `Dimension ${index.dimension} does not match ${mode.model} (${mode.dimension})` };
      return { usable: true };
  }
}

export function describeMode(mode: EmbeddingMode): string {
  if (isExternal(mode)) return `${mode.provider === 'openai' ? 'OpenAI' : 'OpenRouter'} ${mode.model} (${mode.dimension} dimensions)`;
  if (mode.provider === 'memory') return 'the in-memory test store';
  return `Pinecone-hosted ${mode.model}`;
}

/** Model name and dimension as recorded in a sentinel. */
export function modeIdentity(mode: EmbeddingMode, index: IndexFacts): { provider: 'pinecone' | ExternalProvider | 'memory'; model: string; dimension: number | null } {
  if (isExternal(mode)) return { provider: mode.provider, model: mode.model, dimension: mode.dimension };
  if (mode.provider === 'memory') return { provider: 'memory', model: 'memory', dimension: null };
  return { provider: 'pinecone', model: index.embedModel ?? mode.model, dimension: index.dimension ?? null };
}
