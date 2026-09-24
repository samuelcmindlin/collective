import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { seed } from '../src/seed.js';
import { CollectiveService } from '../src/service.js';
import type { Artifact, Task } from '../src/types.js';
import { dockerCommand, DockerSandbox } from '../src/evaluation/docker.js';
import { evaluateCandidate, judgeOutput, type BehaviorPolicy } from '../src/evaluation/behavior.js';
import { hashRecord } from '../src/progress/checks.js';

const args = process.argv.slice(2);
const option = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
const image = option('--image'), socket = option('--socket');
if (!image || !socket) throw new Error('Usage: npm run isolation:rehearse -- --image sha256:<local-image-id> --socket unix:///absolute/docker.sock [--output path]');
const output = resolve(option('--output') ?? 'test-results/isolation-rehearsal.json');
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'collective-isolation-'));
const configDir = join(dir, 'docker-client'); mkdirSync(configDir, { mode: 0o700 });
const command = dockerCommand(socket, configDir), sandbox = new DockerSandbox(image, command);
const store = new Store(join(dir, 'rehearsal.sqlite')); seed(store);
const service = new CollectiveService(store, { root, dataDir: dir, port: 0, mode: 'simulation', claudeBin: 'unused', operatorIds: [] });
const operator = createServer(connection => { connection.destroy(); });
const fakeSsh = createServer(connection => { connection.destroy(); });
const report: Record<string, unknown> = { createdAt: new Date().toISOString(), image, policyHash: sandbox.policyHash,
  authority: 'controlled-fixture-rehearsal', wholeWorkerGate: 'not-verified', productionExecutionEnabled: false,
  evaluatorCodeHash: hashRecord(['src/evaluation/docker.ts', 'src/evaluation/behavior.ts', 'scripts/rehearse-isolation.ts',
    'scripts/fixtures/containment-probe.mjs', 'scripts/fixtures/matching-game.mjs'].map(path => [path, readFileSync(join(root, path), 'utf8')])) };
try {
  const version = await command(['version', '--format', '{{json .Server}}'], '', 5000);
  assert.equal(version.code, 0, 'Docker must be available before starting the rehearsal');
  const runtime = JSON.parse(version.stdout);
  report.runtime = { version: runtime.Version, os: runtime.Os, arch: runtime.Arch, components: runtime.Components };
  await new Promise<void>(done => operator.listen(0, '127.0.0.1', done));
  const socketPath = join(dir, 'synthetic-ssh.sock');
  await new Promise<void>(done => fakeSsh.listen(socketPath, done));
  const hostSentinel = join(dir, 'supervisor-sentinel'), otherWorker = join(dir, 'other-worker-sentinel');
  writeFileSync(hostSentinel, 'synthetic protected state'); writeFileSync(otherWorker, 'synthetic other worker');
  const probe = await sandbox.run(readFileSync(join(root, 'scripts/fixtures/containment-probe.mjs')), JSON.stringify({
    hostSentinel, otherWorker, socket: socketPath, operatorPort: (operator.address() as { port: number }).port,
  }));
  const observations = JSON.parse(probe.stdout || '{}') as Record<string, boolean>;
  report.containment = { execution: probe, observations };
  assert.equal(judgeOutput(probe, observations).status, 'pass', 'Containment fixture must execute and clean up successfully');
  assert.equal(Object.keys(observations).length, 24, 'All probes must be present');
  assert.ok(Object.values(observations).every(value => value === true), 'All allowed operations and expected denials must be observed');
  assert.equal(readFileSync(hostSentinel, 'utf8'), 'synthetic protected state');
  assert.equal(readFileSync(otherWorker, 'utf8'), 'synthetic other worker');

  const timeout = await sandbox.run(Buffer.from('while (true) {}'), '', { timeoutMs: 500 });
  report.timeout = timeout;
  assert.equal(timeout.stopped, 'timeout'); assert.equal(timeout.cleanupVerified, true);
  const overflow = await sandbox.run(Buffer.from("while (true) process.stdout.write('x'.repeat(8192))"), '');
  report.outputLimit = { ...overflow, stdout: undefined, stderr: undefined };
  assert.equal(overflow.stopped, 'output-limit'); assert.equal(overflow.cleanupVerified, true);
  const memory = await sandbox.run(Buffer.from('const blocks=[]; for(let i=0;i<10;i++) blocks.push(Buffer.alloc(64*1024*1024,255)); setInterval(()=>{},1000);'), '');
  report.memoryLimit = memory;
  assert.equal(memory.state?.oomKilled, true); assert.equal(memory.cleanupVerified, true);
  assert.equal(judgeOutput(memory, {}).status, 'error');
  const controller = new AbortController();
  const cancellation = sandbox.run(Buffer.from("import {spawn} from 'node:child_process'; spawn('/bin/sleep',['30'],{detached:true,stdio:'ignore'}); console.log('ready'); setInterval(()=>{},1000);"), '', { signal: controller.signal });
  const abortTimer = setTimeout(() => controller.abort(), 1500);
  try { const cancelled = await cancellation; report.cancellation = cancelled;
    assert.equal(cancelled.stopped, 'aborted'); assert.equal(cancelled.cleanupVerified, true); assert.match(cancelled.stdout, /ready/);
  } finally { clearTimeout(abortTimer); }
  const descendants = await sandbox.run(Buffer.from("import {spawn} from 'node:child_process'; const child=spawn('/bin/sleep',['30'],{detached:true,stdio:'ignore'}); child.unref(); console.log('{}');"), '');
  report.leaderExit = descendants;
  assert.equal(judgeOutput(descendants, {}).status, 'pass');

  service.setMission('Rehearse a matching-game evaluator', 'Measure specific behavior of a frozen code candidate.', [], 'operator');
  const task = await service.tool('nova', 'task_create', { title: 'Matching-game state transitions', ownerId: 'ember',
    description: 'Rehearsal only; no live agent or automatic acceptance.', acceptance: 'The game obeys the specified state transitions.' }) as Task;
  const policy: BehaviorPolicy = { id: 'matching-game.examples.v1', criterionId: 'acceptance', limitations: [
    'Fixed maintainer examples; no hidden-test, real-model, UI, general correctness or enjoyment claim.',
    'The production criterion remains judgment. This external rehearsal report is not a required protected submission check.',
    'Old Docker runtime used only for these controlled fixtures; whole Claude worker containment remains unverified.',
  ], cases: [
    { id: 'initial', input: { actions: [] }, expected: { selected: [], matched: [], moves: 0, complete: false } },
    { id: 'mismatch', input: { actions: [0, 1] }, expected: { selected: [0, 1], matched: [], moves: 1, complete: false } },
    { id: 'match', input: { actions: [0, 2] }, expected: { selected: [], matched: [0, 2], moves: 1, complete: false } },
    { id: 'complete', input: { actions: [0, 2, 1, 3] }, expected: { selected: [], matched: [0, 1, 2, 3], moves: 2, complete: true } },
    { id: 'invalid-repeat', input: { actions: [-1, 9, 'oops', 0, 0, 2, 0] }, expected: { selected: [], matched: [0, 2], moves: 1, complete: false } },
    { id: 'restart', input: { actions: [0, 2, 1, 3, 'restart'] }, expected: { selected: [], matched: [], moves: 0, complete: false } },
  ] };
  const source = readFileSync(join(root, 'scripts/fixtures/matching-game.mjs'), 'utf8');
  const publish = async (body: string) => {
    writeFileSync(join(service.workspace('ember'), 'game.mjs'), body);
    const published = await service.tool('ember', 'artifact_publish', { title: 'State machine', description: 'Controlled rehearsal fixture', path: 'game.mjs', taskId: task.id }) as Artifact;
    await service.tool('ember', 'task_submit', { taskId: task.id, evidenceIds: [published.id], note: 'Frozen fixture for external rehearsal.', limitations: policy.limitations });
    return { artifact: store.require('artifacts', published.id), submission: service.progress.get({ taskId: task.id }).submission! };
  };
  const bad = await publish(source.replace('moves = 0; continue;', 'moves = 1; continue;'));
  const failed = await evaluateCandidate(dir, bad.artifact, bad.submission, policy, sandbox);
  report.failedCandidate = failed; assert.equal(failed.status, 'fail');
  assert.deepEqual(failed.results.filter(r => r.status === 'fail').map(r => r.caseId), ['restart']);
  await service.tool('iris', 'task_review', { taskId: task.id, submissionId: bad.submission.id, accepted: false,
    verdicts: [{ criterionId: 'acceptance', verdict: 'fail', evidenceIds: [bad.artifact.id], rationale: `Maintainer fixture found a restart defect. Rehearsal ${failed.sha256}.` }], note: 'Rehearsal rejected; correct restart.' });
  const good = await publish(source);
  // Deliberately change the workspace after publication: evaluation must use frozen storage.
  writeFileSync(join(service.workspace('ember'), 'game.mjs'), 'throw new Error("workspace changed")');
  const passed = await evaluateCandidate(dir, good.artifact, good.submission, policy, sandbox);
  report.correctedCandidate = passed; assert.equal(passed.status, 'pass');
  assert.equal(service.progress.get({ taskId: task.id, submissionId: bad.submission.id }).evaluation?.accepted, false);
  assert.equal(store.require('tasks', task.id).status, 'review', 'A passing rehearsal cannot automatically accept a task');
  report.fixtureLedger = { criteria: service.progress.criteria(task.id), failedSubmission: bad.submission,
    failedReview: service.progress.get({ taskId: task.id, submissionId: bad.submission.id }).evaluation,
    correctedSubmission: good.submission, finalTaskStatus: 'review' };
  report.result = 'pass';
} catch (error) {
  report.result = 'fail'; report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  const close = (server: typeof operator) => new Promise<void>(done => server.close(() => done()));
  await Promise.all([close(operator), close(fakeSsh)]);
  service.knowledge.close(); store.close();
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ result: report.result, report: output, error: report.error, wholeWorkerGate: report.wholeWorkerGate }));
}
