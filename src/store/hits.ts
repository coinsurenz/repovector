import { RECORD_FIELDS, type RecordKind, type SearchHit, type Sentinel, type StoreRecord } from '../types';

/** Shape a stored record (id, score, fields) into a search hit, reading the text from whichever field the index embeds. */
export function toSearchHit(id: string, score: number, fields: Record<string, unknown>, textField: string = RECORD_FIELDS.text): SearchHit {
  const kind = fields[RECORD_FIELDS.kind];
  return {
    id,
    score,
    text: asString(fields[textField] ?? fields[RECORD_FIELDS.text]),
    source: asString(fields[RECORD_FIELDS.source]),
    fileName: asString(fields[RECORD_FIELDS.fileName]),
    chunkIndex: asNumber(fields[RECORD_FIELDS.chunkIndex]),
    totalChunks: asNumber(fields[RECORD_FIELDS.totalChunks]),
    kind: (kind === 'commit' || kind === 'sentinel' ? kind : 'code') as RecordKind,
    language: optionalString(fields[RECORD_FIELDS.language]),
    symbol: optionalString(fields[RECORD_FIELDS.symbol]),
    symbolKind: optionalString(fields[RECORD_FIELDS.symbolKind]),
    startLine: optionalNumber(fields[RECORD_FIELDS.startLine]),
    endLine: optionalNumber(fields[RECORD_FIELDS.endLine]),
    commit: optionalString(fields[RECORD_FIELDS.commit]),
    branch: optionalString(fields[RECORD_FIELDS.branch]),
    metadata: fields,
  };
}

/** Everything but the id becomes metadata. */
export function metadataOf(record: StoreRecord): Record<string, string | number | boolean | string[]> {
  const { _id, ...rest } = record;
  return rest;
}

/** Sentinels travel as one JSON string field, so every store can hold them without schema changes. */
export const SENTINEL_FIELD = 'sentinel_json';

export function parseSentinel(value: unknown): Sentinel | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as Sentinel;
    return typeof parsed.sha === 'string' && typeof parsed.chunkerVersion === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

const optionalString = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const optionalNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const asString = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const asNumber = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
