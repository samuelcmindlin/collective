import type { Criterion, CheckResult } from './types.js';
import { createHash } from 'node:crypto';
import { stable } from '../application/commands.js';

export const hashRecord = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
export const MAX_CHECK_BYTES = 250_000;

/** Protected data checks only. Never evaluate code or resolve candidate-controlled references. */
export function checkJsonFields(bytes: Buffer, criterion: Extract<Criterion, { method: 'json.fields.v1' }>): Omit<CheckResult['results'][number], 'evidenceId'> {
  if (bytes.length > MAX_CHECK_BYTES) return { status: 'error', message: 'JSON check input exceeds 250 KB.' };
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return { status: 'fail', message: 'Evidence is not valid UTF-8 JSON.' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'fail', message: 'Evidence must be a JSON object.' };
  const record = value as Record<string, unknown>;
  for (const field of criterion.fields) {
    const item = record[field.name];
    const valid = Object.hasOwn(record, field.name) && (
      field.type === 'array' ? Array.isArray(item) :
      field.type === 'object' ? !!item && typeof item === 'object' && !Array.isArray(item) :
      field.type === 'string' ? typeof item === 'string' && item.trim().length > 0 :
      field.type === 'number' ? typeof item === 'number' && Number.isFinite(item) : typeof item === 'boolean');
    if (!valid) return { status: 'fail', message: `Required field ${JSON.stringify(field.name)} must have type ${field.type}${field.type === 'string' ? ' (nonempty)' : ''}.` };
  }
  return { status: 'pass', message: 'Required JSON fields match the frozen types. Content meaning was not evaluated.' };
}
