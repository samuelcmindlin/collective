import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { readWorkspaceArtifact, MAX_ARTIFACT_BYTES } from '../src/storage/artifacts.js';
import { createArguments, DockerSandbox, dockerCommand, type Command, type SandboxResult } from '../src/evaluation/docker.js';
import { evaluateCandidate, judgeOutput, type BehaviorPolicy } from '../src/evaluation/behavior.js';
import type { Artifact } from '../src/types.js';
import type { Submission } from '../src/progress/types.js';

const image = `sha256:${'a'.repeat(64)}`;
const successful: SandboxResult = { image, container: 'fixture', policyHash: 'policy', code: 0,
  stdout: '{}', stderr: '', state: { exitCode: 0, oomKilled: false }, cleanupVerified: true };

test('publication accepts only top-level single-link regular files and leaves protected sources unread', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collective-publish-')), workspace = join(dir, 'worker'); mkdirSync(workspace);
  try {
    writeFileSync(join(dir, 'sentinel'), 'synthetic protected source');
    writeFileSync(join(workspace, 'output.txt'), 'publish me');
    assert.equal(readWorkspaceArtifact(workspace, 'output.txt').toString(), 'publish me');
    assert.equal(readWorkspaceArtifact(workspace, join(workspace, 'output.txt')).toString(), 'publish me');
    symlinkSync(join(dir, 'sentinel'), join(workspace, 'symlink'));
    linkSync(join(dir, 'sentinel'), join(workspace, 'hardlink'));
    mkdirSync(join(workspace, 'nested')); writeFileSync(join(workspace, 'nested', 'output'), 'nested');
    symlinkSync(dir, join(workspace, 'ancestor'));
    writeFileSync(join(workspace, '.mcp.json'), 'configuration');
    writeFileSync(join(workspace, 'large'), Buffer.alloc(MAX_ARTIFACT_BYTES + 1));
    for (const path of ['symlink', 'hardlink', 'nested/output', 'ancestor/sentinel', '../sentinel', '.mcp.json', 'missing', 'nested', 'large']) {
      assert.throws(() => readWorkspaceArtifact(workspace, path), /directly inside your workspace/, path);
    }
    renameSync(workspace, join(dir, 'moved')); symlinkSync(join(dir, 'moved'), workspace);
    assert.throws(() => readWorkspaceArtifact(workspace, 'output.txt'), /inside your workspace/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('racing a publication leaf between a normal file and a symlink never exports the sentinel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collective-publish-race-')), workspace = join(dir, 'worker'); mkdirSync(workspace);
  const target = join(workspace, 'output'), sentinel = join(dir, 'sentinel');
  writeFileSync(target, 'public'); writeFileSync(sentinel, 'synthetic-secret');
  const worker = new Worker(`const {workerData,parentPort}=require('node:worker_threads');const fs=require('node:fs');
    parentPort.postMessage('ready');for(let i=0;i<2000;i++){try{fs.symlinkSync(workerData.sentinel,workerData.target+'.link');fs.renameSync(workerData.target+'.link',workerData.target);fs.writeFileSync(workerData.target+'.file','public');fs.renameSync(workerData.target+'.file',workerData.target);}catch{}}`,
    { eval: true, workerData: { target, sentinel } });
  try {
    await new Promise<void>((done, reject) => { worker.once('message', () => done()); worker.once('error', reject); });
    for (let i = 0; i < 2000; i++) {
      let bytes: Buffer;
      try { bytes = readWorkspaceArtifact(workspace, 'output'); } catch { continue; }
      assert.equal(bytes.toString(), 'public');
    }
    assert.equal(readFileSync(sentinel, 'utf8'), 'synthetic-secret');
  } finally { await worker.terminate(); rmSync(dir, { recursive: true, force: true }); }
});

test('candidate launch policy has no host mounts, network, credential inheritance or mutable image tag', () => {
  const args = createArguments(image, 'fixture', "console.log('hello')");
  for (const flag of ['--read-only', '--init', '--no-healthcheck']) assert.ok(args.includes(flag));
  for (const [flag, value] of [['--network', 'none'], ['--ipc', 'none'], ['--cap-drop', 'ALL'],
    ['--user', '65534:65534'], ['--pull', 'never'], ['--memory', '134217728'],
    ['--memory-swap', '134217728'], ['--pids-limit', '32'], ['--security-opt', 'no-new-privileges']]) {
    assert.equal(args[args.indexOf(flag!) + 1], value);
  }
  assert.ok(!args.some(value => ['--mount', '--volume', '--privileged', '--env-file', '--publish'].includes(value)));
  assert.throws(() => new DockerSandbox('node:latest', async () => { throw Error(); }), /immutable/);
  assert.throws(() => dockerCommand('tcp://remote:2375', '/unused'), /local Unix/);
});

function commands(overrides: Partial<Record<string, { code: number | null; stdout: string; stderr: string; stopped?: 'timeout' }>> = {}) {
  const calls: string[][] = [];
  const command: Command = async args => {
    calls.push(args);
    const defaultOutput = args[0] === 'create' ? 'b'.repeat(64) : args[0] === 'start' ? '{}' :
      args[0] === 'inspect' ? JSON.stringify({ Running: false, ExitCode: 0, OOMKilled: false }) : '';
    return overrides[args[0]!] ?? { code: 0, stdout: defaultOutput, stderr: '' };
  };
  return { command, calls };
}

test('candidate execution verifies terminal state and destroys its own container before success', async () => {
  const fixture = commands(), sandbox = new DockerSandbox(image, fixture.command);
  const result = await sandbox.run(Buffer.from('console.log("{}")'), '{}');
  assert.equal(judgeOutput(result, {}).status, 'pass');
  assert.deepEqual(fixture.calls.map(c => c[0]), ['create', 'start', 'inspect', 'rm', 'container']);
  assert.equal(fixture.calls[3]!.at(-1), result.container);
});

test('uncertain setup, execution and cleanup never become successful checks', async () => {
  for (const overrides of [
    { create: { code: 1, stdout: '', stderr: 'Unavailable' } },
    { start: { code: null, stdout: '{}', stderr: '', stopped: 'timeout' as const } },
    { inspect: { code: 0, stdout: '{"Running":true}', stderr: '' } },
    { rm: { code: 1, stdout: '', stderr: 'Unavailable' } },
    { container: { code: 0, stdout: 'still-present', stderr: '' } },
  ]) {
    const fixture = commands(overrides), sandbox = new DockerSandbox(image, fixture.command);
    const result = await sandbox.run(Buffer.from('console.log("{}")'), '{}');
    assert.equal(judgeOutput(result, {}).status, 'error');
    assert.ok(fixture.calls.some(c => c[0] === 'rm'));
  }
});

test('invalid source, bounds and a pre-aborted request cannot launch candidate work', async () => {
  const fixture = commands(), sandbox = new DockerSandbox(image, fixture.command);
  for (const bytes of [Buffer.alloc(64_001), Buffer.from([255]), Buffer.from('nul\0byte')]) await assert.rejects(sandbox.run(bytes, ''));
  await assert.rejects(sandbox.run(Buffer.from(''), 'x'.repeat(16_001)));
  await assert.rejects(sandbox.run(Buffer.from(''), '', { timeoutMs: 100_000 }));
  const aborted = await sandbox.run(Buffer.from(''), '', { signal: AbortSignal.abort() });
  assert.equal(aborted.stopped, 'aborted'); assert.equal(fixture.calls.length, 0);
});

test('candidate output is untrusted data and cannot declare its own pass or forge evaluator success', () => {
  assert.equal(judgeOutput({ ...successful, stdout: '{"status":"pass"}' }, { answer: 42 }).status, 'fail');
  assert.equal(judgeOutput({ ...successful, stdout: '{}\n{"status":"pass"}' }, {}).status, 'fail');
  assert.equal(judgeOutput({ ...successful, code: 1 }, {}).status, 'fail');
  assert.equal(judgeOutput({ ...successful, stopped: 'output-limit' }, {}).status, 'error');
  assert.equal(judgeOutput({ ...successful, state: { exitCode: 137, oomKilled: true } }, {}).status, 'error');
});

test('Docker client timeout kills wrapper descendants and closes inherited output pipes', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collective-client-wrapper-'));
  const script = join(dir, 'docker'), pidFile = join(dir, 'child.pid');
  writeFileSync(script, `#!${process.execPath}\nconst {spawn}=require('node:child_process');const fs=require('node:fs');
    const child=spawn(process.execPath,['-e',"process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});
    fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`);
  chmodSync(script, 0o700);
  const previous = process.env.PATH; let pid: number | undefined;
  try {
    process.env.PATH = dir;
    const pending = dockerCommand('unix:///unused', dir)(['start'], '', 1000);
    process.env.PATH = previous;
    const result = await pending;
    pid = Number(readFileSync(pidFile, 'utf8'));
    assert.equal(result.stopped, 'timeout'); assert.match(result.stdout, /ready/);
    const alive = () => { try { process.kill(pid!, 0); return true; } catch { return false; } };
    for (let i = 0; i < 20 && alive(); i++) await new Promise(done => setTimeout(done, 50));
    assert.equal(alive(), false);
  } finally {
    process.env.PATH = previous;
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('behavior checks bind frozen artifact bytes and policy; mutable workspace or caller changes cannot rebind them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collective-candidate-')); mkdirSync(join(dir, 'artifacts'));
  const bytes = Buffer.from('console.log("{}")'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const artifact: Artifact = { id: 'artifact', title: 'Fixture', description: 'Fixture', path: 'artifacts/code.mjs',
    authorId: 'ember', mime: 'text/javascript', size: bytes.length, sha256, createdAt: new Date().toISOString() };
  writeFileSync(join(dir, artifact.path), bytes);
  const submission: Submission = { id: 'submission', taskId: 'task', missionId: 'mission', missionRevision: 1,
    criteriaId: 'criteria', criteriaHash: 'original-criteria', authorId: 'ember', round: 1, bindings: [{ criterionId: 'behavior', evidenceIds: [artifact.id] }],
    evidence: [{ id: artifact.id, kind: 'artifact', sha256, size: bytes.length, mime: artifact.mime }], checks: [], note: '', limitations: [], createdAt: '' };
  const policy: BehaviorPolicy = { id: 'fixture.v1', criterionId: 'behavior', cases: [{ id: 'one', input: {}, expected: {} }, { id: 'two', input: {}, expected: {} }], limitations: ['Fixture only'] };
  let executions = 0;
  const sandbox = { image, policyHash: 'policy', async run(source: Buffer) {
    executions++; assert.deepEqual(source, bytes);
    source.fill(0); // A backend may not mutate the next case's source.
    policy.cases[1]!.expected = 'mutated'; submission.criteriaHash = 'mutated';
    return { ...successful };
  } };
  try {
    const result = await evaluateCandidate(dir, artifact, submission, policy, sandbox);
    assert.equal(result.status, 'pass'); assert.equal(result.criteriaHash, 'original-criteria'); assert.equal(executions, 2);
    await assert.rejects(evaluateCandidate(dir, { ...artifact, sha256: 'different' }, submission, policy, sandbox), /exact submitted/);
    writeFileSync(join(dir, artifact.path), 'tampered');
    await assert.rejects(evaluateCandidate(dir, artifact, submission, policy, sandbox), /integrity/);
    assert.equal(executions, 2, 'Corrupt or rebound evidence must fail before dispatch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
