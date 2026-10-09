import { randomUUID } from 'node:crypto';
import { z } from 'zod/v3';
import { Store, nowIso } from '../store.js';

export const pinnedImage = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:\-]+@sha256:[a-f0-9]{64}$/);
const intentSchema = z.object({
  id: z.string().uuid(), runId: z.string(), agentId: z.string(), jobId: z.string(),
  attempt: z.number().int().positive(), missionId: z.string(), missionRevision: z.number().int().positive(),
  image: pinnedImage, phase: z.enum(['planned', 'provisioning', 'ready', 'stopping', 'unknown', 'removed']),
  dispatched: z.boolean(), provisioned: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
  revokedAt: z.string().optional(), error: z.string().optional(),
}).strict();
export type WorkerIntent = z.infer<typeof intentSchema>;
export const workerName = (intent: WorkerIntent) => `collective-run-${intent.id}`;
export const registrationName = (intent: WorkerIntent) => `${workerName(intent)}-tools`;

/** Host-only lifecycle records; no domain/MCP tool can allocate or edit these. */
export class WorkerRepository {
  constructor(readonly store: Store) {}
  private parse(row: unknown): WorkerIntent | undefined {
    return row ? intentSchema.parse(JSON.parse((row as { data: string }).data)) : undefined;
  }
  get(id: string) { return this.parse(this.store.db.prepare('SELECT data FROM worker_intents WHERE id=?').get(id)); }
  forRun(runId: string) { return this.parse(this.store.db.prepare('SELECT data FROM worker_intents WHERE run_id=?').get(runId)); }
  pending(): WorkerIntent[] {
    return this.store.db.prepare("SELECT data FROM worker_intents WHERE phase!='removed' ORDER BY rowid").all().map(row => this.parse(row)!);
  }
  blockReason(activeRuns: ReadonlySet<string>): string | undefined {
    const unresolved = this.pending().find(intent => ['unknown', 'stopping'].includes(intent.phase)
      || intent.revokedAt || !activeRuns.has(intent.runId));
    return unresolved ? `Sandbox ${workerName(unresolved)} requires lifecycle reconciliation (${unresolved.phase}).` : undefined;
  }
  reserve(runId: string, image: string): WorkerIntent {
    return this.store.transaction(() => {
      const run = this.store.require('runs', runId), job = this.store.require('jobs', run.jobId);
      if (this.store.settings().paused || run.status !== 'running' || job.status !== 'running'
        || run.agentId !== job.agentId || run.attempt !== job.attempts || !this.store.isCurrentMission(job)
        || !job.missionId || !job.missionRevision) throw new Error('Sandbox allocation requires a current active run.');
      if (this.pending().some(i => ['unknown', 'stopping'].includes(i.phase) || i.revokedAt)) throw new Error('Sandbox reconciliation is required before allocation.');
      const at = nowIso();
      const intent = intentSchema.parse({ id: randomUUID(), runId, jobId: job.id, agentId: run.agentId,
        attempt: run.attempt, missionId: job.missionId, missionRevision: job.missionRevision, image,
        phase: 'planned', dispatched: false, provisioned: false, createdAt: at, updatedAt: at });
      this.store.db.prepare('INSERT INTO worker_intents VALUES(?,?,?,?,?)').run(intent.id, runId, run.agentId, intent.phase, JSON.stringify(intent));
      this.store.event('worker.planned', 'supervisor', intent.id, { runId, name: workerName(intent), image });
      return intent;
    });
  }
  update(id: string, patch: Partial<Pick<WorkerIntent, 'phase' | 'dispatched' | 'provisioned' | 'revokedAt' | 'error'>>): WorkerIntent {
    return this.store.transaction(() => {
      const current = this.get(id); if (!current) throw new Error('Unknown worker intent.');
      if (current.phase === 'removed') throw new Error('Removed worker intents cannot be reopened.');
      const transitions: Record<WorkerIntent['phase'], WorkerIntent['phase'][]> = {
        planned: ['provisioning', 'stopping', 'unknown'], provisioning: ['provisioning', 'ready', 'stopping', 'unknown'],
        ready: ['stopping', 'unknown'], stopping: ['stopping', 'removed', 'unknown'], unknown: ['stopping', 'unknown'], removed: [],
      };
      if (patch.phase && !transitions[current.phase].includes(patch.phase)) throw new Error('Invalid worker phase transition.');
      if ((current.dispatched && patch.dispatched === false) || (current.provisioned && patch.provisioned === false)
        || (current.revokedAt && Object.hasOwn(patch, 'revokedAt') && patch.revokedAt !== current.revokedAt)) throw new Error('Worker history cannot be reset.');
      const intent = intentSchema.parse({ ...current, ...patch, updatedAt: nowIso() });
      if (intent.provisioned && !intent.dispatched) throw new Error('Provision requires recorded dispatch.');
      if (intent.phase === 'ready' && (!intent.provisioned || intent.revokedAt)) throw new Error('Worker is not ready for authority.');
      if (intent.phase === 'removed' && (!intent.revokedAt || (intent.dispatched && !intent.provisioned))) throw new Error('Unacknowledged dispatch cannot be forgotten.');
      this.store.db.prepare('UPDATE worker_intents SET phase=?,data=? WHERE id=?').run(intent.phase, JSON.stringify(intent), id);
      this.store.event(`worker.${intent.phase}`, 'supervisor', id, { runId: intent.runId, error: intent.error });
      return intent;
    });
  }
}
