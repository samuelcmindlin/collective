import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { build } from 'esbuild';
import { Store } from '../src/store.js';
import { seed } from '../src/seed.js';
import { CollectiveService } from '../src/service.js';
import { Scheduler } from '../src/scheduler.js';
import { DiscordBridge } from '../src/discord.js';
import { createHttpServer } from '../src/http.js';
import { WorkerLifecycle } from '../src/workers/lifecycle.js';
import { SandboxBackend } from '../src/workers/sandbox.js';
import { WorkerRepository, workerName, pinnedImage } from '../src/workers/repository.js';
import { runCommand } from '../src/workers/command.js';
import { domainResults } from './domain-bridge-protocol.js';
import { scenarioSourceHash } from './scenario-source.js';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const image = pinnedImage.parse(option('--image'));
const root = resolve(import.meta.dirname, '..');
const childDir = option('--child');

async function command(args: string[], signal?: AbortSignal) {
  const result = await runCommand('sbx', args, { signal, timeoutMs: 30000 });
  assert.ok(result.code === 0 && !result.stopped, `Sandbox ${args[0]} failed: ${result.stopped ?? result.code}`);
  return result.stdout;
}

async function child(dir: string, mode: string) {
  assert.ok(['crash', 'pause'].includes(mode));
  const store = new Store(join(dir, 'db.sqlite')); seed(store);
  const config = { root, dataDir: dir, port: 0, mode: 'simulation' as const, claudeBin: 'unused', operatorIds: [] };
  const service = new CollectiveService(store, config);
  const scheduler = new Scheduler(store, config, service, { execute: async () => { throw Error('Unconfigured'); } });
  const lifecycle = new WorkerLifecycle(store, dir, new SandboxBackend(root), id => scheduler.revokeRun(id));
  await lifecycle.reconcile();
  const server = createHttpServer(service, scheduler, new DiscordBridge(service, config, scheduler), config);
  await new Promise<void>((ok, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ok); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); config.port = address.port;
  const bundle = join(dir, 'client.cjs');
  await build({ entryPoints: [join(root, 'scripts/fixtures/domain-bridge-client.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
  writeFileSync(join(dir, 'input.json'), JSON.stringify([{ name: 'collective_context', arguments: {} }]));
  service.setMission('Lifecycle rehearsal', 'Verify termination and recovery of owned sandbox resources.', [], 'operator');
  for (const job of store.all('jobs')) store.patch('jobs', job.id, { status: 'cancelled' });
  store.enqueue('atlas', 'task', {}, 'lifecycle-rehearsal'); store.patch('settings', 'settings', { paused: false, maxConcurrent: 1 });
  let finish!: () => void, failure: unknown;
  const finished = new Promise<void>(r => { finish = r; });
  scheduler.harness = { execute: async (_agent, _job, run, signal) => {
    try {
      const token = scheduler.grantRun(run.id);
      await lifecycle.execute(run.id, image, { endpoint: `http://127.0.0.1:${config.port}/agent/tools`, token }, signal, async (intent, workerSignal) => {
        const name = workerName(intent);
        await command(['cp', bundle, `${name}:/home/agent/workspace/domain-client.cjs`], workerSignal);
        await command(['cp', join(dir, 'input.json'), `${name}:/home/agent/workspace/domain-input.json`], workerSignal);
        const result = domainResults(await command(['exec', name, 'node', '/home/agent/workspace/domain-client.cjs'], workerSignal), ['collective_context']);
        assert.equal(result[0]!.isError, false); assert.equal(result[0]!.value.you.id, 'atlas');
        writeFileSync(join(dir, 'observed.json'), JSON.stringify({ intentId: intent.id, runId: run.id, phase: intent.phase, authenticatedAs: 'atlas', mode }), { mode: 0o600 });
        if (mode === 'crash') process.kill(process.pid, 'SIGKILL');
        else { scheduler.pause(); assert.equal(scheduler.authenticateRun(token), undefined); }
        // Pause must clean up even if this work callback never returns.
        await new Promise(() => {});
      });
    } catch (error) {
      const worker = lifecycle.repository.forRun(run.id);
      if (!(mode === 'pause' && signal.aborted && worker?.phase === 'removed')) failure = error;
    } finally { finish(); }
    return { summary: 'Synthetic lifecycle episode', inputTokens: 0, outputTokens: 0, estimatedCost: 0, turns: 0, interrupted: true };
  } };
  try { await scheduler.tick(); await finished; if (failure) throw failure; }
  finally { await lifecycle.shutdown(); await scheduler.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); service.knowledge.close(); store.close(); }
}

if (childDir) await child(resolve(childDir), option('--mode') ?? 'crash');
else {
  const output = resolve(option('--output') ?? 'test-results/worker-lifecycle.json');
  const report: Record<string, unknown> = { version: 1, modelInvoked: false, productionExecutionEnabled: false,
    sourceHash: scenarioSourceHash(root), image, result: 'incomplete', trials: [] };
  const save = () => { mkdirSync(dirname(output), { recursive: true }); const temp = `${output}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, output); };
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const before = JSON.parse(await command(['ls', '--json'])).sandboxes.map((vm: { name: string }) => vm.name).sort();
    for (const mode of ['pause', 'crash']) {
      controller.signal.throwIfAborted();
      const dir = mkdtempSync(join(tmpdir(), 'collective-lifecycle-vm-'));
      const trial: Record<string, unknown> = { mode, directory: dir, result: 'incomplete' };
      (report.trials as unknown[]).push(trial); save();
      console.log(`Testing ${mode} with a synthetic worker VM.`);
      const childResult = await runCommand(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), import.meta.filename, '--child', dir, '--mode', mode, '--image', image], { timeoutMs: 240000, signal: controller.signal });
      // Always reconcile after the child ends, even on cancellation or failure.
      const store = new Store(join(dir, 'db.sqlite')); const repo = new WorkerRepository(store);
      let unresolved = true;
      try {
        const beforeRecovery = repo.pending().map(i => ({ id: i.id, phase: i.phase, provisioned: i.provisioned }));
        store.recover(); const blockedBefore = !!repo.blockReason(new Set());
        const recovery = new WorkerLifecycle(store, dir, new SandboxBackend(root), () => {}); await recovery.reconcile();
        unresolved = repo.pending().length > 0;
        Object.assign(trial, { beforeRecovery, blockedBefore, unresolved, childCode: childResult.code, childStopped: childResult.stopped });
        assert.equal(unresolved, false, 'Cleanup is unresolved; fixture ledger retained.');
        assert.equal(childResult.stopped, undefined); assert.equal(childResult.code, mode === 'pause' ? 0 : null);
        const observed = JSON.parse(readFileSync(join(dir, 'observed.json'), 'utf8'));
        assert.equal(observed.authenticatedAs, 'atlas'); assert.equal(observed.phase, 'ready');
        assert.equal(repo.get(observed.intentId)!.phase, 'removed');
        assert.equal(existsSync(recovery.launchFile(repo.get(observed.intentId)!)), false);
        assert.equal(blockedBefore, mode === 'crash');
        if (mode === 'crash') assert.equal(store.require('runs', observed.runId).status, 'interrupted');
        trial.observed = observed; trial.result = 'pass';
      } finally { store.close(); if (!unresolved) { rmSync(dir, { recursive: true, force: true }); trial.fixtureRemoved = !existsSync(dir); } save(); }
    }
    const after = JSON.parse(await command(['ls', '--json'])).sandboxes.map((vm: { name: string }) => vm.name).sort();
    assert.deepEqual(after, before); report.unrelatedVMInventoryPreserved = true; report.result = 'pass';
  } catch (error) { report.result = 'error'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
  finally { save(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); console.log(JSON.stringify({ result: report.result, output, error: report.error })); }
}
