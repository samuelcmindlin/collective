import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMcpLaunch, environmentMcpLaunch } from '../src/mcp-launch.js';
import { runWorkCycle, workCycleSchema } from '../scripts/scenarios/work-cycle.js';
import { domainResults } from '../scripts/domain-bridge-protocol.js';

test('the real MCP work cycle preserves scope and evidence; semantic defects fail independently of JSON shape', async () => {
  const correct = await runWorkCycle('correct');
  assert.equal(correct.status, 'pass', correct.error); assert.equal(correct.modelInvoked, false);
  const wrong = await runWorkCycle('wrong');
  assert.equal(wrong.status, 'fail', wrong.error);
  assert.equal(wrong.outcome!.protectedCheck, 'pass'); assert.equal(wrong.outcome!.accepted, false);
  assert.equal(wrong.outcome!.matchesConstraint, false);
  assert.equal(wrong.fixtureHash, correct.fixtureHash);
  assert.equal(correct.checks['late-body'], true); assert.equal(correct.checks.cleanup, true);
  assert.throws(() => workCycleSchema.parse({ ...correct, checks: {} }));
  assert.throws(() => workCycleSchema.parse({ ...correct, outcome: undefined }));
  assert.throws(() => workCycleSchema.parse({ ...correct, run: { ...correct.run, status: 'running' } }));
  assert.throws(() => workCycleSchema.parse({ ...wrong, status: 'pass' }));
  const cancelled = await runWorkCycle('correct', AbortSignal.abort());
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.run, undefined); assert.equal(cancelled.checks.cleanup, true);
  const controller = new AbortController();
  const pending = runWorkCycle('correct', controller.signal);
  setImmediate(() => controller.abort());
  const interrupted = await pending;
  assert.equal(interrupted.status, 'cancelled', interrupted.error); assert.equal(interrupted.checks.cleanup, true);
});

test('MCP launch credentials require a host-private regular file and exact local tool endpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collective-launch-test-'));
  const path = join(dir, 'launch.json');
  const input = { endpoint: 'http://127.0.0.1:4310/agent/tools', token: 'a'.repeat(64) };
  try {
    writeFileSync(path, JSON.stringify(input), { mode: 0o600 }); assert.deepEqual(readMcpLaunch(path), input);
    for (const endpoint of ['https://example.com/agent/tools', 'http://localhost:4310/agent/tools',
      'http://127.0.0.1:4310/api/control', 'http://127.0.0.1:4310/agent/tools?token=secret', 'http://user@127.0.0.1:4310/agent/tools']) {
      assert.throws(() => environmentMcpLaunch(endpoint, input.token));
    }
    chmodSync(path, 0o644); assert.throws(() => readMcpLaunch(path), /Unsafe/); chmodSync(path, 0o600);
    symlinkSync(path, join(dir, 'symlink')); assert.throws(() => readMcpLaunch(join(dir, 'symlink')));
    linkSync(path, join(dir, 'hardlink')); assert.throws(() => readMcpLaunch(path), /Unsafe/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('domain gateway protocol rejects missing calls, duplicate frames and malformed results', () => {
  const frame = (results: unknown[]) => 'COLLECTIVE_DOMAIN_V1 ' + JSON.stringify({ version: 1, results });
  const result = { name: 'collective_context', isError: false, content: [{ type: 'text', text: '{"you":{"id":"atlas"}}' }] };
  assert.equal(domainResults(frame([result]), ['collective_context'])[0]!.value.you.id, 'atlas');
  assert.throws(() => domainResults(frame([]), ['collective_context']));
  assert.throws(() => domainResults(frame([result]), ['task_update']));
  assert.throws(() => domainResults(frame([result]) + '\n' + frame([result]), ['collective_context']));
  assert.throws(() => domainResults('timeout\n' + frame([result]), ['collective_context']));
  assert.throws(() => domainResults(frame([{ ...result, content: [{ type: 'text', text: 'not JSON' }] }]), ['collective_context']));
});
