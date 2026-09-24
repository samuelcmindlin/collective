import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Store } from '../src/store.js';
import { seed } from '../src/seed.js';
import { CollectiveService } from '../src/service.js';
import { Scheduler } from '../src/scheduler.js';
import { DiscordBridge } from '../src/discord.js';
import { createHttpServer } from '../src/http.js';
import { hashRecord } from '../src/progress/checks.js';
import type { Config } from '../src/config.js';
import type { Task } from '../src/types.js';
import { runCommand } from './worker-command.js';
import { domainResults } from './domain-bridge-protocol.js';
import { scenarioSourceHash } from './scenario-source.js';

const option = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const image = option('--image');
if (!image) throw new Error('Usage: npm run bridge:rehearse -- --image <cached-template> [--output path]');
const root = resolve(import.meta.dirname, '..'), dir = mkdtempSync(join(tmpdir(), 'collective-domain-'));
const output = resolve(option('--output') ?? 'test-results/domain-bridge.json');
const name = `collective-domain-${randomUUID()}`, registration = `${name}-tools`;
let registered = false, created = false, cleaning = false;
const controller = new AbortController(), cancel = () => controller.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
const report: Record<string, unknown> = { version: 1, authority: 'maintainer-domain-bridge-rehearsal',
  modelInvoked: false, productionExecutionEnabled: false, createdAt: new Date().toISOString(),
  image, name, registration, result: 'incomplete',
  sourceHash: scenarioSourceHash(root) };
const save = () => { mkdirSync(dirname(output), { recursive: true }); const temporary = `${output}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); renameSync(temporary, output); };
const command = async (args: string[], timeoutMs = 15000) => {
  const result = await runCommand('sbx', args, { timeoutMs, signal: cleaning ? undefined : controller.signal });
  assert.ok(result.code === 0 && !result.stopped, `sbx ${args[0]} failed (${result.stopped ?? result.code}): ${result.stderr.slice(0, 1000)}`);
  return result.stdout.trim();
};
const store = new Store(join(dir, 'db.sqlite')); seed(store);
const config: Config = { root, dataDir: dir, port: 0, mode: 'simulation', claudeBin: 'unused', operatorIds: [] };
const service = new CollectiveService(store, config);
const scheduler = new Scheduler(store, config, service, { execute: async () => { throw new Error('Unconfigured worker.'); } });
const server = createHttpServer(service, scheduler, new DiscordBridge(service, config, scheduler), config);
let ready!: () => void, release!: () => void;
const started = new Promise<void>(r => { ready = r; }), released = new Promise<void>(r => { release = r; });
const launchFile = join(dir, 'launch.json');
const invoke = async (operations: { name: string; arguments: Record<string, unknown> }[]) => {
  writeFileSync(join(dir, 'input.json'), JSON.stringify(operations));
  await command(['cp', join(dir, 'input.json'), `${name}:/home/agent/workspace/domain-input.json`]);
  const result = await command(['exec', name, 'node', '/home/agent/workspace/domain-client.cjs'], 60000);
  return domainResults(result, operations.map(o => o.name));
};
try {
  save();
  assert.equal(await command(['mcp', 'ls', '--quiet']), '', 'Requires an empty local MCP registry.');
  for (const [key, value] of [['mcp.forceLocalGateway', 'true'], ['ssh.agentForwardingEnabled', 'false'], ['skills.defaultMode', 'off'], ['clipboard.imagePaste', 'false']]) {
    assert.equal(await command(['settings', 'get', key!]), value);
  }
  await new Promise<void>((ok, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ok); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); config.port = address.port;
  service.setMission('Run-scoped bridge', 'Exercise authenticated domain tools from a restricted VM.', ['Only current run authority can mutate this fixture.'], 'operator');
  const note = service.knowledge.write('nova', { title: 'Bridge constraint', content: 'The palette is teal.', kind: 'decision' });
  const makeTask = (ownerId: string) => service.tool('nova', 'task_create', { title: `${ownerId} task`, description: 'Scope probe', ownerId, acceptance: 'Scope preserved' }) as Promise<Task>;
  const own = await makeTask('atlas'), foreign = await makeTask('iris');
  for (const job of store.all('jobs')) store.patch('jobs', job.id, { status: 'cancelled' });
  scheduler.harness = { execute: async (_agent, job, run) => {
    writeFileSync(launchFile, JSON.stringify({ endpoint: `http://127.0.0.1:${config.port}/agent/tools`, token: scheduler.grantRun(run.id) }), { mode: 0o600 });
    report.run = { id: run.id, jobId: job.id, attempt: run.attempt, agentId: run.agentId, missionRevision: job.missionRevision };
    ready(); await released;
    return { summary: 'Synthetic VM domain probe.', inputTokens: 0, outputTokens: 0, estimatedCost: 0, turns: 0 };
  } };
  store.enqueue('atlas', 'task', {}, 'bridge-run'); store.patch('settings', 'settings', { paused: false, maxConcurrent: 1 });
  await scheduler.tick();
  await new Promise<void>((ok, reject) => {
    const abort = () => finish(() => reject(new Error('Bridge rehearsal cancelled.')));
    const timer = setTimeout(() => finish(() => reject(new Error('Bridge run failed to start.'))), 15000);
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer); controller.signal.removeEventListener('abort', abort); action();
    };
    controller.signal.addEventListener('abort', abort, { once: true });
    started.then(() => finish(ok), error => finish(() => reject(error)));
    if (controller.signal.aborted) abort();
  });
  const bundle = join(dir, 'client.cjs');
  await build({ entryPoints: [join(root, 'scripts/fixtures/domain-bridge-client.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
  report.bundleHash = hashRecord(readFileSync(bundle, 'utf8'));
  registered = true; report.registrationAttempted = true; save();
  await command(['mcp', 'add', registration, '--command', process.execPath, '--args',
    ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), join(root, 'src/mcp-worker.ts'), '--launch-file', launchFile].join(','), '--dir', root]);
  created = true; report.creationAttempted = true; save();
  console.log('Starting the synthetic VM with one host-bound run identity.');
  await command(['create', '--name', name, '--cpus', '2', '--memory', '2g', '--skills', 'off', '--deny-network', '**', '--pull', 'never', '--template', image, '--static-mcp', registration, 'claude'], 120000);
  const metadata = JSON.parse(await command(['inspect', name, '--json']));
  report.runtime = { image: metadata.image, imageDigest: metadata.image_digest, mounts: metadata.runtime_mounts };
  assert.deepEqual(metadata.runtime_mounts, []);
  if (image.includes('@sha256:')) assert.equal(metadata.image_digest, image.split('@')[1], 'Runtime image does not match the requested pin.');
  await command(['cp', bundle, `${name}:/home/agent/workspace/domain-client.cjs`]);
  const update = { name: 'task_update', arguments: { taskId: own.id, status: 'doing', commandId: 'bridge-start' } };
  const observations = await invoke([
    { name: 'collective_context', arguments: {} }, { name: 'knowledge_get', arguments: { revisionId: note.id } },
    update, update, { name: 'task_update', arguments: { taskId: foreign.id, status: 'doing', commandId: 'bridge-forged-owner' } },
  ]);
  assert.equal(observations[0]!.isError, false); assert.equal(observations[0]!.value.you.id, 'atlas');
  assert.equal(observations[1]!.isError, false); assert.equal(observations[1]!.value.content, note.content);
  assert.equal(observations[2]!.isError, false); assert.equal(observations[2]!.value.status, 'doing');
  assert.equal(observations[3]!.isError, false); assert.deepEqual(observations[2]!.value, observations[3]!.value);
  assert.equal(observations[4]!.isError, true); assert.match(observations[4]!.value.error, /own/);
  assert.equal(store.require('tasks', foreign.id).status, foreign.status);
  report.active = { authenticatedAs: 'atlas', retrievedRevision: note.id, ownedMutation: true, retrySameReceipt: true, foreignMutationDenied: true }; save();
  scheduler.pause();
  const denied = await invoke([{ name: 'collective_context', arguments: {} }, update]);
  for (const result of denied) { assert.equal(result.isError, true); assert.match(result.value.error, /Run token is missing, expired, or inactive/); }
  report.paused = { readDenied: true, writeDenied: true }; save();
  await command(['stop', name], 30000);
  const stopped = JSON.parse(await command(['ls', '--json'])); assert.equal(stopped.sandboxes.find((s: { name: string }) => s.name === name)?.status, 'stopped');
  // Unpausing the operator must not revive the aborted attempt's authority.
  store.patch('settings', 'settings', { paused: false });
  const afterRestart = await invoke([{ name: 'collective_context', arguments: {} }]);
  assert.equal(afterRestart[0]!.isError, true); assert.match(afterRestart[0]!.value.error, /Run token is missing, expired, or inactive/);
  report.restarted = { operatorPaused: false, revokedAuthorityStillDenied: true }; report.result = 'awaiting-cleanup';
} catch (error) { report.result = controller.signal.aborted ? 'cancelled' : 'error'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  cleaning = true; scheduler.pause(); release();
  const cleanup: Record<string, unknown>[] = []; report.cleanup = cleanup;
  const clean = async (label: string, action: () => unknown | Promise<unknown>) => {
    try { await action(); cleanup.push({ resource: label, removed: true }); }
    catch (error) { report.result = 'error'; report.error = [report.error, `${label}: ${String(error)}`].filter(Boolean).join('; ');
      process.exitCode = 1; cleanup.push({ resource: label, error: String(error) }); }
    try { save(); } catch { report.result = 'error'; process.exitCode = 1; }
  };
  await clean('intent checkpoint', save);
  if (created) await clean(name, async () => {
    await command(['rm', '--force', name], 30000);
    assert.ok(!JSON.parse(await command(['ls', '--json'])).sandboxes.some((s: { name: string }) => s.name === name));
  });
  if (registered) await clean(registration, async () => {
    await command(['mcp', 'rm', '--force', registration]); assert.ok(!(await command(['mcp', 'ls', '--quiet'])).split('\n').includes(registration));
  });
  await clean('host MCP subprocess', async () => {
    // A full process listing can exceed the command output budget on a busy host.
    // Search only this unguessable, host-owned launch-file identity; pgrep does
    // not match its own process. No command lines or credentials enter the report.
    const result = await runCommand('pgrep', ['-f', launchFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]);
    assert.equal(result.stopped, undefined);
    assert.equal(result.code, 1, 'The fixture MCP subprocess is still running or its absence could not be verified.');
  });
  await clean('scheduler', async () => { await scheduler.stop(); assert.equal(scheduler.controllers.size, 0); });
  await clean('HTTP server', async () => { server.closeAllConnections(); if (server.listening) await new Promise<void>((ok, reject) => server.close(error => error ? reject(error) : ok())); });
  await clean('knowledge index', () => service.knowledge.close());
  await clean('database', () => store.close());
  await clean('private fixture', () => rmSync(dir, { recursive: true, force: true }));
  if (report.result === 'awaiting-cleanup' && !controller.signal.aborted) report.result = 'pass';
  else if (controller.signal.aborted && report.result !== 'error') { report.result = 'cancelled'; process.exitCode = 1; }
  try { save(); } catch { process.exitCode = 1; }
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  console.log(JSON.stringify({ result: report.result, output, error: report.error }));
}
