import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Store, id, nowIso } from '../src/store.js';
import { seed } from '../src/seed.js';
import { CollectiveService } from '../src/service.js';
import { Scheduler } from '../src/scheduler.js';
import { WorkerLifecycle, type WorkerBackend } from '../src/workers/lifecycle.js';
import { WorkerRepository, workerName, registrationName, type WorkerIntent } from '../src/workers/repository.js';
import { SandboxBackend, type CommandRunner } from '../src/workers/sandbox.js';
import { readMcpLaunch } from '../src/mcp-launch.js';

const image = `docker.io/docker/sandbox-templates:claude-code-docker@sha256:${'a'.repeat(64)}`;
const launch = { endpoint: 'http://127.0.0.1:4310/agent/tools', token: 'a'.repeat(64) };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'collective-lifecycle-'));
  const store = new Store(join(dir, 'db.sqlite')); seed(store);
  store.patch('missions', 'mission_first', { status: 'active' }); store.patch('settings', 'settings', { paused: false });
  const job = store.enqueue('atlas', 'task', {}, 'lifecycle-test'); store.claimJob();
  const run = store.put('runs', { id: id('run'), jobId: job.id, agentId: 'atlas', attempt: 1, status: 'running', startedAt: nowIso(), inputTokens: 0, outputTokens: 0, estimatedCost: 0, turns: 0 });
  const repo = new WorkerRepository(store);
  const config = { root: process.cwd(), dataDir: dir, mode: 'simulation' as const, port: 4310, claudeBin: 'unused', operatorIds: [] };
  const service = new CollectiveService(store, config);
  const scheduler = new Scheduler(store, config, service, { execute: async () => { throw Error('unused'); } });
  scheduler.controllers.set(run.id, new AbortController());
  const calls: string[] = [];
  const backend: WorkerBackend = {
    preflight: async intent => { calls.push('preflight'); assert.equal(repo.get(intent.id)!.phase, 'planned'); },
    provision: async (intent, path) => {
      calls.push('provision'); assert.equal(store.inTransaction, false); assert.equal(repo.get(intent.id)!.dispatched, true);
      assert.deepEqual(readMcpLaunch(path), launch);
    },
    remove: async intent => { calls.push('remove'); assert.ok(repo.get(intent.id)!.revokedAt); assert.equal(scheduler.authenticateRun(launch.token), undefined); },
  };
  const lifecycle = new WorkerLifecycle(store, dir, backend, runId => scheduler.revokeRun(runId));
  return { dir, store, run, repo, backend, calls, lifecycle, scheduler, service,
    close() { service.knowledge.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('lifecycle persists intent before dispatch and revokes before verified cleanup', async () => {
  const s = fixture();
  try {
    await s.lifecycle.reconcile();
    const token = s.scheduler.grantRun(s.run.id);
    const result = await s.lifecycle.execute(s.run.id, image, launch, new AbortController().signal, async intent => {
      assert.equal(s.scheduler.authenticateRun(token)?.run.id, s.run.id);
      assert.equal(s.repo.get(intent.id)!.phase, 'ready'); return 'artifact';
    });
    assert.equal(result, 'artifact'); assert.equal(s.repo.forRun(s.run.id)!.phase, 'removed');
    assert.equal(existsSync(s.lifecycle.launchFile(s.repo.forRun(s.run.id)!)), false);
    assert.equal(s.scheduler.authenticateRun(token), undefined);
    assert.deepEqual(s.calls, ['preflight', 'provision', 'remove']);
    assert.throws(() => s.repo.update(s.repo.forRun(s.run.id)!.id, { phase: 'ready' }), /reopened/);
  } finally { s.close(); }
});

test('preflight and local dispatch-write failures create no external resources', async () => {
  for (const failure of ['preflight', 'write']) {
    const s = fixture();
    try {
      await s.lifecycle.reconcile();
      if (failure === 'preflight') s.backend.preflight = async () => { throw Error('preflight failed'); };
      else s.store.db.exec("CREATE TEMP TRIGGER fail_dispatch BEFORE UPDATE ON worker_intents WHEN NEW.phase='provisioning' BEGIN SELECT RAISE(ABORT,'dispatch failed'); END;");
      await assert.rejects(s.lifecycle.execute(s.run.id, image, launch, new AbortController().signal, async () => assert.fail('worker started')));
      assert.equal(s.repo.forRun(s.run.id)!.phase, 'removed'); assert.equal(s.repo.forRun(s.run.id)!.dispatched, false);
      assert.ok(!s.calls.includes('provision')); assert.ok(!s.calls.includes('remove'));
    } finally { s.close(); }
  }
});

test('lost provision acknowledgement remains unknown even when cleanup currently sees absence', async () => {
  const s = fixture();
  try {
    await s.lifecycle.reconcile();
    s.store.db.exec("CREATE TEMP TRIGGER fail_ack BEFORE UPDATE ON worker_intents WHEN json_extract(NEW.data,'$.provisioned')=1 BEGIN SELECT RAISE(ABORT,'lost acknowledgement'); END;");
    await assert.rejects(s.lifecycle.execute(s.run.id, image, launch, new AbortController().signal, async () => assert.fail()), /unresolved/);
    const intent = s.repo.forRun(s.run.id)!;
    assert.equal(intent.phase, 'unknown'); assert.equal(intent.provisioned, false);
    assert.match(s.scheduler.blockReason()!, /reconciliation/); assert.equal(s.calls.at(-1), 'remove');
    assert.equal(existsSync(s.lifecycle.launchFile(intent)), false);
    const recovery = new WorkerLifecycle(s.store, s.dir, s.backend, () => {}); await recovery.reconcile();
    assert.equal(s.repo.get(intent.id)!.phase, 'unknown');
    await assert.rejects(recovery.execute(s.run.id, image, launch, new AbortController().signal, async () => {}), /reconciliation/);
  } finally { s.close(); }
});

test('cleanup failure persists a global admission block and does not retain launch credentials', async () => {
  const s = fixture();
  try {
    await s.lifecycle.reconcile(); s.backend.remove = async () => { throw Error('daemon unavailable'); };
    await assert.rejects(s.lifecycle.execute(s.run.id, image, launch, new AbortController().signal, async () => 1), /unresolved/);
    const intent = s.repo.forRun(s.run.id)!; assert.equal(intent.phase, 'unknown'); assert.equal(intent.provisioned, true);
    assert.equal(existsSync(s.lifecycle.launchFile(intent)), false); assert.match(s.scheduler.blockReason()!, /reconciliation/);
    s.backend.remove = async () => {};
    const recovery = new WorkerLifecycle(s.store, s.dir, s.backend, () => {}); await recovery.reconcile();
    assert.equal(s.repo.get(intent.id)!.phase, 'removed');
  } finally { s.close(); }
});

test('persistence failures during cleanup still revoke tokens and attempt external removal', async () => {
  for (const phase of ['stopping', 'removed']) {
    const s = fixture();
    try {
      await s.lifecycle.reconcile(); const token = s.scheduler.grantRun(s.run.id);
      let removals = 0;
      s.backend.remove = async () => { removals++; assert.equal(s.scheduler.authenticateRun(token), undefined); };
      s.store.db.exec(`CREATE TEMP TRIGGER fail_cleanup BEFORE UPDATE ON worker_intents WHEN NEW.phase='${phase}' BEGIN SELECT RAISE(ABORT,'lost cleanup acknowledgement'); END;`);
      await assert.rejects(s.lifecycle.execute(s.run.id, image, launch, new AbortController().signal, async () => 1), /unresolved/);
      assert.equal(removals, 1); assert.match(s.scheduler.blockReason()!, /reconciliation/);
      assert.equal(existsSync(s.lifecycle.launchFile(s.repo.forRun(s.run.id)!)), false);
      s.store.db.exec('DROP TRIGGER fail_cleanup');
      const recovery = new WorkerLifecycle(s.store, s.dir, s.backend, () => {}); await recovery.reconcile();
      assert.equal(s.repo.forRun(s.run.id)!.phase, 'removed'); assert.equal(removals, 2);
    } finally { s.close(); }
  }
});

test('durable worker phase independently fences tool access and invalid images never allocate', () => {
  const s = fixture();
  try {
    const token = s.scheduler.grantRun(s.run.id);
    assert.throws(() => s.repo.reserve(s.run.id, 'mutable:latest')); assert.equal(s.repo.pending().length, 0);
    const intent = s.repo.reserve(s.run.id, image); assert.equal(s.scheduler.authenticateRun(token), undefined);
    s.repo.update(intent.id, { phase: 'provisioning', dispatched: true }); assert.equal(s.scheduler.authenticateRun(token), undefined);
    s.repo.update(intent.id, { phase: 'ready', provisioned: true }); assert.ok(s.scheduler.authenticateRun(token));
    s.repo.update(intent.id, { phase: 'stopping', revokedAt: nowIso() }); assert.equal(s.scheduler.authenticateRun(token), undefined);
    assert.throws(() => s.repo.update(intent.id, { phase: 'ready', revokedAt: undefined }), /transition|reset/);
  } finally { s.close(); }
});

test('deadline and shutdown stop even a worker callback that ignores cancellation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['deadline', 'shutdown']) {
    const s = fixture();
    try {
      s.store.patch('settings', 'settings', { maxRunSeconds: 1 }); await s.lifecycle.reconcile();
      let ready!: () => void; const started = new Promise<void>(r => { ready = r; });
      const done = s.lifecycle.execute(s.run.id, image, launch, new AbortController().signal, async () => { ready(); return new Promise(() => {}); });
      const rejected = assert.rejects(done, /cancelled|deadline/); await started;
      if (action === 'deadline') context.mock.timers.tick(1000); else await s.lifecycle.shutdown();
      await rejected; assert.equal(s.repo.forRun(s.run.id)!.phase, 'removed');
    } finally { s.close(); }
  }
});

test('pause during provisioning revokes immediately and preserves unacknowledged dispatch', async () => {
  const s = fixture();
  try {
    await s.lifecycle.reconcile();
    let ready!: () => void; const started = new Promise<void>(r => { ready = r; });
    s.backend.provision = async (_intent, _file, signal) => { ready(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true })); };
    const token = s.scheduler.grantRun(s.run.id), signal = s.scheduler.controllers.get(s.run.id)!.signal;
    const rejected = assert.rejects(s.lifecycle.execute(s.run.id, image, launch, signal, async () => assert.fail()), /unresolved/);
    await started; s.scheduler.pause(); assert.equal(s.scheduler.authenticateRun(token), undefined); await rejected;
    assert.equal(s.repo.forRun(s.run.id)!.phase, 'unknown');
  } finally { s.close(); }
});

test('restart reconciles persisted intents independently of the original process map', async () => {
  for (const phase of ['planned', 'provisioning', 'ready', 'stopping'] as const) {
    const s = fixture(); let reopened: Store | undefined;
    try {
      let intent = s.repo.reserve(s.run.id, image);
      assert.throws(() => s.repo.reserve(s.run.id, image), /UNIQUE/);
      if (phase !== 'planned') intent = s.repo.update(intent.id, { phase: 'provisioning', dispatched: true });
      if (['ready', 'stopping'].includes(phase)) intent = s.repo.update(intent.id, { phase: 'ready', provisioned: true });
      if (phase === 'stopping') intent = s.repo.update(intent.id, { phase: 'stopping', revokedAt: nowIso() });
      const file = s.lifecycle.launchFile(intent); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(launch), { mode: 0o600 });
      reopened = new Store(join(s.dir, 'db.sqlite')); reopened.recover();
      const repo = new WorkerRepository(reopened); let removals = 0;
      const recovery = new WorkerLifecycle(reopened, s.dir, { ...s.backend, remove: async () => { removals++; } }, () => {});
      await recovery.reconcile();
      assert.equal(repo.get(intent.id)!.phase, phase === 'provisioning' ? 'unknown' : 'removed');
      assert.equal(removals, phase === 'planned' ? 0 : 1); assert.equal(existsSync(file), false);
      assert.equal(reopened.require('runs', s.run.id).status, 'interrupted');
      assert.equal(repo.blockReason(new Set()) !== undefined, phase === 'provisioning');
    } finally { reopened?.close(); s.close(); }
  }
});

test('sandbox cleanup touches only owned resources and rejects malformed or incomplete absence evidence', async () => {
  for (const defect of ['none', 'malformed', 'remaining', 'host-process']) {
    const s = fixture();
    try {
      const intent = s.repo.reserve(s.run.id, image), name = workerName(intent), registration = registrationName(intent);
      const vms = new Set([name, 'unrelated-vm']), servers = new Set([registration, 'unrelated-tools']);
      const command: CommandRunner = async (bin, args, options) => {
        assert.ok(options?.timeoutMs);
        let stdout = '', code = 0;
        if (bin === 'pgrep') code = defect === 'host-process' ? 0 : 1;
        else if (args[0] === 'ls') stdout = defect === 'malformed' ? '{}' : JSON.stringify({ sandboxes: [...vms].map(name => ({ name, status: 'running' })) });
        else if (args[0] === 'stop') assert.equal(args[1], name);
        else if (args[0] === 'rm') { assert.equal(args[2], name); if (defect !== 'remaining') vms.delete(name); }
        else if (args[1] === 'ls') stdout = [...servers].join('\n');
        else if (args[1] === 'rm') { assert.equal(args[3], registration); servers.delete(registration); }
        else assert.fail(`Unexpected command ${args}`);
        return { code, stdout, stderr: '' };
      };
      const backend = new SandboxBackend(process.cwd(), command);
      if (defect === 'none') await backend.remove(intent, s.lifecycle.launchFile(intent));
      else await assert.rejects(backend.remove(intent, s.lifecycle.launchFile(intent)), /cleanup/);
      assert.ok(vms.has('unrelated-vm')); assert.ok(servers.has('unrelated-tools')); assert.equal(servers.has(registration), false);
    } finally { s.close(); }
  }
});

test('sandbox provision rejects unexpected image digests and host mounts', async () => {
  for (const defect of ['digest', 'mount']) {
    const s = fixture();
    try {
      const intent = s.repo.reserve(s.run.id, image);
      const command: CommandRunner = async (_bin, args) => ({ code: 0, stderr: '', stdout: args[0] === 'inspect'
        ? JSON.stringify({ image_digest: defect === 'digest' ? `sha256:${'b'.repeat(64)}` : image.split('@')[1], runtime_mounts: defect === 'mount' ? ['/host'] : [] }) : '' });
      const backend = new SandboxBackend(process.cwd(), command);
      await assert.rejects(backend.provision(intent, s.lifecycle.launchFile(intent), new AbortController().signal), /differs/);
    } finally { s.close(); }
  }
});
