import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod/v3';
import { Store } from '../../src/store.js';
import { seed } from '../../src/seed.js';
import { CollectiveService } from '../../src/service.js';
import { Scheduler } from '../../src/scheduler.js';
import { DiscordBridge } from '../../src/discord.js';
import { createHttpServer } from '../../src/http.js';
import { workerEnvironment } from '../../src/claude.js';
import type { Config } from '../../src/config.js';
import type { Task, Artifact } from '../../src/types.js';
import { hashRecord } from '../../src/progress/checks.js';
import { readArtifactSnapshot } from '../../src/storage/artifacts.js';
import { scenarioSourceHash } from '../scenario-source.js';

export const fixture = Object.freeze({ id: 'constraint-artifact.v1', query: 'palette cardinality',
  content: JSON.stringify({ palette: 'teal', maxCards: 12 }),
  mission: 'Retrieve the palette/cardinality constraint and publish a JSON configuration citing its exact revision.' });
export type Variant = 'correct' | 'wrong';
const checkIds = ['retrieval', 'ownership', 'retry', 'submission', 'revocation', 'late-body', 'recovery', 'cleanup'] as const;
export const workCycleSchema = z.object({
  version: z.literal(1), scenarioId: z.literal('constraint-artifact.v1'),
  authority: z.literal('maintainer-scenario'), worker: z.literal('scripted-mcp'), modelInvoked: z.literal(false),
  variant: z.enum(['correct', 'wrong']), status: z.enum(['pass', 'fail', 'error', 'cancelled']),
  fixtureHash: z.string().regex(/^[a-f0-9]{64}$/), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  elapsedMs: z.number().nonnegative(), checks: z.record(z.boolean()),
  outcome: z.object({ artifactId: z.string(), sha256: z.string(), content: z.string(),
    submissionId: z.string(), criteriaHash: z.string(), sourceRevision: z.string(),
    protectedCheck: z.literal('pass'), accepted: z.literal(false), matchesConstraint: z.boolean() }).strict().optional(),
  run: z.object({ id: z.string(), jobId: z.string(), attempt: z.number(), missionId: z.string(),
    missionRevision: z.number(), status: z.string() }).strict().optional(),
  usage: z.object({ modelCalls: z.literal(0), modelTokens: z.literal(0), billedDollars: z.literal(0) }).strict(),
  trace: z.array(z.object({ tool: z.string(), isError: z.boolean(), argumentsHash: z.string(), resultHash: z.string() }).strict()),
  error: z.string().optional(),
}).strict().superRefine((report, ctx) => {
  if (['pass', 'fail'].includes(report.status) && (!report.outcome || !report.run || report.run.status !== 'complete'
    || Object.keys(report.checks).length !== checkIds.length || checkIds.some(id => report.checks[id] !== true)
    || (report.status === 'pass') !== report.outcome.matchesConstraint)) {
    ctx.addIssue({ code: 'custom', message: 'A scored result requires complete evidence and verified cleanup.' });
  }
});
export type WorkCycleReport = z.infer<typeof workCycleSchema>;

export async function runWorkCycle(variant: Variant = 'correct', signal?: AbortSignal): Promise<WorkCycleReport> {
  const started = performance.now(), dir = mkdtempSync(join(tmpdir(), 'collective-scenario-'));
  const root = resolve(import.meta.dirname, '../..');
  const report: WorkCycleReport = { version: 1, scenarioId: fixture.id as 'constraint-artifact.v1', authority: 'maintainer-scenario',
    worker: 'scripted-mcp', modelInvoked: false, variant, status: 'error', fixtureHash: hashRecord(fixture),
    sourceHash: scenarioSourceHash(root),
    elapsedMs: 0, checks: {}, usage: { modelCalls: 0, modelTokens: 0, billedDollars: 0 }, trace: [] };
  const store = new Store(join(dir, 'db.sqlite')); seed(store);
  const config: Config = { root, dataDir: dir, port: 0, mode: 'simulation', claudeBin: 'unused', operatorIds: [] };
  const service = new CollectiveService(store, config);
  const scheduler = new Scheduler(store, config, service, { execute: async () => { throw new Error('Worker not configured.'); } });
  const server = createHttpServer(service, scheduler, new DiscordBridge(service, config, scheduler), config);
  const client = new Client({ name: 'collective-work-cycle', version: '1' });
  let transport: StdioClientTransport | undefined, task: Task | undefined, token: string | undefined;
  let release!: () => void, workerDone!: () => void, releaseProbe = () => {};
  const releaseWorker = new Promise<void>(r => { release = r; });
  const workerCompleted = new Promise<void>(r => { workerDone = r; });
  let workerError: unknown;
  const abort = () => { scheduler.pause(); release(); releaseProbe(); void client.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const bounded = <T>(pending: Promise<T>): Promise<T> => new Promise((ok, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); action();
    };
    const onAbort = () => finish(() => reject(new Error('Scenario cancelled.')));
    const timer = setTimeout(() => finish(() => reject(new Error('Scenario operation timed out.'))), 15000);
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.then(value => finish(() => ok(value)), error => finish(() => reject(error)));
    if (signal?.aborted) onAbort();
  });
  const call = async (name: string, args: Record<string, unknown> = {}, expectedError?: RegExp): Promise<any> => {
    if (signal?.aborted) throw new Error('Scenario cancelled.');
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
    assert.ok(Array.isArray(result.content) && result.content.length === 1 && result.content[0]?.type === 'text');
    const content = result.content[0].text as string;
    report.trace.push({ tool: name, isError: result.isError === true, argumentsHash: hashRecord(args), resultHash: hashRecord(content) });
    if (expectedError) { assert.equal(result.isError, true); assert.match(content, expectedError); return undefined; }
    assert.notEqual(result.isError, true, content);
    return JSON.parse(content);
  };
  const waitIdle = async () => {
    const deadline = performance.now() + 10000;
    while (scheduler.controllers.size && performance.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.equal(scheduler.controllers.size, 0, 'Worker did not stop.');
  };
  try {
    if (signal?.aborted) throw new Error('Scenario cancelled before execution.');
    await new Promise<void>((ok, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ok); });
    const address = server.address(); assert.ok(address && typeof address !== 'string'); config.port = address.port;
    const mission = service.setMission('Constraint artifact', fixture.mission, ['The published configuration obeys the retrieved constraint.'], 'operator');
    const note = service.knowledge.write('nova', { title: 'Palette cardinality constraint', content: fixture.content, kind: 'decision' });
    task = await service.tool('nova', 'task_create', { title: 'Publish constrained configuration', description: fixture.mission,
      ownerId: 'atlas', acceptance: 'A configuration honoring the source constraint', criteria: [{ id: 'shape',
        description: 'Configuration includes palette, cardinality and exact source revision', method: 'json.fields.v1', evidenceKind: 'artifact',
        fields: [{ name: 'palette', type: 'string' }, { name: 'maxCards', type: 'number' }, { name: 'sourceRevision', type: 'string' }] }] }) as Task;
    const foreign = await service.tool('nova', 'task_create', { title: 'Other owner', description: 'Must remain untouched', ownerId: 'iris', acceptance: 'An ownership probe' }) as Task;
    // Fixture initialization is explicit; only Atlas runs, with no Discord connection.
    for (const job of store.all('jobs')) store.patch('jobs', job.id, { status: 'cancelled' });
    store.enqueue('atlas', 'task', { taskId: task.id }, 'scenario-atlas');
    store.patch('settings', 'settings', { paused: false, maxConcurrent: 1 });
    scheduler.harness = { execute: async (_agent, job, run) => {
      token = scheduler.grantRun(run.id);
      const launchFile = join(dir, 'mcp-launch.json');
      writeFileSync(launchFile, JSON.stringify({ endpoint: `http://127.0.0.1:${config.port}/agent/tools`, token }), { mode: 0o600 });
      report.run = { id: run.id, jobId: job.id, attempt: run.attempt!, missionId: job.missionId!, missionRevision: job.missionRevision!, status: 'running' };
      try {
        transport = new StdioClientTransport({ command: process.execPath,
          args: ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), join(root, 'src/mcp-worker.ts'), '--launch-file', launchFile],
          env: Object.fromEntries(Object.entries(workerEnvironment()).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          stderr: 'pipe' });
        await client.connect(transport, { timeout: 5000 });
        const context = await call('collective_context'); assert.equal(context.you.id, 'atlas');
        const search = await call('knowledge_search', { query: fixture.query });
        const hit = search.entries.find((entry: any) => entry.title === 'Palette cardinality constraint'); assert.ok(hit);
        const knowledge = await call('knowledge_get', { revisionId: hit.citation.revisionId });
        assert.equal(knowledge.content, fixture.content);
        report.checks.retrieval = true;
        await call('task_update', { taskId: foreign.id, status: 'doing', commandId: 'foreign-task' }, /own/);
        assert.equal(store.require('tasks', foreign.id).status, foreign.status); report.checks.ownership = true;
        const update = { taskId: task!.id, status: 'doing', commandId: 'start-task' };
        const first = await call('task_update', update), second = await call('task_update', update);
        assert.deepEqual(first, second); report.checks.retry = true;
        const constraint = JSON.parse(knowledge.content);
        const candidate = { palette: variant === 'wrong' ? 'red' : constraint.palette,
          maxCards: constraint.maxCards, sourceRevision: hit.citation.revisionId };
        // This is a scripted host worker, not guest file export or generated code.
        writeFileSync(join(service.workspace('atlas'), 'answer.json'), JSON.stringify(candidate));
        const artifact: Artifact = await call('artifact_publish', { title: 'Configuration', description: 'Scenario candidate', path: 'answer.json', taskId: task!.id });
        const submitted = await call('task_submit', { taskId: task!.id, commandId: 'submit-answer',
          bindings: [{ criterionId: 'shape', evidenceIds: [artifact.id] }], note: 'Requires independent semantic evaluation.' });
        const ledger = service.progress.get({ taskId: task!.id });
        assert.equal(ledger.submission!.checks[0]!.status, 'pass'); assert.equal(submitted.status, 'review');
        const bytes = readArtifactSnapshot(dir, store.require('artifacts', artifact.id));
        assert.equal(ledger.submission!.evidence[0]!.sha256, artifact.sha256);
        report.outcome = { artifactId: artifact.id, sha256: artifact.sha256, content: bytes.toString('utf8'),
          submissionId: submitted.submissionId, criteriaHash: ledger.criteria!.sha256,
          sourceRevision: note.id, protectedCheck: 'pass', accepted: false,
          matchesConstraint: hashRecord(JSON.parse(bytes.toString('utf8'))) === hashRecord({ palette: 'teal', maxCards: 12, sourceRevision: note.id }) };
        report.checks.submission = true;
      } catch (error) { workerError = error; }
      finally { workerDone(); }
      await releaseWorker;
      if (workerError) throw workerError;
      return { summary: 'Scripted scenario finished; no model invoked.', inputTokens: 0, outputTokens: 0, estimatedCost: 0, turns: 0 };
    } };
    await scheduler.tick();
    await bounded(workerCompleted);
    if (workerError) throw workerError;
    if (signal?.aborted) throw new Error('Scenario cancelled.');
    release(); await waitIdle();
    assert.equal(store.require('runs', report.run!.id).status, 'complete');
    report.run!.status = 'complete';
    await call('collective_context', {}, /Run token|Run ended/);
    // A separate, genuinely active attempt tests pause; it must not pass merely
    // because the completed artifact attempt was already unauthorized.
    let probeReady!: () => void, probeRelease!: () => void;
    const ready = new Promise<void>(r => { probeReady = r; });
    const released = new Promise<void>(r => { probeRelease = r; });
    releaseProbe = probeRelease;
    for (const job of store.all('jobs').filter(j => j.status === 'pending')) store.patch('jobs', job.id, { status: 'cancelled' });
    scheduler.harness = { execute: async (_agent, _job, run) => {
      token = scheduler.grantRun(run.id); probeReady();
      await released;
      return { summary: 'Pause probe', inputTokens: 0, outputTokens: 0, estimatedCost: 0, turns: 0 };
    } };
    store.enqueue('atlas', 'task', {}, 'scenario-pause');
    await scheduler.tick(); await bounded(ready);
    assert.ok(scheduler.authenticateRun(token!));
    // Send headers while authorized, finish the body only after pause revokes it.
    let bodyObserved!: () => void;
    const received = new Promise<void>(r => { bodyObserved = r; });
    server.once('request', req => req.once('data', bodyObserved));
    const partial = request(`http://127.0.0.1:${config.port}/agent/tools`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } });
    const response = new Promise<number>( (ok, reject) => { partial.on('response', res => { res.resume(); res.on('end', () => ok(res.statusCode!)); }); partial.on('error', reject); });
    partial.setTimeout(3000, () => partial.destroy(new Error('Partial request timed out.')));
    try {
      partial.write('{"name":"profile_update","arguments":');
      await Promise.race([received, response.then(() => { throw new Error('Request ended before its partial body was observed.'); })]);
      scheduler.pause();
      assert.equal(scheduler.authenticateRun(token!), undefined);
      partial.end('{"bio":"unauthorized mutation"}}');
      assert.equal(await response, 401); assert.notEqual(store.require('agents', 'atlas').bio, 'unauthorized mutation'); report.checks['late-body'] = true;
      report.checks.revocation = true;
    } finally { partial.destroy(); probeRelease(); }
    await waitIdle();
    assert.equal(store.require('tasks', task.id).status, 'review');
    const before = JSON.stringify(service.progress.get({ taskId: task.id }).submission);
    const reopened = new Store(join(dir, 'db.sqlite'));
    try { reopened.recover(); assert.equal(reopened.require('tasks', task.id).submissionId, report.outcome!.submissionId); }
    finally { reopened.close(); }
    assert.equal(JSON.stringify(service.progress.get({ taskId: task.id }).submission), before); report.checks.recovery = true;
    report.status = report.outcome!.matchesConstraint ? 'pass' : 'fail';
  } catch (error) { report.status = signal?.aborted ? 'cancelled' : 'error'; report.error = error instanceof Error ? error.message : 'Scenario failed'; }
  finally {
    release(); releaseProbe();
    const cleanupErrors: string[] = [];
    const clean = async (label: string, action: () => unknown | Promise<unknown>) => {
      try { await action(); } catch (error) { cleanupErrors.push(`${label}: ${String(error)}`); }
    };
    await clean('scheduler', async () => { await scheduler.stop(); await waitIdle(); });
    await clean('MCP process', async () => {
      const pid = transport?.pid;
      await client.close();
      if (pid) {
        let alive = true; try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error; }
        assert.equal(alive, false, 'MCP server process remained alive after close.');
      }
    });
    await clean('HTTP server', async () => {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((ok, reject) => server.close(error => error ? reject(error) : ok()));
    });
    await clean('knowledge', () => service.knowledge.close());
    await clean('store', () => store.close());
    await clean('fixture directory', () => { rmSync(dir, { recursive: true, force: true }); assert.equal(existsSync(dir), false); });
    report.checks.cleanup = cleanupErrors.length === 0;
    if (cleanupErrors.length) { report.status = 'error'; report.error = [report.error, ...cleanupErrors].filter(Boolean).join('; '); }
    else if (signal?.aborted) { report.status = 'cancelled'; report.error = 'Scenario cancelled.'; }
    signal?.removeEventListener('abort', abort);
    report.elapsedMs = performance.now() - started;
  }
  return workCycleSchema.parse(report);
}
