import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, nowIso } from '../src/store.js';
import { seed } from '../src/seed.js';
import { CollectiveService } from '../src/service.js';
import { Scheduler } from '../src/scheduler.js';
import { DiscordBridge } from '../src/discord.js';
import { createHttpServer } from '../src/http.js';
import { callAgentTool } from '../src/agent-client.js';
import type { Config } from '../src/config.js';
import type { Harness, RunResult } from '../src/claude.js';
import type { Task, Job, Run } from '../src/types.js';
import { migrate } from '../src/storage/migrations.js';
import { backupBeforeMigration } from '../src/storage/backup.js';

const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));
const result: RunResult = { summary: 'Fixture completed', inputTokens: 1, outputTokens: 1, estimatedCost: 0, turns: 1 };
const taskInput = { title: 'Specify rules', description: 'Define game behavior', ownerId: 'atlas', acceptance: 'Rules are explicit' };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'collective-foundation-'));
  const config: Config = { root: process.cwd(), dataDir: dir, port: 0, mode: 'simulation', claudeBin: 'unused', operatorIds: [] };
  const store = new Store(join(dir, 'db.sqlite'));
  seed(store);
  const service = new CollectiveService(store, config);
  service.setMission('Game', 'Build a game', [], 'operator');
  store.patch('settings', 'settings', { paused: false, maxConcurrent: 1 });
  return { dir, config, store, service, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function snapshot(store: Store) {
  return {
    entities: store.db.prepare('SELECT * FROM entities ORDER BY collection,id').all(),
    events: store.db.prepare('SELECT * FROM events ORDER BY id').all(),
    receipts: store.db.prepare('SELECT * FROM command_receipts ORDER BY principal_id,command_id').all(),
  };
}

function failWrite(store: Store, table: 'entities' | 'events' | 'command_receipts', condition = '1') {
  store.db.exec(`CREATE TEMP TRIGGER injected_failure BEFORE INSERT ON ${table}
    WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;`);
}

async function reviewedFixture() {
  const s = fixture();
  const task = await s.service.tool('nova', 'task_create', taskInput) as Task;
  const dependent = await s.service.tool('nova', 'task_create', { ...taskInput, ownerId: 'ember', dependencies: [task.id] }) as Task;
  const evidence = await s.service.tool('atlas', 'knowledge_write', { title: 'Rules', content: 'Match pairs', kind: 'decision' }) as { id: string };
  await s.service.tool('atlas', 'task_submit', { taskId: task.id, evidenceIds: [evidence.id], note: 'Ready' });
  return { ...s, task: s.store.require('tasks', task.id), dependent, evidence };
}

test('rollback discards nested notifications and committed notifications preserve order', async () => {
  const store = new Store(':memory:');
  const observed: string[] = [];
  store.changes.on('event', event => observed.push(event.type));
  try {
    assert.throws(() => store.transaction(() => {
      store.event('outer-aborted', 'test', undefined);
      store.transaction(() => store.event('inner-aborted', 'test', undefined));
      throw new Error('rollback');
    }), /rollback/);
    await flush();
    assert.deepEqual(observed, []);
    assert.equal(store.events().length, 0);
    store.transaction(() => {
      store.event('first', 'test', undefined);
      assert.throws(() => store.transaction(() => {
        store.event('discarded-savepoint', 'test', undefined);
        throw new Error('inner failure');
      }), /inner failure/);
      store.transaction(() => store.event('second', 'test', undefined));
      assert.deepEqual(observed, [], 'nothing is delivered inside the transaction');
    });
    await flush();
    assert.deepEqual(observed, ['first', 'second']);
    assert.deepEqual(store.events().map(e => e.type).reverse(), observed);
  } finally { store.close(); }
});

test('async transaction callbacks are rejected before their body executes', () => {
  const store = new Store(':memory:');
  let ran = false;
  try {
    // Exercise the runtime boundary as an untyped consumer could.
    assert.throws(() => store.transaction((async () => { ran = true; }) as never), /synchronous/);
    assert.equal(ran, false);
    assert.equal(store.inTransaction, false);
  } finally { store.close(); }
});

test('task creation is atomic across task, job, event and command receipt writes', async t => {
  for (const [table, condition] of [
    ['entities', "NEW.collection='jobs'"],
    ['events', "NEW.type='task.created'"],
    ['command_receipts', '1'],
  ] as const) await t.test(`failure in ${table}`, async () => {
    const s = fixture();
    try {
      await flush();
      const before = snapshot(s.store);
      const observed: unknown[] = [];
      s.store.changes.on('event', event => observed.push(event));
      failWrite(s.store, table, condition);
      await assert.rejects(s.service.tool('nova', 'task_create', { ...taskInput, commandId: 'create-1' }), /injected/);
      await flush();
      assert.deepEqual(snapshot(s.store), before);
      assert.deepEqual(observed, []);
      s.store.db.exec('DROP TRIGGER injected_failure');
      const created = await s.service.tool('nova', 'task_create', { ...taskInput, commandId: 'create-1' }) as Task;
      assert.ok(s.store.all('jobs').some(j => j.payload.taskId === created.id));
    } finally { s.close(); }
  });
});

test('submission failure leaves the task editable and creates no review job', async () => {
  const s = fixture();
  try {
    const task = await s.service.tool('nova', 'task_create', taskInput) as Task;
    const evidence = await s.service.tool('atlas', 'knowledge_write', { title: 'Rules', content: 'Match pairs', kind: 'decision' }) as { id: string };
    const before = snapshot(s.store);
    failWrite(s.store, 'entities', "NEW.collection='jobs' AND json_extract(NEW.data,'$.payload.review')=1");
    await assert.rejects(s.service.tool('atlas', 'task_submit', { taskId: task.id, evidenceIds: [evidence.id], note: 'Ready', commandId: 'submit-1' }), /injected/);
    assert.deepEqual(snapshot(s.store), before);
  } finally { s.close(); }
});

test('task status and knowledge writes roll back when their audit write fails', async t => {
  for (const kind of ['task', 'knowledge'] as const) await t.test(kind, async () => {
    const s = fixture();
    try {
      const task = await s.service.tool('nova', 'task_create', taskInput) as Task;
      const before = snapshot(s.store);
      failWrite(s.store, 'events', kind === 'task' ? "NEW.type='task.updated'" : "NEW.type='knowledge.published'");
      const operation = kind === 'task'
        ? s.service.tool('atlas', 'task_update', { taskId: task.id, status: 'doing', commandId: 'update-failure' })
        : s.service.tool('atlas', 'knowledge_write', { title: 'Rules', content: 'Match pairs', kind: 'decision' });
      await assert.rejects(operation, /injected/);
      assert.deepEqual(snapshot(s.store), before);
    } finally { s.close(); }
  });
});

test('review failure rolls back acceptance, completion counters and all dependent wakeups', async t => {
  for (const [table, condition] of [
    ['entities', "NEW.collection='agents' AND json_extract(NEW.data,'$.completed')=1"],
    ['entities', "NEW.collection='jobs' AND json_extract(NEW.data,'$.agentId')='ember'"],
    ['entities', "NEW.collection='jobs' AND json_extract(NEW.data,'$.kind')='feedback'"],
    ['events', "NEW.type='task.accepted'"],
    ['command_receipts', '1'],
  ] as const) await t.test(`${table}: ${condition}`, async () => {
    const s = await reviewedFixture();
    try {
      await flush();
      const before = snapshot(s.store);
      const observed: unknown[] = [];
      s.store.changes.on('event', event => observed.push(event));
      failWrite(s.store, table, condition);
      await assert.rejects(s.service.tool('iris', 'task_review', { taskId: s.task.id, accepted: true, note: 'Checked', commandId: 'review-1' }), /injected/);
      await flush();
      assert.deepEqual(snapshot(s.store), before);
      assert.deepEqual(observed, []);
    } finally { s.close(); }
  });
});

test('command results survive reopening the database and reject identity reuse with another payload', async () => {
  const s = fixture();
  const input = { ...taskInput, commandId: 'durable-create' };
  const first = await s.service.tool('nova', 'task_create', input) as Task;
  const before = snapshot(s.store);
  s.store.close();
  const reopened = new Store(join(s.dir, 'db.sqlite'));
  const service = new CollectiveService(reopened, s.config);
  try {
    assert.deepEqual(await service.tool('nova', 'task_create', input), first);
    assert.deepEqual(snapshot(reopened), before);
    await assert.rejects(service.tool('nova', 'task_create', { ...input, title: 'Changed intent' }), /Command ID conflict/);
    await assert.rejects(service.tool('nova', 'task_update', { commandId: input.commandId, taskId: first.id, status: 'doing' }), /Command ID conflict/);
    assert.deepEqual(snapshot(reopened), before);
  } finally { reopened.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test('identical concurrent reviews count completion once and stale task versions reject changes', async () => {
  const s = await reviewedFixture();
  try {
    const input = { commandId: 'accept-1', taskId: s.task.id, expectedVersion: s.task.version, accepted: true, note: 'Checked' };
    const [a, b] = await Promise.all([s.service.tool('iris', 'task_review', input), s.service.tool('iris', 'task_review', input)]);
    assert.deepEqual(a, b);
    assert.equal(s.store.require('agents', 'atlas').completed, 1);
    assert.equal(s.store.events(0, 1000).filter(e => e.type === 'task.accepted').length, 1);
    assert.equal(s.store.all('jobs').filter(j => j.payload.taskId === s.dependent.id).length, 1);
    const task = await s.service.tool('nova', 'task_create', { ...taskInput, commandId: 'versioned-create' }) as Task;
    await s.service.tool('atlas', 'task_update', { taskId: task.id, commandId: 'versioned-update', expectedVersion: task.version, status: 'doing' });
    await assert.rejects(s.service.tool('atlas', 'task_update', { taskId: task.id, commandId: 'stale-update', expectedVersion: task.version, status: 'blocked' }), /version conflict/);
    assert.equal(s.store.require('tasks', task.id).status, 'doing');
  } finally { s.close(); }
});

test('mission replacement rejects old task mutations and task-linked outputs without hiding history', async () => {
  const s = await reviewedFixture();
  try {
    const priorJob = s.store.claimJob()!;
    const oldTask = s.task;
    s.store.patch('jobs', priorJob.id, { status: 'failed' });
    s.service.setMission('New direction', 'Research something else', [], 'operator');
    await assert.rejects(s.service.tool('atlas', 'task_update', { taskId: oldTask.id, status: 'doing' }), /inactive mission/);
    await assert.rejects(s.service.tool('atlas', 'task_submit', { taskId: oldTask.id, evidenceIds: [s.evidence.id], note: 'Ready' }), /inactive mission/);
    await assert.rejects(s.service.tool('iris', 'task_review', { taskId: oldTask.id, accepted: true, note: 'Checked' }), /inactive mission/);
    await assert.rejects(s.service.tool('nova', 'task_create', taskInput, priorJob), /Job is inactive/);
    await assert.rejects(s.service.tool('nova', 'profile_update', { bio: 'Late old job' }, priorJob), /Job is inactive/);
    assert.equal(s.store.require('tasks', oldTask.id).status, 'review');
    assert.deepEqual(s.service.context('atlas').tasks, []);
    writeFileSync(join(s.service.workspace('atlas'), 'old.md'), 'Old task output');
    await assert.rejects(s.service.tool('atlas', 'artifact_publish', { title: 'Old', description: 'Old output', taskId: oldTask.id, path: 'old.md' }), /inactive mission/);
    assert.equal(s.store.all('artifacts').length, 0);
  } finally { s.close(); }
});

test('old delivery, meetings and permission decisions cannot awaken a new mission', async () => {
  const s = fixture();
  try {
    const message = s.service.say('nova', 'Old work', ['atlas']);
    const request = s.service.createRequest('nova', { title: 'Room', reason: 'Old mission', capability: 'environment.add_room', scope: { name: 'Annex', purpose: 'Breakout' }, alternatives: 'Commons', estimatedCost: 0 });
    const other = s.service.createRequest('nova', { title: 'Another room', reason: 'Old mission', capability: 'environment.add_room', scope: { name: 'Annex two', purpose: 'Breakout' }, alternatives: 'Commons', estimatedCost: 0 });
    s.service.decideRequest(other.id, 'approved', 'Scoped to this mission', 'operator');
    await s.service.tool('nova', 'meeting_schedule', { title: 'Old meeting', agenda: 'Discuss', expectedOutcome: 'Decision', roomId: 'lab', participants: ['nova', 'atlas'], startsAt: new Date(Date.now() + 60000).toISOString(), durationMinutes: 5 });
    s.service.setMission('New', 'New work', [], 'operator');
    const jobsBefore = s.store.all('jobs').length;
    s.service.deliverMessage(message.id, 'late-discord-id');
    assert.equal(s.store.require('messages', message.id).delivery, 'delivered');
    assert.equal(s.store.all('jobs').length, jobsBefore);
    assert.equal(s.store.all('meetings')[0]!.status, 'complete');
    assert.throws(() => s.service.decideRequest(request.id, 'approved', '', 'operator'), /inactive or unknown mission/);
    s.service.decideRequest(request.id, 'denied', 'Old direction', 'operator');
    assert.equal(s.store.all('jobs').length, jobsBefore);
    await assert.rejects(s.service.executeCapability('nova', other.id), /inactive or unknown mission/);
    assert.equal(s.store.all('rooms').length, 5);
    const current = s.service.createRequest('nova', { title: 'Room', reason: 'New mission', capability: 'environment.add_room', scope: request.scope, alternatives: 'Commons', estimatedCost: 0 });
    assert.notEqual(current.id, request.id);
  } finally { s.close(); }
});

test('mission replacement itself rolls back cancellation and meeting changes on failure', async () => {
  const s = fixture();
  try {
    const before = snapshot(s.store);
    failWrite(s.store, 'events', "NEW.type='mission.started'");
    assert.throws(() => s.service.setMission('New', 'New', [], 'operator'), /injected/);
    assert.deepEqual(snapshot(s.store), before);
  } finally { s.close(); }
});

function controlledHarness() {
  const calls: Array<{ job: Job; run: Run; onEvent: (event: any) => void; resolve: (result: RunResult) => void; reject: (error: Error) => void }> = [];
  const harness: Harness = { execute: (_agent, job, run, _signal, onEvent) => new Promise((resolve, reject) => calls.push({ job, run, onEvent, resolve, reject })) };
  return { harness, calls };
}

async function drain(scheduler: Scheduler) {
  for (let i = 0; i < 30 && scheduler.controllers.size; i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(scheduler.controllers.size, 0, 'fixture run should have settled');
}

test('run start atomically claims its job and records its agent/run state', async () => {
  const s = fixture(); const control = controlledHarness();
  const scheduler = new Scheduler(s.store, s.config, s.service, control.harness);
  try {
    const before = snapshot(s.store);
    failWrite(s.store, 'events', "NEW.type='agent.started'");
    await assert.rejects(scheduler.tick(), /injected/);
    assert.deepEqual(snapshot(s.store), before);
    assert.equal(control.calls.length, 0);
    assert.equal(scheduler.controllers.size, 0);
  } finally { s.close(); }
});

test('completion persistence failure halts work instead of misclassifying and retrying a successful run', async () => {
  const s = fixture(); const control = controlledHarness();
  const scheduler = new Scheduler(s.store, s.config, s.service, control.harness);
  try {
    await scheduler.tick(); await flush();
    const before = snapshot(s.store);
    failWrite(s.store, 'events', "NEW.type='run.completed'");
    control.calls[0]!.resolve({ ...result, sessionId: 'completed-session' });
    await drain(scheduler);
    assert.deepEqual(snapshot(s.store), before);
    assert.match(scheduler.blockReason()!, /restart the supervisor/);
    assert.throws(() => scheduler.resume(), /restart the supervisor/);
    assert.equal(s.store.all('runs')[0]!.status, 'running', 'recovery owns the ambiguous persistence state');
  } finally { s.close(); }
});

test('meeting activation cannot move half its participants or lose their wakeups', async () => {
  const s = fixture(); const control = controlledHarness();
  const scheduler = new Scheduler(s.store, s.config, s.service, control.harness);
  try {
    const startsAt = new Date(Date.now() + 60000);
    await s.service.tool('nova', 'meeting_schedule', { title: 'Discuss', agenda: 'Choose', expectedOutcome: 'Decision', roomId: 'lab', participants: ['nova', 'atlas'], startsAt: startsAt.toISOString(), durationMinutes: 5 });
    const before = snapshot(s.store);
    failWrite(s.store, 'entities', "NEW.collection='jobs' AND json_extract(NEW.data,'$.kind')='meeting' AND json_extract(NEW.data,'$.agentId')='atlas'");
    await assert.rejects(scheduler.tick(startsAt), /injected/);
    assert.deepEqual(snapshot(s.store), before);
    assert.equal(scheduler.controllers.size, 0);
  } finally { s.close(); }
});

test('a failed-run transition is atomic and preserves uncertainty when persistence fails', async () => {
  const s = fixture(); const control = controlledHarness();
  const scheduler = new Scheduler(s.store, s.config, s.service, control.harness);
  try {
    await scheduler.tick(); await flush();
    const before = snapshot(s.store);
    failWrite(s.store, 'events', "NEW.type='run.failed'");
    control.calls[0]!.reject(new Error('Fixture tool error'));
    await drain(scheduler);
    assert.deepEqual(snapshot(s.store), before);
    assert.match(scheduler.blockReason()!, /restart the supervisor/);
  } finally { s.close(); }
});

test('late results and events from a recovered attempt cannot change its replacement', async () => {
  const s = fixture(); const oldControl = controlledHarness(); const newControl = controlledHarness();
  const oldScheduler = new Scheduler(s.store, s.config, s.service, oldControl.harness);
  const newScheduler = new Scheduler(s.store, s.config, s.service, newControl.harness);
  try {
    await oldScheduler.tick(); await flush();
    const old = oldControl.calls[0]!;
    const oldToken = oldScheduler.grantRun(old.run.id);
    s.store.recover();
    await newScheduler.tick(); await flush();
    const replacement = newControl.calls[0]!;
    assert.equal(replacement.job.id, old.job.id);
    assert.equal(replacement.job.attempts, old.job.attempts + 1);
    const before = snapshot(s.store);
    old.onEvent({ type: 'system', subtype: 'init', session_id: 'stale-session' });
    old.resolve({ ...result, sessionId: 'stale-session' });
    await drain(oldScheduler);
    assert.deepEqual(snapshot(s.store), before);
    assert.equal(oldScheduler.authenticateRun(oldToken), undefined);
    replacement.resolve({ ...result, sessionId: 'current-session' });
    await drain(newScheduler);
    assert.equal(s.store.require('agents', 'nova').sessionId, 'current-session');
    assert.equal(s.store.require('runs', replacement.run.id).status, 'complete');
  } finally { s.close(); }
});

test('a lost HTTP response retries the same committed task command exactly once locally', async () => {
  const s = fixture(); const control = controlledHarness();
  const scheduler = new Scheduler(s.store, s.config, s.service, control.harness);
  const discord = new DiscordBridge(s.service, s.config, scheduler);
  const server = createHttpServer(s.service, scheduler, discord, s.config);
  const originalFetch = globalThis.fetch;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    s.config.port = (server.address() as { port: number }).port;
    await scheduler.tick(); await flush();
    const token = scheduler.grantRun(control.calls[0]!.run.id);
    let attempts = 0;
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      attempts++;
      if (attempts === 1) { assert.equal(response.status, 200); await response.text(); throw new TypeError('Reply dropped after commit'); }
      return response;
    };
    const reply = await callAgentTool(`http://127.0.0.1:${s.config.port}/agent/tools`, token, 'task_create', { ...taskInput, commandId: 'http-create' });
    assert.equal(reply.isError, false);
    assert.equal(attempts, 2);
    assert.equal(s.store.all('tasks').length, 1);
    assert.equal(s.store.events(0, 1000).filter(e => e.type === 'task.created').length, 1);
    assert.equal(s.service.context('nova').recentTaskCommands.length, 1);
    control.calls[0]!.resolve(result); await drain(scheduler);
  } finally {
    globalThis.fetch = originalFetch;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    s.close();
  }
});

test('schema migration preserves legacy task identities and cancels unverifiable wakeups', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collective-migration-'));
  const file = join(dir, 'legacy.sqlite');
  const db = new DatabaseSync(file);
  // Construct a v1 database without importing the current Store's bootstrap.
  db.exec(`CREATE TABLE entities(collection TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(collection,id));
    CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,actor_id TEXT NOT NULL,entity_id TEXT,data TEXT NOT NULL,created_at TEXT NOT NULL);
    PRAGMA user_version=1;`);
  const put = (collection: string, value: Record<string, unknown>) => db.prepare('INSERT INTO entities VALUES(?,?,?)').run(collection, String(value.id), JSON.stringify(value));
  put('missions', { id: 'mission-old', revision: 4, status: 'active' });
  put('tasks', { id: 'task-old', missionId: 'mission-old', title: 'Retained task' });
  put('jobs', { id: 'job-known', status: 'pending', payload: { taskId: 'task-old' } });
  put('jobs', { id: 'job-unknown', status: 'pending', payload: { content: 'Legacy wakeup' } });
  const taskBefore = db.prepare("SELECT data FROM entities WHERE collection='tasks'").get();
  try {
    migrate(db);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
    assert.deepEqual(db.prepare("SELECT data FROM entities WHERE collection='tasks'").get(), taskBefore);
    const jobs = (db.prepare("SELECT data FROM entities WHERE collection='jobs' ORDER BY id").all() as { data: string }[]).map(r => JSON.parse(r.data));
    assert.equal(jobs[0].missionId, 'mission-old'); assert.equal(jobs[0].missionRevision, 4);
    assert.equal(jobs[1].status, 'cancelled');
    migrate(db); // Idempotent on an already migrated database.
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed migration rolls back schema changes and a newer database version is rejected', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE command_receipts(id TEXT);');
    assert.throws(() => migrate(db), /already exists/);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 0);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='entities'").get(), undefined);
    db.exec('PRAGMA user_version=999;');
    assert.throws(() => migrate(db), /newer than supported/);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 999);
  } finally { db.close(); }
});

test('startup backup includes committed WAL data and can restore the previous schema', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'collective-backup-'));
  const file = join(directory, 'db.sqlite');
  const writer = new DatabaseSync(file);
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE example(value TEXT); INSERT INTO example VALUES('committed in WAL'); PRAGMA user_version=1;");
    const backupPath = await backupBeforeMigration(file);
    assert.ok(backupPath);
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    writer.exec("INSERT INTO example VALUES('after backup');");
    const restored = join(directory, 'restored.sqlite');
    copyFileSync(backupPath, restored);
    const reader = new DatabaseSync(restored, { readOnly: true });
    try {
      assert.equal((reader.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
      assert.deepEqual(reader.prepare('SELECT value FROM example').all().map(row => row.value), ['committed in WAL']);
    } finally { reader.close(); }
  } finally { writer.close(); rmSync(directory, { recursive: true, force: true }); }
});
