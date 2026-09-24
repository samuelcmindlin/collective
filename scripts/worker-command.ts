import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number | null; stdout: string; stderr: string;
  stopped?: 'timeout' | 'output-limit' | 'aborted' | 'spawn-error';
}

/** Bounds the local client. Its completion says nothing about VM cleanup. */
export async function runCommand(bin: string, args: string[], options: {
  input?: string; timeoutMs?: number; outputBytes?: number; signal?: AbortSignal;
} = {}): Promise<CommandResult> {
  if (options.signal?.aborted) return { code: null, stdout: '', stderr: '', stopped: 'aborted' };
  return new Promise(resolve => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, settled = false, stopped: CommandResult['stopped'];
    const limit = options.outputBytes ?? 128 * 1024;
    const killGroup = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const finish = (code: number | null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), stopped });
    };
    const stop = (reason: NonNullable<CommandResult['stopped']>) => {
      stopped ??= reason; killGroup(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); finish(null);
    };
    const abort = () => stop('aborted');
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? 15000);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]] as const) stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk.subarray(0, Math.max(0, limit - bytes))); bytes += chunk.length;
      if (bytes > limit) stop('output-limit');
    });
    child.stdin.on('error', () => {});
    child.once('error', () => stop('spawn-error'));
    child.once('exit', killGroup); child.once('close', finish);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort(); else child.stdin.end(options.input ?? '');
  });
}
