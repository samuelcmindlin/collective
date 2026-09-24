import assert from 'node:assert/strict';
import { z } from 'zod/v3';

export const MCP_SCOPE_PREFIX = 'COLLECTIVE_MCP_SCOPE_V1 ';
const result = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() }).strict()).length(1), isError: z.boolean().optional() }).strict();
const schema = z.object({
  configuredServers: z.array(z.string()), gatewayEnvironmentPresent: z.literal(true),
  observations: z.array(z.object({
    name: z.enum(['mcp-gateway', 'ambient-gateway']), endpoint: z.string().url(),
    tools: z.array(z.object({ name: z.string(), inputSchema: z.unknown() }).strict()), allowedResult: result,
    unlistedAttempts: z.array(z.object({ method: z.string(), result: result.optional(), rejected: z.boolean().optional(), error: z.string().optional() }).strict()).length(3),
  }).strict()).length(2),
}).strict();

export function verifyMcpScope(output: string) {
  const lines = output.trim().split('\n').filter(Boolean);
  const frames = lines.filter(line => line.startsWith(MCP_SCOPE_PREFIX));
  assert.equal(frames.length, 1, 'Expected exactly one MCP scope record');
  assert.ok(lines.every(line => line.startsWith(MCP_SCOPE_PREFIX) || /^Sandbox [a-z0-9-]+ started successfully$/.test(line)));
  const record = schema.parse(JSON.parse(frames[0]!.slice(MCP_SCOPE_PREFIX.length)));
  assert.deepEqual(record.configuredServers, ['mcp-gateway']);
  assert.deepEqual(record.observations.map(o => o.name).sort(), ['ambient-gateway', 'mcp-gateway']);
  for (const observation of record.observations) {
    assert.deepEqual(observation.tools.map(t => t.name).sort(), ['allowed_add', 'code-mode', 'mcp-exec']);
    assert.notEqual(observation.allowedResult.isError, true);
    assert.deepEqual(JSON.parse(observation.allowedResult.content[0]!.text), { server: 'allowed', sum: 5 });
    assert.deepEqual(observation.unlistedAttempts.map(a => a.method).sort(), ['code-mode', 'mcp-exec', 'unlisted_add']);
    const direct = observation.unlistedAttempts.find(a => a.method === 'unlisted_add')!;
    assert.equal(direct.rejected, true); assert.equal(direct.error, 'MCP error -32602: unknown tool "unlisted_add"');
    const dispatched = observation.unlistedAttempts.find(a => a.method === 'mcp-exec')!;
    assert.equal(dispatched.result?.isError, true);
    assert.equal(dispatched.result.content[0]!.text, 'Tool "unlisted_add" not found in gateway.');
    const codeMode = observation.unlistedAttempts.find(a => a.method === 'code-mode')!;
    // This gateway reports this denial as text without setting isError.
    assert.equal(codeMode.result?.content[0]!.text, 'error: tools not found in gateway: unlisted_add');
  }
  return record;
}
