// Synthetic VM probe only. Never reads host credentials or invokes inference.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const workspace = '/home/agent/workspace';
const marker = `${workspace}/collective-probe-marker`;
const sessionMarker = '/home/agent/.claude/projects/.collective-probe-session';
const heartbeat = `${workspace}/collective-probe-heartbeat`;
const emit = value => console.log('COLLECTIVE_WORKER_PROBE_V2 ' + JSON.stringify(value));
const read = path => { try { return fs.readFileSync(path, 'utf8'); } catch { return null; } };
const command = (file, args) => {
  try { return { code: 0, output: execFileSync(file, args, { timeout: 6000, maxBuffer: 16000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
  catch (error) { return { code: error.status ?? null, output: String(error.stdout ?? '').trim() }; }
};
const boot = () => read('/proc/sys/kernel/random/boot_id')?.trim();

if (request.mode === 'inspect') {
  const before = read(heartbeat);
  await new Promise(resolve => setTimeout(resolve, 350));
  emit({ marker: read(marker), sessionMarker: read(sessionMarker), boot: boot(), heartbeatBefore: before,
    heartbeatAfter: read(heartbeat), dockerId: command('docker', ['info', '--format', '{{.ID}}']).output });
} else {
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(marker, request.marker);
  fs.writeFileSync(sessionMarker, request.marker);
  const observations = {};
  observations.hostSentinelUnreadable = read(request.hostSentinel) === null;
  observations.peerHostSentinelUnreadable = read(request.peerHostSentinel) === null;
  observations.hostSentinelUnwritable = false;
  try { fs.writeFileSync(request.hostSentinel, 'escape'); } catch { observations.hostSentinelUnwritable = true; }
  observations.rootCannotReadHostSentinel = command('sudo', ['-n', 'cat', request.hostSentinel]).code !== 0;
  const link = `${workspace}/host-link`;
  fs.symlinkSync(request.hostSentinel, link);
  observations.symlinkDoesNotCrossVM = read(link) === null;
  fs.unlinkSync(link);
  observations.platformCheckoutAbsent = !fs.existsSync(request.platformRoot);
  observations.hostHomeAbsent = !fs.existsSync(request.hostHome);
  observations.hostDockerSocketAbsent = !fs.existsSync(request.hostDockerSocket);
  observations.hostSshSocketAbsent = !fs.existsSync(request.hostSshSocket);
  observations.noSshAgentSocket = !process.env.SSH_AUTH_SOCK || !fs.existsSync(process.env.SSH_AUTH_SOCK);
  observations.sshSigningUnavailable = command('ssh-add', ['-l']).code === 2;
  observations.ownWorkspaceWritable = read(marker) === request.marker;
  observations.rootAvailableInsideVM = command('sudo', ['-n', 'id', '-u']).output === '0';
  const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').map(line => {
    const [left, right] = line.split(' - ');
    return { path: left.split(' ')[4], type: right.split(' ')[0], options: left.split(' ')[5] };
  });
  // /etc/resolv.conf is a deliberate runtime-owned read-only DNS configuration share.
  observations.noUnexpectedVirtioShares = mounts.filter(m => m.type === 'virtiofs').every(m => m.path === '/etc/resolv.conf' && m.options.split(',').includes('ro'));
  const networks = [];
  for (const [name, url] of [
    ['public-web', 'https://example.com'], ['provider', 'https://api.anthropic.com'],
    ['github', 'https://api.github.com'], ['host-service', `http://host.docker.internal:${request.operatorPort}`],
  ]) {
    const result = command('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--connect-timeout', '2', '--max-time', '4', url]);
    networks.push({ name, ...result });
    observations[`proxyDenies:${name}`] = result.code === 0 && result.output === '403';
  }
  const direct = await new Promise(resolve => {
    const socket = net.connect({ host: '1.1.1.1', port: 443 });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1500, () => finish('timeout'));
    socket.once('error', error => finish(error.code)); socket.once('connect', () => finish('connected'));
  });
  // The VM network front end can accept TCP before it checks forwarded traffic.
  // Test application exchange too; a connect event alone is not proof of egress.
  const directHttp = command('curl', ['--noproxy', '*', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--connect-timeout', '2', '--max-time', '4', 'http://1.1.1.1']);
  const directTls = command('curl', ['--noproxy', '*', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--connect-timeout', '2', '--max-time', '4', 'https://1.1.1.1']);
  observations.directHttpExchangeDenied = directHttp.code !== 0 && directHttp.output === '000';
  observations.directTlsExchangeDenied = directTls.code !== 0 && directTls.output === '000';
  const loopback = command('curl', ['--noproxy', '*', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '2', `http://127.0.0.1:${request.operatorPort}`]);
  observations.vmLoopbackDoesNotReachHost = loopback.code !== 0;
  const auth = command('claude', ['auth', 'status']);
  let loggedIn = null; try { loggedIn = JSON.parse(auth.output).loggedIn; } catch {}
  observations.claudeUnauthenticated = loggedIn === false;
  const child = spawn(process.execPath, ['-e', `const fs=require('node:fs'); const target=${JSON.stringify(heartbeat)}; setInterval(()=>{fs.writeFileSync(target+'.next',String(Date.now()));fs.renameSync(target+'.next',target);},100);`], { detached: true, stdio: 'ignore' });
  child.unref();
  await new Promise(resolve => setTimeout(resolve, 350));
  observations.detachedProcessStarted = read(heartbeat) !== null;
  emit({ observations, networks, direct, directHttp, directTls, mounts, boot: boot(),
    marker: read(marker), sessionMarker: read(sessionMarker), heartbeat: read(heartbeat), childPid: child.pid,
    runtime: { node: process.version, kernel: os.release(), cpus: os.cpus().length, memoryBytes: os.totalmem(),
      claude: command('claude', ['--version']).output, docker: command('docker', ['version', '--format', '{{.Server.Version}}']).output,
      dockerId: command('docker', ['info', '--format', '{{.ID}}']).output },
    integrations: { ghTokenVariablePresent: Boolean(process.env.GH_TOKEN), mcpGatewayVariablePresent: Boolean(process.env.MCP_GATEWAY_URL),
      secretFileCount: fs.readdirSync('/run/secrets').length, loggedIn } });
}
