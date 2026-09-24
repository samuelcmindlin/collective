import assert from 'node:assert/strict';
import { z } from 'zod/v3';

const frame = 'COLLECTIVE_DOMAIN_V1 ';
const schema = z.object({ version: z.literal(1), results: z.array(z.object({ name: z.string(), isError: z.boolean(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string().max(100000) }).strict()).length(1),
}).strict()).min(1).max(8) }).strict();

/** Missing observations, transport errors and malformed replies cannot be denials. */
export function domainResults(stdout: string, expected: string[]) {
  const lines = stdout.trim().split('\n').map(line => line.trim()).filter(Boolean);
  // sbx emits this notice when exec automatically starts a stopped sandbox.
  const data = lines.filter(line => !/^Sandbox [a-z0-9-]+ started successfully$/.test(line));
  assert.equal(data.length, 1, 'Expected exactly one domain response frame.');
  assert.ok(data[0]!.startsWith(frame));
  const value = schema.parse(JSON.parse(data[0]!.slice(frame.length)));
  assert.deepEqual(value.results.map(r => r.name), expected, 'Domain observation inventory differs.');
  return value.results.map(result => ({ name: result.name, isError: result.isError, value: JSON.parse(result.content[0]!.text) as any }));
}
