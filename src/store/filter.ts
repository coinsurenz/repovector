import { badRequest } from '../errors';
import type { Filter, Scalar } from '../types';

export type RangeOp = '$gte' | '$lte' | '$gt' | '$lt';

export interface Condition {
  field: string;
  op: '$eq' | RangeOp;
  value: Scalar;
}

const RANGE_OPS: ReadonlySet<string> = new Set(['$gte', '$lte', '$gt', '$lt']);

/**
 * Flatten the Pinecone-style filter subset this tool uses into a list of
 * ANDed conditions. Anything else is refused rather than silently ignored,
 * so Postgres and memory never return results Pinecone would have filtered out.
 */
export function parseFilter(filter: Filter | undefined): Condition[] {
  if (!filter) return [];
  const out: Condition[] = [];
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$and') {
      if (!Array.isArray(condition)) throw badRequest('$and must be a list of filters');
      for (const part of condition) out.push(...parseFilter(part as Filter));
      continue;
    }
    if (key.startsWith('$')) throw badRequest(`Unsupported filter operator ${key}; use field: value, $eq, $gte, $lte, $gt, $lt or $and`);
    if (isObject(condition)) {
      for (const [op, value] of Object.entries(condition)) {
        if (op === '$eq') out.push({ field: key, op, value: scalar(key, value) });
        else if (RANGE_OPS.has(op)) {
          if (typeof value !== 'number') throw badRequest(`${op} on "${key}" needs a number`);
          out.push({ field: key, op: op as RangeOp, value });
        } else throw badRequest(`Unsupported operator ${op} on "${key}"; use $eq, $gte, $lte, $gt or $lt`);
      }
      continue;
    }
    out.push({ field: key, op: '$eq', value: scalar(key, condition) });
  }
  return out;
}

/** Evaluate conditions against a record's fields (memory store and client-side checks). */
export function matches(fields: Record<string, unknown>, conditions: Condition[]): boolean {
  return conditions.every(({ field, op, value }) => {
    const actual = fields[field];
    if (op === '$eq') return actual === value;
    if (typeof actual !== 'number' || typeof value !== 'number') return false;
    if (op === '$gte') return actual >= value;
    if (op === '$lte') return actual <= value;
    if (op === '$gt') return actual > value;
    return actual < value;
  });
}

function scalar(key: string, value: unknown): Scalar {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  throw badRequest(`Filter value for "${key}" must be a string, number or boolean`);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
