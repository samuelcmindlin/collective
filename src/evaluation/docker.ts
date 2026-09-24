import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hashRecord } from '../progress/checks.js';

export const CONTAINER_POLICY = Object.freeze({
  version: 'disposable-node.v1', sourceBytes: 64_000, inputBytes: 16_000,
  outputBytes: 64_000, timeoutMs: 5000, memoryBytes: 134_217_728,
  pids: 32, cpus: 0.5, scratchBytes: 16_777_216,
});
export interface CommandResult {
  code: number | null; stdout: string; stderr: string;
  stopped?: 'timeout' | 'output-limit' | 'aborted' | 'spawn-error';
}
export type Command = (args: string[], input: string, timeoutMs: number, signal?: AbortSignal) => Promise<CommandResult>;
export interface SandboxResult extends CommandResult {
  container: string; image: string; policyHash: string; cleanupVerified: boolean;
  state?: { exitCode: number; oomKilled: boolean }; error?: string;
}

/** Bounds apply to the Docker client too. Killing it alone does not stop a container. */
export function dockerCommand(socket: string, configDirectory: string): Command {
  if (!/^unix:\/\/\//.test(socket)) throw new Error('The rehearsal requires an explicitly selected local Unix Docker socket.');
  return (args, input, timeoutMs, signal) => new Promise(resolve => {
    const child = spawn('docker', ['--host', socket, '--config', configDirectory, ...args], {
      env: { PATH: process.env.PATH, LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), length = 0;
    let stopped: CommandResult['stopped'], settled = false;
    const killGroup = () => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
    };
    const stop = (reason: NonNullable<CommandResult['stopped']>) => {
      stopped ??= reason; killGroup();
      // Wrapper descendants must not keep the client promise open indefinitely.
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); finish(null);
    };
    const abort = () => stop('aborted');
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const kept = chunk.subarray(0, Math.max(0, CONTAINER_POLICY.outputBytes - length));
      if (stream === 'stdout') stdout = Buffer.concat([stdout, kept]); else stderr = Buffer.concat([stderr, kept]);
      length += chunk.length;
      if (length > CONTAINER_POLICY.outputBytes) stop('output-limit');
    };
    child.stdout.on('data', chunk => collect(chunk, 'stdout'));
    child.stderr.on('data', chunk => collect(chunk, 'stderr'));
    const finish = (code: number | null) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolve({ code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), stopped });
    };
    child.on('error', () => { stopped = 'spawn-error'; finish(null); });
    child.once('exit', killGroup);
    child.on('close', finish);
    child.stdin.on('error', () => {});
    if (signal?.aborted) abort(); else child.stdin.end(input);
  });
}

export function createArguments(image: string, name: string, source: string): string[] {
  return ['create', '--name', name, '--label', 'io.collective.rehearsal=disposable-node.v1',
    '--pull', 'never', '--interactive', '--init', '--restart', 'no', '--no-healthcheck',
    '--network', 'none', '--ipc', 'none', '--cgroupns', 'private', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534',
    '--pids-limit', String(CONTAINER_POLICY.pids), '--cpus', String(CONTAINER_POLICY.cpus),
    '--memory', String(CONTAINER_POLICY.memoryBytes), '--memory-swap', String(CONTAINER_POLICY.memoryBytes),
    '--ulimit', 'nofile=64:64', '--ulimit', 'core=0:0', '--log-driver', 'none',
    '--tmpfs', `/tmp:rw,nosuid,nodev,noexec,size=${CONTAINER_POLICY.scratchBytes},mode=1777`,
    '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--env', 'NODE_ENV=production', '--env', 'UV_THREADPOOL_SIZE=1',
    '--workdir', '/tmp', '--entrypoint', '/usr/local/bin/node', image, '--input-type=module', '--eval', source];
}

/** Maintainer rehearsal only. No default backend or native-code fallback. */
export class DockerSandbox {
  readonly policyHash = hashRecord({ limits: CONTAINER_POLICY, launch: createArguments('IMAGE', 'CONTAINER', 'SOURCE') });
  constructor(readonly image: string, private command: Command) {
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Use a resolved immutable local image ID.');
  }

  async run(bytes: Buffer, input: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SandboxResult> {
    if (bytes.length > CONTAINER_POLICY.sourceBytes || Buffer.byteLength(input) > CONTAINER_POLICY.inputBytes) throw new Error('Candidate or input exceeds the rehearsal bound.');
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (source.includes('\0')) throw new Error('Source contains NUL.');
    const timeoutMs = options.timeoutMs ?? CONTAINER_POLICY.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > CONTAINER_POLICY.timeoutMs) throw new Error('Invalid evaluator deadline.');
    const container = `collective-eval-${randomUUID()}`;
    const result: SandboxResult = { container, image: this.image, policyHash: this.policyHash,
      code: null, stdout: '', stderr: '', cleanupVerified: false };
    if (options.signal?.aborted) return { ...result, stopped: 'aborted', cleanupVerified: true };
    let created = false;
    try {
      const creation = await this.command(createArguments(this.image, container, source), '', 10_000, options.signal);
      if (creation.code !== 0 || creation.stopped || !/^[a-f0-9]{64}\s*$/.test(creation.stdout)) throw new Error('Container creation failed or is uncertain.');
      created = true;
      if (options.signal?.aborted) { result.stopped = 'aborted'; return result; }
      Object.assign(result, await this.command(['start', '--attach', '--interactive', container], input, timeoutMs, options.signal));
      const inspection = await this.command(['inspect', '--format', '{{json .State}}', container], '', 5000);
      if (inspection.code !== 0 || inspection.stopped) throw new Error('Container exit could not be verified.');
      const state = JSON.parse(inspection.stdout);
      if (!result.stopped && (state.Running !== false || !Number.isInteger(state.ExitCode))) throw new Error('Container has no verified terminal state.');
      result.state = { exitCode: state.ExitCode, oomKilled: state.OOMKilled === true };
      if (!result.stopped && (result.code !== state.ExitCode || state.OOMKilled)) result.error = 'Container failed or exhausted memory.';
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Container execution failed.';
    } finally {
      // Cleanup uses a name created here, never a PID or name supplied by candidate output.
      const removal = await this.command(['rm', '--force', container], '', 5000);
      const remaining = await this.command(['container', 'ls', '--all', '--quiet', '--filter', `name=^/${container}$`], '', 5000);
      result.cleanupVerified = created && removal.code === 0 && !removal.stopped &&
        remaining.code === 0 && !remaining.stopped && remaining.stdout.trim() === '';
      if (!result.cleanupVerified) result.error = 'Container cleanup is uncertain. Inspect the recorded container identity before retrying.';
    }
    return result;
  }
}
