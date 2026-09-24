import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { runCommand } from './worker-command.js';
import { verifyMcpScope } from './mcp-scope-protocol.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const option = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const image = option('--image');
if (!image) throw new Error('Usage: npm run mcp:rehearse -- --image <cached-template> [--output path]');
const output = resolve(option('--output') ?? 'test-results/mcp-scope-rehearsal.json');
const dir = mkdtempSync(join(tmpdir(), 'collective-mcp-'));
const name = `collective-mcp-${randomUUID()}`, allowed = `${name}-allowed`, unlisted = `${name}-unlisted`;
const registrations: string[] = []; let creationAttempted = false, cleaning = false;
const controller = new AbortController(), cancel = () => controller.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
const report: Record<string, unknown> = { createdAt: new Date().toISOString(), authority: 'synthetic-mcp-scope-rehearsal',
  productionExecutionEnabled: false, modelInvoked: false, image, name, registrations, result: 'incomplete',
  sourceSha256: createHash('sha256').update(JSON.stringify(['scripts/rehearse-mcp-scope.ts', 'scripts/mcp-scope-protocol.ts',
    'scripts/worker-command.ts', 'scripts/fixtures/mcp-scope-client.ts', 'scripts/fixtures/mcp-scope-server.mjs'].map(p => [p, readFileSync(join(root, p), 'utf8')]))).digest('hex') };
const save = () => { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); };
const checkpointCleanup = () => { try { save(); } catch { report.result = 'fail'; process.exitCode = 1; } };
const command = async (args: string[], timeoutMs = 15000) => {
  const value = await runCommand('sbx', args, { timeoutMs, signal: cleaning ? undefined : controller.signal });
  assert.ok(value.code === 0 && !value.stopped, `sbx ${args[0]} failed (${value.stopped ?? value.code}): ${value.stderr.slice(0, 1500)}`);
  return value.stdout.trim();
};
const register = async (serverName: string, label: string) => {
  registrations.push(serverName); save();
  await command(['mcp', 'add', serverName, '--command', process.execPath, '--args', `${join(root, 'scripts/fixtures/mcp-scope-server.mjs')},${label}`, '--dir', root]);
};
const execute = () => command(['exec', name, 'node', '/home/agent/workspace/mcp-scope-client.cjs'], 30000).then(verifyMcpScope);
try {
  save(); console.log('Preparing two pure arithmetic fixtures');
  assert.equal(await command(['mcp', 'ls', '--quiet']), '', 'This rehearsal requires an empty local MCP registry');
  for (const [key, expected] of [['mcp.forceLocalGateway', 'true'], ['ssh.agentForwardingEnabled', 'false'], ['skills.defaultMode', 'off'], ['clipboard.imagePaste', 'false']]) {
    assert.equal(await command(['settings', 'get', key!]), expected);
  }
  report.sbx = await command(['version']);
  const bundle = join(dir, 'client.cjs');
  await build({ entryPoints: [join(root, 'scripts/fixtures/mcp-scope-client.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
  report.clientBundleSha256 = createHash('sha256').update(readFileSync(bundle)).digest('hex');
  await register(allowed, 'allowed'); creationAttempted = true; report.creationAttempted = true; save();
  await command(['create', '--name', name, '--cpus', '2', '--memory', '2g', '--skills', 'off', '--deny-network', '**', '--pull', 'never', '--template', image, '--static-mcp', allowed, 'claude'], 120000);
  // Only keep public runtime metadata; inspect also contains credential descriptions.
  const metadata = JSON.parse(await command(['inspect', name, '--json']));
  report.runtime = { image: metadata.image, imageDigest: metadata.image_digest, daemonVersion: metadata.daemon_version, mounts: metadata.runtime_mounts };
  assert.deepEqual(metadata.runtime_mounts, []);
  await command(['cp', bundle, `${name}:/home/agent/workspace/mcp-scope-client.cjs`]);
  await register(unlisted, 'unlisted');
  console.log('Checking direct and indirect requests for an unlisted tool');
  report.beforeRestart = await execute(); save();
  await command(['stop', name], 30000);
  const stopped = JSON.parse(await command(['ls', '--json']));
  assert.equal(stopped.sandboxes.find((s: { name: string }) => s.name === name)?.status, 'stopped');
  report.afterRestart = await execute();
  report.result = 'awaiting-cleanup';
} catch (error) { report.result = 'fail'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  cleaning = true; checkpointCleanup(); console.log('Removing the test VM and its two registrations');
  const cleanup: object[] = []; report.cleanup = cleanup;
  if (creationAttempted) {
    try {
      await command(['rm', '--force', name], 30000);
      const listed = JSON.parse(await command(['ls', '--json']));
      assert.ok(!listed.sandboxes.some((s: { name: string }) => s.name === name)); cleanup.push({ sandbox: name, absent: true });
    } catch (error) { report.result = 'fail'; cleanup.push({ sandbox: name, error: String(error) }); process.exitCode = 1; }
  }
  for (const serverName of registrations) {
    try {
      await command(['mcp', 'rm', '--force', serverName]);
      const listed = (await command(['mcp', 'ls', '--quiet'])).split('\n');
      assert.ok(!listed.includes(serverName)); cleanup.push({ server: serverName, absent: true });
    } catch (error) { report.result = 'fail'; cleanup.push({ server: serverName, error: String(error) }); process.exitCode = 1; }
    checkpointCleanup();
  }
  rmSync(dir, { recursive: true, force: true });
  if (report.result === 'awaiting-cleanup' && !controller.signal.aborted) report.result = 'pass';
  else if (controller.signal.aborted) { report.result = 'fail'; report.error = 'Rehearsal cancelled'; process.exitCode = 1; }
  checkpointCleanup(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  console.log(JSON.stringify({ result: report.result, output, error: report.error }));
}
