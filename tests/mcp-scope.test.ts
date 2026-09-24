import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MCP_SCOPE_PREFIX, verifyMcpScope } from '../scripts/mcp-scope-protocol.js';

const evidence = JSON.parse(readFileSync(new URL('../docs/mcp-scope-results.json', import.meta.url), 'utf8'));
const frame = (record: unknown) => MCP_SCOPE_PREFIX + JSON.stringify(record);

test('MCP scope acceptance requires usable allowed tools and all explicit denial paths', () => {
  verifyMcpScope(frame(evidence.beforeRestart)); verifyMcpScope(frame(evidence.afterRestart));
  for (const mutate of [
    (r: any) => { r.observations.pop(); },
    (r: any) => { r.observations[0].unlistedAttempts.pop(); },
    (r: any) => { r.observations[0].tools.push({ name: 'unlisted_add', inputSchema: {} }); },
    (r: any) => { r.observations[0].allowedResult.content[0].text = '{"server":"unlisted","sum":5}'; },
    (r: any) => { r.observations[0].unlistedAttempts[0].error = 'Request timed out'; },
  ]) { const record = structuredClone(evidence.beforeRestart); mutate(record); assert.throws(() => verifyMcpScope(frame(record))); }
});

test('code-mode success, generic errors and duplicate results cannot masquerade as scope denial', () => {
  for (const text of ['OK', 'Internal server error', '{"server":"unlisted","sum":5}']) {
    const record = structuredClone(evidence.beforeRestart);
    record.observations[0].unlistedAttempts.find((a: any) => a.method === 'code-mode').result.content[0].text = text;
    assert.throws(() => verifyMcpScope(frame(record)));
  }
  assert.throws(() => verifyMcpScope(frame(evidence.beforeRestart) + '\n' + frame(evidence.afterRestart)));
  assert.throws(() => verifyMcpScope('{}'));
});
