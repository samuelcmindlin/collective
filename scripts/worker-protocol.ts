import assert from 'node:assert/strict';
import { z } from 'zod/v3';

export const PROBE_PREFIX = 'COLLECTIVE_WORKER_PROBE_V2 ';
export const observationNames = [
  'hostSentinelUnreadable', 'peerHostSentinelUnreadable', 'hostSentinelUnwritable',
  'rootCannotReadHostSentinel', 'symlinkDoesNotCrossVM', 'platformCheckoutAbsent',
  'hostHomeAbsent', 'hostDockerSocketAbsent', 'hostSshSocketAbsent', 'noSshAgentSocket',
  'sshSigningUnavailable', 'ownWorkspaceWritable', 'rootAvailableInsideVM',
  'noUnexpectedVirtioShares', 'proxyDenies:public-web', 'proxyDenies:provider',
  'proxyDenies:github', 'proxyDenies:host-service', 'directHttpExchangeDenied',
  'directTlsExchangeDenied', 'vmLoopbackDoesNotReachHost', 'claudeUnauthenticated',
  'detachedProcessStarted',
] as const;
const text = z.string().min(1).max(4000);
const heartbeat = z.string().regex(/^[1-9][0-9]{9,15}$/);
const commandResult = z.object({ code: z.number().int().nullable(), output: z.string().max(16000) }).strict();
const inspectSchema = z.object({
  marker: text, sessionMarker: text, boot: z.string().uuid(),
  heartbeatBefore: heartbeat, heartbeatAfter: heartbeat, dockerId: z.string().uuid(),
}).strict();
const setupSchema = z.object({
  observations: z.record(z.boolean()), networks: z.array(commandResult.extend({ name: text })).length(4),
  direct: text, directHttp: commandResult, directTls: commandResult,
  mounts: z.array(z.object({ path: text, type: text, options: text }).strict()).min(1).max(100),
  boot: z.string().uuid(), marker: text, sessionMarker: text, heartbeat,
  childPid: z.number().int().positive(),
  runtime: z.object({ node: text, kernel: text, cpus: z.number().int().positive(), memoryBytes: z.number().int().positive(),
    claude: text, docker: text, dockerId: z.string().uuid() }).strict(),
  integrations: z.object({ ghTokenVariablePresent: z.boolean(), mcpGatewayVariablePresent: z.boolean(),
    secretFileCount: z.number().int().nonnegative(), loggedIn: z.boolean() }).strict(),
}).strict();
export type SetupProbe = z.infer<typeof setupSchema>;
export type InspectProbe = z.infer<typeof inspectSchema>;

function payload(output: string): unknown {
  const lines = output.trim().split('\n').filter(Boolean);
  const records = lines.filter(line => line.startsWith(PROBE_PREFIX));
  assert.equal(records.length, 1, 'Expected exactly one framed probe result');
  assert.ok(lines.every(line => line.startsWith(PROBE_PREFIX) || /^Sandbox [a-z0-9-]+ started successfully$/.test(line)),
    'Unexpected output outside the probe record');
  return JSON.parse(records[0]!.slice(PROBE_PREFIX.length));
}
export function parseSetup(output: string): SetupProbe { return setupSchema.parse(payload(output)); }
export function parseInspect(output: string): InspectProbe { return inspectSchema.parse(payload(output)); }

/** The host requires a complete inventory; a missing or contradictory observation fails. */
export function verifySetup(probe: SetupProbe, marker: string) {
  assert.deepEqual(Object.keys(probe.observations).sort(), [...observationNames].sort(), 'Probe observation inventory changed');
  for (const name of observationNames) assert.equal(probe.observations[name], true, name);
  assert.equal(probe.marker, marker, 'Workspace marker must match this worker');
  assert.equal(probe.sessionMarker, marker, 'Session marker must match this worker');
  assert.equal(probe.runtime.cpus, 2, 'Guest CPU allocation changed');
  assert.ok(probe.runtime.memoryBytes >= 1_800_000_000 && probe.runtime.memoryBytes <= 2_147_483_648, 'Guest memory allocation changed');
  assert.equal(probe.integrations.loggedIn, false, 'Synthetic rehearsal must be unauthenticated');
  assert.deepEqual(probe.networks.map(n => n.name).sort(), ['public-web', 'provider', 'github', 'host-service'].sort());
  for (const result of probe.networks) {
    assert.equal(result.code, 0, 'Proxy denial must have an HTTP response'); assert.equal(result.output, '403');
  }
  // Command-not-found, timeout and certificate failures are not evidence of policy denial.
  assert.equal(probe.directHttp.code, 52, 'Expected direct HTTP connection to close without a response');
  assert.equal(probe.directTls.code, 35, 'Expected direct TLS handshake to be refused');
  assert.equal(probe.directHttp.output, '000'); assert.equal(probe.directTls.output, '000');
  for (const mount of probe.mounts.filter(m => m.type === 'virtiofs')) {
    assert.equal(mount.path, '/etc/resolv.conf'); assert.ok(mount.options.split(',').includes('ro'), 'DNS share must be read-only');
  }
}

export function verifyRestart(before: InspectProbe, after: InspectProbe) {
  assert.notEqual(before.heartbeatBefore, before.heartbeatAfter, 'Heartbeat must be advancing before stop');
  assert.equal(after.marker, before.marker, 'Workspace file must survive stop');
  assert.equal(after.sessionMarker, before.sessionMarker, 'Private session marker must survive stop');
  assert.notEqual(after.boot, before.boot, 'Restart must have a fresh kernel');
  assert.equal(after.dockerId, before.dockerId, 'Private engine identity must persist');
  assert.equal(after.heartbeatBefore, after.heartbeatAfter, 'Detached process must not resume');
  assert.ok(Number(after.heartbeatBefore) >= Number(before.heartbeatAfter), 'Heartbeat cannot disappear or move backward');
}

export function verifyDeniedPolicy(value: unknown) {
  // Shape is deliberately narrowed to the enforcement decision; CLI metadata can evolve.
  const decision = z.object({ allowed: z.literal(false) }).passthrough().parse(value);
  return decision;
}
