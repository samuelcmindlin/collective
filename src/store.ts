import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Collection, Collections, Event, Job, MissionScope, Settings } from './types.js';
import { migrate, schemaVersion } from './storage/migrations.js';

export const nowIso = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;

export class Store {
  readonly db: DatabaseSync;
  readonly changes = new EventEmitter();
  private eventFrames: Event[][] = [];
  private savepointSequence = 0;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (version > schemaVersion) throw new Error(`Database schema ${version} is newer than supported schema ${schemaVersion}.`);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
      migrate(this.db);
    } catch (error) { this.db.close(); throw error; }
  }
  all<K extends Collection>(collection: K): Collections[K][] {
    return (this.db.prepare('SELECT data FROM entities WHERE collection=? ORDER BY rowid').all(collection) as { data: string }[]).map(r => JSON.parse(r.data) as Collections[K]);
  }
  get<K extends Collection>(collection: K, entityId: string): Collections[K] | undefined {
    const row = this.db.prepare('SELECT data FROM entities WHERE collection=? AND id=?').get(collection, entityId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as Collections[K] : undefined;
  }
  require<K extends Collection>(collection: K, entityId: string): Collections[K] {
    const value = this.get(collection, entityId); if (!value) throw new Error(`${collection}: ${entityId} not found`); return value;
  }
  put<K extends Collection>(collection: K, value: Collections[K]): Collections[K] {
    this.db.prepare('INSERT INTO entities(collection,id,data) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data').run(collection, value.id, JSON.stringify(value));
    return value;
  }
  patch<K extends Collection>(collection: K, entityId: string, patch: Partial<Collections[K]>): Collections[K] {
    return this.put(collection, { ...this.require(collection, entityId), ...patch, id: entityId } as Collections[K]);
  }
  event(type: string, actorId: string, entityId: string | undefined, data: unknown = {}) {
    const createdAt = nowIso();
    const row = this.db.prepare('INSERT INTO events(type,actor_id,entity_id,data,created_at) VALUES(?,?,?,?,?) RETURNING id').get(type, actorId, entityId ?? null, JSON.stringify(data), createdAt) as { id: number };
    const event: Event = { id: row.id, type, actorId, entityId, data, createdAt };
    const frame = this.eventFrames.at(-1);
    if (frame) frame.push(event);
    else queueMicrotask(() => this.changes.emit('event', event));
    return event;
  }
  events(after = 0, limit = 100): Event[] {
    return (this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id DESC LIMIT ?').all(after, limit) as Record<string, unknown>[]).map(r => ({ id: Number(r.id), type: String(r.type), actorId: String(r.actor_id), entityId: r.entity_id ? String(r.entity_id) : undefined, data: JSON.parse(String(r.data)), createdAt: String(r.created_at) }));
  }
  get inTransaction() { return this.eventFrames.length > 0; }
  transaction<T>(fn: () => T extends PromiseLike<unknown> ? never : T): T {
    // Transactions must be synchronous: no network/await may keep one open.
    if (fn.constructor.name === 'AsyncFunction') throw new Error('Transactions must be synchronous.');
    const savepoint = this.inTransaction ? `nested_${++this.savepointSequence}` : undefined;
    this.db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    const events: Event[] = [];
    this.eventFrames.push(events);
    let value: T;
    try {
      value = fn();
      if (value && typeof (value as { then?: unknown }).then === 'function') throw new Error('Transactions must be synchronous.');
      this.db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
    } catch (error) {
      try { this.db.exec(savepoint ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK'); }
      finally { this.eventFrames.pop(); }
      throw error;
    }
    this.eventFrames.pop();
    const parent = this.eventFrames.at(-1);
    if (parent) parent.push(...events);
    else if (events.length) queueMicrotask(() => { for (const event of events) this.changes.emit('event', event); });
    return value;
  }
  settings(): Settings { return this.require('settings', 'settings'); }
  missionScope(): MissionScope {
    const mission = this.all('missions').find(m => m.status === 'active');
    return mission ? { missionId: mission.id, missionRevision: mission.revision } : {};
  }
  isCurrentMission(scope: MissionScope): boolean {
    const current = this.missionScope();
    return scope.missionId === current.missionId && scope.missionRevision === current.missionRevision;
  }
  enqueue(agentId: string, kind: Job['kind'], payload: Job['payload'], dedupeKey: string, availableAt = nowIso(), scope = this.missionScope()): Job {
    const row = this.db.prepare("SELECT data FROM entities WHERE collection='jobs' AND json_extract(data,'$.dedupeKey')=?").get(dedupeKey) as { data: string } | undefined;
    const existing = row ? JSON.parse(row.data) as Job : undefined;
    if (existing) return existing;
    return this.put('jobs', { id: id('job'), agentId, kind, payload, dedupeKey, missionId: scope.missionId, missionRevision: scope.missionRevision, status: 'pending', attempts: 0, availableAt, createdAt: nowIso() });
  }
  claimJob(at = new Date()): Job | undefined {
    return this.transaction(() => {
      const busy = new Set(this.all('jobs').filter(j => j.status === 'running').map(j => j.agentId));
      for (const stale of this.all('jobs').filter(j => ['pending', 'failed'].includes(j.status) && !this.isCurrentMission(j))) {
        this.patch('jobs', stale.id, { status: 'cancelled', error: 'Work belongs to an inactive or unknown mission.' });
      }
      const job = this.all('jobs').find(j => j.status === 'pending' && j.availableAt <= at.toISOString() && !busy.has(j.agentId) && this.get('agents', j.agentId)?.status !== 'paused');
      return job ? this.patch('jobs', job.id, { status: 'running', attempts: job.attempts + 1, claimedAt: at.toISOString() }) : undefined;
    });
  }
  recover() {
    this.transaction(() => {
      for (const run of this.all('runs').filter(r => r.status === 'running')) this.patch('runs', run.id, { status: 'interrupted', endedAt: nowIso(), error: 'Supervisor restarted; resumable session preserved.' });
      for (const job of this.all('jobs').filter(j => ['running', 'pending', 'failed'].includes(j.status))) {
        if (!this.isCurrentMission(job)) this.patch('jobs', job.id, { status: 'cancelled', error: 'Work belongs to an inactive or unknown mission.' });
        else if (job.status === 'running') this.patch('jobs', job.id, { status: 'pending', availableAt: nowIso() });
      }
      for (const agent of this.all('agents').filter(a => a.status === 'working')) this.patch('agents', agent.id, { status: 'idle' });
      for (const item of this.all('outbox').filter(o => o.status === 'sending')) this.patch('outbox', item.id, { status: 'pending' });
    });
  }
  close() { this.db.close(); }
}
