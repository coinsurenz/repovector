import { badRequest } from '../errors';

/** Physical table for a logical index; names are quoted identifiers but kept to a safe alphabet anyway. */
export function tableNameFor(indexName: string): string {
  const safe = indexName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 56);
  if (safe === '') throw badRequest(`Index name "${indexName}" has no usable characters`);
  return `vec_${safe}`;
}

/** pgvector text form of a vector: `[0.1,0.2,...]`. */
export function vectorLiteral(values: number[]): string {
  return `[${values.map((v) => (Number.isFinite(v) ? v.toString() : '0')).join(',')}]`;
}

/** jsonb metadata keys become SQL text; refuse anything that is not a plain identifier-ish name. */
export function safeKey(key: string): string {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) throw badRequest(`Filter field "${key}" is not a valid metadata name`);
  return key;
}
