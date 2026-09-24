import { z } from 'zod/v3';

const text = (max: number) => z.string().trim().min(1).max(max);
const key = text(100);
const criterionBase = { id: text(64).regex(/^[a-z][a-z0-9_-]*$/), description: text(1000) };
export const criterionSchema = z.discriminatedUnion('method', [
  z.object({ ...criterionBase, method: z.literal('judgment'), evidenceKind: z.enum(['artifact', 'knowledge', 'either']) }).strict(),
  z.object({ ...criterionBase, method: z.literal('json.fields.v1'), evidenceKind: z.literal('artifact'),
    fields: z.array(z.object({ name: text(100), type: z.enum(['string', 'number', 'boolean', 'array', 'object']) }).strict()).min(1).max(20),
  }).strict(),
]);
export const bindingSchema = z.object({ criterionId: key, evidenceIds: z.array(key).min(1).max(20) }).strict();
export const verdictSchema = z.object({ criterionId: key, verdict: z.enum(['pass', 'fail', 'uncertain']), evidenceIds: z.array(key).min(1).max(20), rationale: text(2000) }).strict();
export const progressSchemas = {
  task_get: z.object({ taskId: key, submissionId: key.optional(), offset: z.number().int().min(0).max(100000).default(0) }).strict(),
  task_evidence_read: z.object({ submissionId: key, evidenceId: key, offset: z.number().int().min(0).max(5000000).default(0), maxChars: z.number().int().min(1).max(12000).default(8000) }).strict(),
};
