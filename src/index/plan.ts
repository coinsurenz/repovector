import type { Sentinel } from '../types';

export type RunMode = 'full' | 'incremental' | 'skipped';

export interface ModeDecision {
  mode: RunMode;
  reason: string;
}

/** What this run would write, compared with what the sentinel says the last run wrote. */
export interface CurrentSettings {
  head: string;
  chunkerVersion: string;
  settings: string;
  provider: string;
  model: string;
  dimension: number | null;
  dimensions: number | null;
}

export interface ModeInputs {
  sentinel: Sentinel | null;
  current: CurrentSettings;
  forceFull: boolean;
  /** Whether the sentinel SHA is an ancestor of HEAD in this clone. Ignored without a sentinel. */
  sentinelIsAncestor: boolean;
}

/**
 * Decide how much work a run needs, before looking at the diff. Pure, so every
 * branch is unit-tested. The diff-size threshold is applied afterwards (diffTooLarge).
 */
export function chooseMode({ sentinel, current, forceFull, sentinelIsAncestor }: ModeInputs): ModeDecision {
  if (!sentinel) return { mode: 'full', reason: 'first run for this namespace' };
  if (forceFull) return { mode: 'full', reason: 'REPO_VECTOR_FULL_REINDEX is set' };
  if (sentinel.chunkerVersion !== current.chunkerVersion) return { mode: 'full', reason: `chunker changed (${sentinel.chunkerVersion} to ${current.chunkerVersion})` };
  if (sentinel.settings !== current.settings) return { mode: 'full', reason: 'indexing settings changed (excludes, size cap or chunk sizes)' };
  if (sentinel.provider !== current.provider || sentinel.model !== current.model) {
    return { mode: 'full', reason: `embedding model changed (${sentinel.provider} ${sentinel.model} to ${current.provider} ${current.model})` };
  }
  if ((sentinel.dimension ?? null) !== current.dimension || (sentinel.dimensions ?? null) !== current.dimensions) {
    return { mode: 'full', reason: `vector dimension changed (${sentinel.dimension} to ${current.dimension})` };
  }
  if (sentinel.sha === current.head) return { mode: 'skipped', reason: `already indexed at ${current.head.slice(0, 7)}` };
  if (!sentinelIsAncestor) return { mode: 'full', reason: `last indexed commit ${sentinel.sha.slice(0, 7)} is not in this branch's history (force push, rebase, or a shallow clone)` };
  return { mode: 'incremental', reason: `changes since ${sentinel.sha.slice(0, 7)}` };
}

/** Above this share of tracked files changed, a full run is cheaper to reason about than a diff. */
export function diffTooLarge(entries: number, trackedFiles: number, maxRatio: number): boolean {
  return trackedFiles > 0 && entries / trackedFiles > maxRatio;
}
