import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso, Store } from '../store.js';
import { environmentMcpLaunch, type McpLaunch } from '../mcp-launch.js';
import { WorkerRepository, type WorkerIntent } from './repository.js';

export interface WorkerBackend {
  preflight(intent: WorkerIntent, signal: AbortSignal): Promise<void>;
  provision(intent: WorkerIntent, launchFile: string, signal: AbortSignal): Promise<void>;
  /** Must independently verify absence of the VM, registration and host process. */
  remove(intent: WorkerIntent, launchFile: string): Promise<void>;
}

export class WorkerLifecycle {
  readonly repository: WorkerRepository;
  private initialized = false;
  private closing = false;
  private operations = new Map<string, { runId: string; controller: AbortController; done: Promise<unknown> }>();
  constructor(private store: Store, private dataDir: string, private backend: WorkerBackend,
    private revoke: (runId: string) => void) { this.repository = new WorkerRepository(store); }
  launchFile(intent: WorkerIntent) { return join(this.dataDir, 'control', 'workers', intent.id, 'launch.json'); }

  async reconcile(): Promise<void> {
    if (this.operations.size || this.initialized) throw new Error('Worker reconciliation is startup-only.');
    for (const intent of this.repository.pending()) await this.cleanup(intent.id).catch(() => {});
    this.initialized = true;
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    const operations = [...this.operations.values()];
    for (const operation of operations) operation.controller.abort();
    await Promise.allSettled(operations.map(operation => operation.done));
  }
  execute<T>(runId: string, image: string, launch: McpLaunch, signal: AbortSignal,
    work: (intent: WorkerIntent, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.initialized || this.closing) return Promise.reject(new Error('Sandbox lifecycle is not accepting work.'));
    if (signal.aborted) return Promise.reject(new Error('Sandbox episode cancelled before allocation.'));
    const blocked = this.repository.blockReason(new Set([...this.operations.values()].map(operation => operation.runId)));
    if (blocked) return Promise.reject(new Error(blocked));
    environmentMcpLaunch(launch.endpoint, launch.token);
    const intent = this.repository.reserve(runId, image);
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), this.store.settings().maxRunSeconds * 1000);
    const abort = () => this.revoke(runId);
    combined.addEventListener('abort', abort, { once: true });
    const done = this.run(intent, launch, combined, work, () => {
      clearTimeout(timer); controller.abort();
    }).finally(() => {
      clearTimeout(timer); combined.removeEventListener('abort', abort); this.operations.delete(intent.id);
    });
    this.operations.set(intent.id, { runId, controller, done });
    return done;
  }
  private async run<T>(intent: WorkerIntent, launch: McpLaunch, signal: AbortSignal,
    work: (intent: WorkerIntent, signal: AbortSignal) => Promise<T>, endEpisode: () => void): Promise<T> {
    let failure: unknown, failed = false, value: T | undefined;
    try {
      await this.backend.preflight(intent, signal);
      signal.throwIfAborted();
      const file = this.launchFile(intent);
      if (/[,\n\r]/.test(file)) throw new Error('Sandbox launch path cannot contain commas or newlines.');
      mkdirSync(join(this.dataDir, 'control', 'workers', intent.id), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(launch), { flag: 'wx', mode: 0o600 });
      this.repository.update(intent.id, { phase: 'provisioning', dispatched: true });
      await this.backend.provision(intent, file, signal);
      this.repository.update(intent.id, { provisioned: true });
      signal.throwIfAborted();
      intent = this.repository.update(intent.id, { phase: 'ready' });
      // A callback ignoring cancellation must not retain a VM indefinitely.
      value = await new Promise<T>((ok, reject) => {
        const abort = () => reject(new Error('Sandbox episode cancelled or deadline reached.'));
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => { signal.throwIfAborted(); return work(intent, signal); })
          .then(ok, reject).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
    } catch (error) { failed = true; failure = error; }
    finally { endEpisode(); }
    try { await this.cleanup(intent.id); }
    catch (error) { throw new AggregateError([failure, error].filter(Boolean), 'Sandbox cleanup is unresolved; replacement work is blocked.'); }
    if (failed) throw failure;
    return value as T;
  }
  private async cleanup(id: string): Promise<void> {
    let intent = this.repository.get(id)!;
    if (intent.phase === 'removed') return;
    // Revoke in memory even if persisting the transition fails.
    this.revoke(intent.runId);
    const errors: string[] = [];
    try { intent = this.repository.update(id, { phase: 'stopping', revokedAt: intent.revokedAt ?? nowIso() }); }
    catch { errors.push('The stopping transition could not be persisted.'); }
    if (intent.dispatched) {
      try { await this.backend.remove(intent, this.launchFile(intent)); }
      catch { errors.push('Sandbox VM, MCP registration or host process removal was not verified.'); }
    }
    // Private launch credentials are revoked regardless of external cleanup success.
    try { rmSync(join(this.dataDir, 'control', 'workers', intent.id), { recursive: true, force: true }); }
    catch { errors.push('Private launch-file cleanup failed.'); }
    if (intent.dispatched && !intent.provisioned) errors.push('Provisioning was not acknowledged; a delayed daemon operation may still create resources. Operator reconciliation required.');
    if (errors.length) {
      this.repository.update(id, { phase: 'unknown', revokedAt: intent.revokedAt ?? nowIso(), error: errors.join(' ') });
      throw new Error(errors.join(' '));
    }
    this.repository.update(id, { phase: 'removed', error: undefined });
  }
}
