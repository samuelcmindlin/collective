// Synthetic sentinels only. This fixture never receives real host credentials.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const denied = fn => { try { fn(); return false; } catch { return true; } };
const connectDenied = options => new Promise(resolve => {
  const socket = net.connect(options);
  const done = result => { socket.destroy(); resolve(result); };
  socket.setTimeout(500, () => done(true));
  socket.on('connect', () => done(false)); socket.on('error', () => done(true));
});
const result = {};
result.scratchWorks = !denied(() => { fs.writeFileSync('/tmp/probe', 'allowed'); if (fs.readFileSync('/tmp/probe', 'utf8') !== 'allowed') throw Error(); });
result.rootWriteDenied = denied(() => fs.writeFileSync('/etc/collective-probe', 'denied'));
result.hostReadDenied = denied(() => fs.readFileSync(input.hostSentinel));
result.hostWriteDenied = denied(() => fs.writeFileSync(input.hostSentinel, 'tampered'));
result.otherWorkerDenied = denied(() => fs.readFileSync(input.otherWorker));
fs.symlinkSync(input.hostSentinel, '/tmp/escape');
result.symlinkReadDenied = denied(() => fs.readFileSync('/tmp/escape'));
result.symlinkWriteDenied = denied(() => fs.writeFileSync('/tmp/escape', 'tampered'));
result.hostOperatorDenied = await connectDenied({ host: '127.0.0.1', port: input.operatorPort });
result.publicNetworkDenied = await connectDenied({ host: '1.1.1.1', port: 443 });
result.dnsDenied = await connectDenied({ host: 'example.com', port: 443 });
// Linux can expose inactive tunl0/ip6tnl0 devices even with Docker network=none.
// Check addresses, interface UP flags and routes, not the number of sysfs names.
const interfaces = fs.readdirSync('/sys/class/net');
const addresses = Object.keys(os.networkInterfaces());
const interfaceFlags = Object.fromEntries(interfaces.map(name => [name, Number(fs.readFileSync(`/sys/class/net/${name}/flags`, 'utf8').trim())]));
result.noRoutableInterface = addresses.every(name => name === 'lo') &&
  interfaces.every(name => name === 'lo' || !(interfaceFlags[name] & 1)) && fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').length === 1;
console.error(JSON.stringify({ interfaceFlags, addressedInterfaces: addresses }));
result.hostGatewayDenied = await connectDenied({ host: 'host.docker.internal', port: input.operatorPort });
result.sshSocketDenied = await connectDenied({ path: input.socket });
result.dockerSocketAbsent = !fs.existsSync('/var/run/docker.sock') && !fs.existsSync('/run/docker.sock');
result.credentialsAbsent = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'DISCORD_BOT_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'COLLECTIVE_RUN_TOKEN'].every(key => !process.env[key]);
result.nonRoot = process.getuid() === 65534;
const status = fs.readFileSync('/proc/self/status', 'utf8');
result.noCapabilities = /^CapEff:\s+0+$/m.test(status);
result.noNewPrivileges = /^NoNewPrivs:\s+1$/m.test(status);
result.seccompActive = /^Seccomp:\s+2$/m.test(status);
result.memoryLimit = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim() === '134217728';
result.pidsLimit = fs.readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim() === '32';
result.cpuLimit = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim() === '50000 100000';
result.cgroupWriteDenied = denied(() => fs.writeFileSync('/sys/fs/cgroup/pids.max', 'max'));
// Bounded exhaustion verifies enforcement without an unbounded fork bomb.
const children = [];
let forkDenied = false;
for (let i = 0; i < 36; i++) {
  const child = spawn('/bin/sleep', ['10'], { stdio: 'ignore' });
  const started = await new Promise(resolve => { child.once('spawn', () => resolve(true)); child.once('error', () => resolve(false)); });
  if (!started) { forkDenied = true; break; }
  children.push(child);
}
result.processLimitEnforced = forkDenied;
for (const child of children) child.kill('SIGKILL');
console.log(JSON.stringify(result));
