import { join } from 'node:path';
import { z } from 'zod/v3';
import { runCommand } from './command.js';
import type { WorkerBackend } from './lifecycle.js';
import { workerName, registrationName, type WorkerIntent } from './repository.js';

export type CommandRunner = typeof runCommand;
const inventory = z.object({ sandboxes: z.array(z.object({ name: z.string().min(1), status: z.string().min(1) }).passthrough()) }).passthrough();

/** Fixed host commands. Callers cannot supply mounts, MCP membership or argv. */
export class SandboxBackend implements WorkerBackend {
  constructor(private root: string, private command: CommandRunner = runCommand) {}
  private async sbx(args: string[], signal?: AbortSignal, timeoutMs = 15000): Promise<string> {
    const result = await this.command('sbx', args, { timeoutMs, signal });
    if (result.code !== 0 || result.stopped) throw new Error(`Sandbox ${args[0]} failed (${result.stopped ?? result.code}).`);
    return result.stdout.trim();
  }
  private async vms(signal?: AbortSignal) {
    const result = inventory.parse(JSON.parse(await this.sbx(['ls', '--json'], signal))).sandboxes;
    if (new Set(result.map(vm => vm.name)).size !== result.length) throw new Error('Ambiguous sandbox inventory.');
    return result;
  }
  private async registrations(signal?: AbortSignal) {
    const text = await this.sbx(['mcp', 'ls', '--quiet'], signal);
    const names = text ? text.split('\n') : [];
    if (names.some(name => !/^[A-Za-z0-9_.-]+$/.test(name)) || new Set(names).size !== names.length) throw new Error('Malformed MCP registry inventory.');
    return names;
  }
  async preflight(intent: WorkerIntent, signal: AbortSignal): Promise<void> {
    const version = await this.sbx(['version'], signal);
    if (!/^sbx version: v0\.45\.1\b/.test(version)) throw new Error('Sandbox runtime version needs compatibility verification.');
    for (const [key, value] of [['mcp.forceLocalGateway', 'true'], ['ssh.agentForwardingEnabled', 'false'], ['skills.defaultMode', 'off'], ['clipboard.imagePaste', 'false']]) {
      if (await this.sbx(['settings', 'get', key!], signal) !== value) throw new Error(`Sandbox setting ${key} does not satisfy admission.`);
    }
    if (/[,\n\r]/.test(this.root)) throw new Error('Sandbox MCP host paths cannot contain commas or newlines.');
    if ((await this.vms(signal)).some(vm => vm.name === workerName(intent)) || (await this.registrations(signal)).includes(registrationName(intent))) throw new Error('Sandbox resource identity is already in use.');
  }
  async provision(intent: WorkerIntent, launchFile: string, signal: AbortSignal): Promise<void> {
    const name = workerName(intent), registration = registrationName(intent);
    signal.throwIfAborted();
    // sbx parses --args as a comma-separated list. Reject ambiguous host paths.
    const args = ['--import', join(this.root, 'node_modules/tsx/dist/loader.mjs'), join(this.root, 'src/mcp-worker.ts'), '--launch-file', launchFile];
    if (args.some(arg => /[,\n\r]/.test(arg))) throw new Error('Sandbox MCP host paths cannot contain commas or newlines.');
    await this.sbx(['mcp', 'add', registration, '--command', process.execPath, '--args', args.join(','), '--dir', this.root], signal);
    await this.sbx(['create', '--name', name, '--cpus', '2', '--memory', '2g', '--skills', 'off', '--deny-network', '**', '--pull', 'never', '--template', intent.image, '--static-mcp', registration, 'claude'], signal, 120000);
    const metadata = z.object({ image_digest: z.string(), runtime_mounts: z.array(z.unknown()) }).passthrough()
      .parse(JSON.parse(await this.sbx(['inspect', name, '--json'], signal)));
    if (metadata.image_digest !== intent.image.split('@')[1] || metadata.runtime_mounts.length) throw new Error('Sandbox runtime differs from the pinned mountless configuration.');
  }
  async remove(intent: WorkerIntent, launchFile: string): Promise<void> {
    const name = workerName(intent), registration = registrationName(intent), failures: unknown[] = [];
    const attempt = async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { failures.push(error); } };
    await attempt(async () => {
      const vm = (await this.vms()).find(vm => vm.name === name);
      if (vm) {
        if (vm.status !== 'stopped') await attempt(() => this.sbx(['stop', name], undefined, 30000));
        await this.sbx(['rm', '--force', name], undefined, 30000);
      }
      if ((await this.vms()).some(vm => vm.name === name)) throw new Error('Sandbox remains in inventory after removal.');
    });
    await attempt(async () => {
      if ((await this.registrations()).includes(registration)) await this.sbx(['mcp', 'rm', '--force', registration]);
      if ((await this.registrations()).includes(registration)) throw new Error('MCP registration remains after removal.');
    });
    await attempt(async () => {
      const result = await this.command('pgrep', ['-f', launchFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], { timeoutMs: 5000 });
      if (result.stopped || result.code !== 1) throw new Error('Host MCP subprocess exit could not be verified.');
    });
    if (failures.length) throw new AggregateError(failures, 'Sandbox cleanup could not be verified.');
  }
}
