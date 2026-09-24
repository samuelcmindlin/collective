import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Maintainer-operated compatibility experiment. No model, host mounts, or policy changes.
const option = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const image = option('--image');
if (!image) throw new Error('Usage: npm run worker:rehearse -- --image <cached-template> [--output path]');
const output = resolve(option('--output') ?? 'test-results/worker-rehearsal.json');
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = readFileSync(join(root, 'scripts/fixtures/worker-probe.mjs'), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'collective-worker-'));
const names = ['a', 'b'].map(suffix => `collective-probe-${randomUUID().slice(0, 8)}-${suffix}`);
const attempted = [];
const report = { createdAt: new Date().toISOString(), authority: 'synthetic-worker-rehearsal', image,
  fixtureSha256: createHash('sha256').update(fixture).digest('hex'), names,
  productionExecutionEnabled: false, modelInvoked: false, checks: {}, cleanup: [] };
const check = (name, value) => { report.checks[name] = value; assert.equal(value, true, name); };
const command = (args, input = '', timeoutMs = 15000) => new Promise((resolve, reject) => {
  const child = spawn('sbx', args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let stdout = '', stderr = '', size = 0, failure, settled = false;
  const killGroup = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const finish = code => {
    if (settled) return; settled = true; clearTimeout(timer);
    if (code !== 0 || failure) reject(new Error(`sbx ${args[0]} failed (${failure ?? code}): ${stderr.slice(0, 2000)}`));
    else resolve(stdout.trim());
  };
  const stop = reason => {
    failure ??= reason; killGroup(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); finish(null);
  };
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  for (const [stream, channel] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', chunk => {
    size += chunk.length; if (size > 128 * 1024) return stop('output limit');
    if (channel === 'stdout') stdout += chunk; else stderr += chunk;
  });
  child.stdin.on('error', () => {});
  child.once('error', () => stop('spawn error'));
  child.once('exit', killGroup);
  child.once('close', finish);
  child.stdin.end(input);
});
// sbx writes a startup notice before exec output; require our final structured record.
const parseProbe = text => JSON.parse(text.split('\n').findLast(line => line.startsWith('{')) ?? 'null');
const probe = (name, input) => command(['exec', '-i', name, 'node', '--input-type=module', '--eval', fixture], JSON.stringify(input), 30000).then(parseProbe);
let hostRequests = 0;
const server = createServer((req, res) => { hostRequests++; res.end('synthetic operator'); });
const socketServer = createSocketServer(connection => connection.destroy());
try {
  console.log('Checking sandbox configuration');
  report.sbx = await command(['version']);
  // Inspect individual settings; never serialize credential stores or the complete environment.
  report.settings = {};
  for (const key of ['ssh.agentForwardingEnabled', 'skills.defaultMode', 'mcp.forceLocalGateway']) {
    report.settings[key] = await command(['settings', 'get', key]);
  }
  check('sshForwardingDisabled', report.settings['ssh.agentForwardingEnabled'] === 'false');
  check('sharedSkillsDisabled', report.settings['skills.defaultMode'] === 'off');
  check('hostLocalMcpRequired', report.settings['mcp.forceLocalGateway'] === 'true');
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const hostSshSocket = join(dir, 'synthetic.sock');
  await new Promise((done, reject) => { socketServer.once('error', reject); socketServer.listen(hostSshSocket, done); });
  const hostSentinel = join(dir, 'supervisor-state'), peerHostSentinel = join(dir, 'other-worker-state');
  writeFileSync(hostSentinel, 'synthetic supervisor'); writeFileSync(peerHostSentinel, 'synthetic peer');
  const input = { mode: 'setup', hostSentinel, peerHostSentinel, platformRoot: root, hostHome: homedir(),
    hostDockerSocket: join(homedir(), '.docker/run/docker.sock'), hostSshSocket, operatorPort: server.address().port };
  const snapshots = [];
  for (const [i, name] of names.entries()) {
    console.log(`Creating mountless worker ${i + 1}/2`);
    attempted.push(name); // Record before dispatch, so ambiguous creation still gets cleanup.
    await command(['create', '--name', name, '--cpus', '2', '--memory', '2g', '--skills', 'off', '--deny-network', '**', '--pull', 'never', '--template', image, 'claude'], '', 120000);
    snapshots.push(await probe(name, { ...input, marker: `private worker ${i}` }));
    report[`worker${i}`] = snapshots[i];
    for (const [key, value] of Object.entries(snapshots[i].observations)) check(`worker${i}:${key}`, value);
  }
  check('distinctKernels', snapshots[0].boot !== snapshots[1].boot);
  check('distinctDockerEngines', Boolean(snapshots[0].runtime.dockerId) && snapshots[0].runtime.dockerId !== snapshots[1].runtime.dockerId);
  const beforeStop = await probe(names[0], { mode: 'inspect' });
  report.beforeStop = beforeStop;
  check('peerCannotOverwritePrivateWorkspace', beforeStop.marker === 'private worker 0');
  check('heartbeatActiveBeforeStop', beforeStop.heartbeatBefore !== beforeStop.heartbeatAfter);
  console.log('Stopping and restarting the worker to check persistence and descendants');
  await command(['stop', names[0]], '', 30000);
  const listed = JSON.parse(await command(['ls', '--json']));
  check('workerReportedStopped', listed.sandboxes.find(s => s.name === names[0])?.status === 'stopped');
  const restarted = await probe(names[0], { mode: 'inspect' });
  report.afterRestart = restarted;
  check('privateFilesPersistAcrossStop', restarted.marker === beforeStop.marker);
  check('freshKernelAfterStop', restarted.boot !== beforeStop.boot);
  check('detachedProcessDoesNotResume', restarted.heartbeatBefore === restarted.heartbeatAfter);
  check('hostSentinelUnchanged', readFileSync(hostSentinel, 'utf8') === 'synthetic supervisor');
  check('peerHostSentinelUnchanged', readFileSync(peerHostSentinel, 'utf8') === 'synthetic peer');
  check('hostOperatorNeverReached', hostRequests === 0);
  report.result = 'pass';
} catch (error) {
  report.result = 'fail'; report.error = error.message; process.exitCode = 1;
} finally {
  console.log('Removing only the rehearsal VMs');
  for (const name of attempted) {
    try {
      await command(['rm', '--force', name], '', 30000);
      const listed = JSON.parse(await command(['ls', '--json']));
      const absent = !listed.sandboxes.some(s => s.name === name);
      report.cleanup.push({ name, absent });
      if (!absent) throw new Error('Sandbox still listed after removal');
    } catch (error) { report.cleanup.push({ name, error: error.message }); report.result = 'fail'; process.exitCode = 1; }
  }
  await new Promise(done => server.close(done));
  await new Promise(done => socketServer.close(done));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ result: report.result, checks: Object.keys(report.checks).length, output, error: report.error }));
}
