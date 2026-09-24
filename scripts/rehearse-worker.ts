import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createSocketServer, type Socket, type AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './worker-command.js';
import { parseSetup, parseInspect, verifySetup, verifyRestart, verifyDeniedPolicy, type SetupProbe } from './worker-protocol.js';

const option = (key: string) => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const image = option('--image');
if (!image) throw new Error('Usage: npm run worker:rehearse -- --image <cached-template> [--output path]');
const output = resolve(option('--output') ?? 'test-results/worker-rehearsal.json');
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = readFileSync(join(root, 'scripts/fixtures/worker-probe.mjs'), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'collective-worker-'));
const names = ['a', 'b'].map(suffix => `collective-probe-${randomUUID()}-${suffix}`);
const attempted: string[] = [];
const settings: Record<string, string> = {};
const report: Record<string, unknown> & { checks: Record<string, boolean>; cleanup: object[] } = {
  createdAt: new Date().toISOString(), authority: 'synthetic-worker-rehearsal', protocol: 2, image, names,
  sourceSha256: createHash('sha256').update(JSON.stringify(['scripts/rehearse-worker.ts', 'scripts/worker-command.ts',
    'scripts/worker-protocol.ts', 'scripts/fixtures/worker-probe.mjs'].map(p => [p, readFileSync(join(root, p), 'utf8')]))).digest('hex'),
  fixtureSha256: createHash('sha256').update(fixture).digest('hex'), settings,
  productionExecutionEnabled: false, modelInvoked: false, result: 'incomplete', checks: {}, cleanup: [], attempted,
};
const save = () => { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); };
const saveDuringCleanup = () => { try { save(); } catch { report.result = 'fail'; report.error = 'Report persistence failed; inspect the recorded VM identities before retrying.'; process.exitCode = 1; } };
const check = (name: string, value: boolean) => { report.checks[name] = value; assert.equal(value, true, name); };
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
let cleaning = false;
const command = async (args: string[], input = '', timeoutMs = 15000, expectedCode = 0) => {
  const result = await runCommand('sbx', args, { input, timeoutMs, signal: cleaning ? undefined : controller.signal });
  assert.ok(!result.stopped && result.code === expectedCode, `sbx ${args[0]} failed (${result.stopped ?? result.code}): ${result.stderr.slice(0, 2000)}`);
  return result.stdout.trim();
};
const probe = (name: string, input: object) => command(['exec', '-i', name, 'node', '--input-type=module', '--eval', fixture], JSON.stringify(input), 30000);
let hostConnections = 0, sshConnections = 0;
const connections = new Set<Socket>();
const server = createServer((_req, res) => res.end('synthetic operator'));
server.on('connection', socket => { hostConnections++; connections.add(socket); socket.once('close', () => connections.delete(socket)); });
const socketServer = createSocketServer(connection => { sshConnections++; connection.destroy(); });
try {
  save(); console.log('Checking sandbox configuration and positive network controls');
  report.sbx = await command(['version']);
  for (const key of ['ssh.agentForwardingEnabled', 'skills.defaultMode', 'mcp.forceLocalGateway', 'clipboard.imagePaste']) settings[key] = await command(['settings', 'get', key]);
  check('sshForwardingDisabled', settings['ssh.agentForwardingEnabled'] === 'false');
  check('sharedSkillsDisabled', settings['skills.defaultMode'] === 'off');
  check('hostLocalMcpRequired', settings['mcp.forceLocalGateway'] === 'true');
  check('clipboardImageReadDisabled', settings['clipboard.imagePaste'] === 'false');
  // Refuse an ambient tool registry. A future production adapter needs fixed per-VM membership.
  check('noRegisteredMcpServers', (await command(['mcp', 'ls', '--quiet'])) === '');
  const positive = await runCommand('curl', ['--noproxy', '*', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--connect-timeout', '3', '--max-time', '8', 'https://1.1.1.1'], { signal: controller.signal });
  report.hostNetworkControl = positive;
  check('hostCanReachDirectTlsDestination', positive.code === 0 && !positive.stopped && /^[23][0-9]{2}$/.test(positive.stdout));
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const hostSshSocket = join(dir, 'synthetic.sock');
  await new Promise<void>((done, reject) => { socketServer.once('error', reject); socketServer.listen(hostSshSocket, done); });
  const operatorPort = (server.address() as AddressInfo).port;
  const positiveLocal = await fetch(`http://127.0.0.1:${operatorPort}`, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(3000) });
  check('hostOperatorPositiveControl', await positiveLocal.text() === 'synthetic operator');
  hostConnections = 0;
  const hostSentinel = join(dir, 'supervisor-state'), peerHostSentinel = join(dir, 'other-worker-state');
  writeFileSync(hostSentinel, 'synthetic supervisor'); writeFileSync(peerHostSentinel, 'synthetic peer');
  const input = { mode: 'setup', hostSentinel, peerHostSentinel, platformRoot: root, hostHome: homedir(),
    hostDockerSocket: join(homedir(), '.docker/run/docker.sock'), hostSshSocket, operatorPort };
  const snapshots: SetupProbe[] = [], markers = names.map(() => randomUUID());
  for (const [i, name] of names.entries()) {
    console.log(`Creating mountless worker ${i + 1}/2`);
    attempted.push(name); save(); // Save identity before external creation, including ambiguous outcomes.
    await command(['create', '--name', name, '--cpus', '2', '--memory', '2g', '--skills', 'off', '--deny-network', '**', '--pull', 'never', '--template', image, 'claude'], '', 120000);
    const policies = [];
    for (const target of ['api.anthropic.com:443', 'api.github.com:443', 'example.com:443', '1.1.1.1:80', '1.1.1.1:443', `host.docker.internal:${operatorPort}`]) {
      policies.push(verifyDeniedPolicy(JSON.parse(await command(['policy', 'check', 'network', '--sandbox', name, '--json', target], '', 15000, 1))));
    }
    report[`worker${i}Policies`] = policies; check(`worker${i}:policiesDeny`, policies.length === 6);
    const snapshot = parseSetup(await probe(name, { ...input, marker: markers[i] }));
    report[`worker${i}`] = snapshot; verifySetup(snapshot, markers[i]!); snapshots.push(snapshot);
    for (const [key, value] of Object.entries(snapshot.observations)) check(`worker${i}:${key}`, value);
    check(`worker${i}:completeValidatedRecord`, true); save();
  }
  check('distinctKernels', snapshots[0]!.boot !== snapshots[1]!.boot);
  check('distinctDockerEngines', snapshots[0]!.runtime.dockerId !== snapshots[1]!.runtime.dockerId);
  const beforeStop = parseInspect(await probe(names[0]!, { mode: 'inspect' })); report.beforeStop = beforeStop;
  check('peerCannotOverwritePrivateWorkspace', beforeStop.marker === markers[0]);
  check('peerCannotOverwritePrivateSessionVolume', beforeStop.sessionMarker === markers[0]);
  console.log('Stopping and restarting the worker to check persistence and descendants');
  await command(['stop', names[0]!], '', 30000);
  const listed = JSON.parse(await command(['ls', '--json']));
  check('workerReportedStopped', listed.sandboxes.find((s: { name: string }) => s.name === names[0])?.status === 'stopped');
  const restarted = parseInspect(await probe(names[0]!, { mode: 'inspect' })); report.afterRestart = restarted;
  verifyRestart(beforeStop, restarted); check('restartEvidenceComplete', true);
  check('hostSentinelUnchanged', readFileSync(hostSentinel, 'utf8') === 'synthetic supervisor');
  check('peerHostSentinelUnchanged', readFileSync(peerHostSentinel, 'utf8') === 'synthetic peer');
  check('hostOperatorNeverReached', hostConnections === 0); check('hostSshNeverReached', sshConnections === 0);
  report.result = 'awaiting-cleanup';
} catch (error) {
  report.result = 'fail'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
  cleaning = true; saveDuringCleanup(); console.log('Removing only the rehearsal VMs');
  for (const name of attempted) {
    try {
      await command(['rm', '--force', name], '', 30000);
      const listed = JSON.parse(await command(['ls', '--json']));
      const absent = !listed.sandboxes.some((s: { name: string }) => s.name === name);
      assert.ok(absent, 'Sandbox still listed after removal'); report.cleanup.push({ name, absent });
    } catch (error) { report.cleanup.push({ name, error: error instanceof Error ? error.message : String(error) }); report.result = 'fail'; process.exitCode = 1; }
    saveDuringCleanup();
  }
  // Raw connections that never send HTTP must not prevent cleanup/report completion.
  for (const socket of connections) socket.destroy();
  await new Promise<void>(done => server.close(() => done()));
  await new Promise<void>(done => socketServer.close(() => done()));
  rmSync(dir, { recursive: true, force: true });
  if (report.result === 'awaiting-cleanup' && !controller.signal.aborted) report.result = 'pass';
  else if (controller.signal.aborted) { report.result = 'fail'; report.error = 'Rehearsal cancelled'; process.exitCode = 1; }
  saveDuringCleanup();
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  console.log(JSON.stringify({ result: report.result, checks: Object.keys(report.checks).length, output, error: report.error }));
}
