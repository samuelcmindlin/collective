import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { seed } from '../src/seed.js';
import { CollectiveService } from '../src/service.js';
import type { Artifact, Task } from '../src/types.js';
import type { Criterion } from '../src/progress/types.js';
import { checkJsonFields, MAX_CHECK_BYTES } from '../src/progress/checks.js';
import { progressTables } from '../src/storage/progress-migration.js';
import { reviewFields, inspectSubmission } from './progress-helpers.js';
import { createHttpServer } from '../src/http.js';
import { Scheduler } from '../src/scheduler.js';
import { SimulationHarness } from '../src/simulation.js';
import { DiscordBridge } from '../src/discord.js';

const jsonCriterion: Extract<Criterion, { method: 'json.fields.v1' }> = { id: 'format', description: 'A structured answer', method: 'json.fields.v1', evidenceKind: 'artifact', fields: [{ name: 'answer', type: 'string' }] };
const criteria: Criterion[] = [jsonCriterion, { id: 'useful', description: 'The answer addresses the question', method: 'judgment', evidenceKind: 'artifact' }];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'collective-progress-'));
  const store = new Store(join(dir, 'db.sqlite')); seed(store);
  const config = { root: process.cwd(), dataDir: dir, port: 0, mode: 'simulation' as const, claudeBin: 'unused', operatorIds: [] };
  const service = new CollectiveService(store, config); service.setMission('Answer', 'Find a useful answer', ['A useful answer'], 'operator');
  return { dir, store, service, config, close() { service.knowledge.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const input = { title: 'Answer a question', description: 'Produce an answer and its limitations', acceptance: 'A structured, useful answer', ownerId: 'atlas' };
async function create(s: ReturnType<typeof fixture>, policy = criteria) {
  return await s.service.tool('nova', 'task_create', { ...input, criteria: policy }) as Task;
}
async function publish(s: ReturnType<typeof fixture>, content = '{"answer":"A grounded answer"}') {
  writeFileSync(join(s.service.workspace('atlas'), 'answer.json'), content);
  return await s.service.tool('atlas', 'artifact_publish', { title: 'Answer', description: 'Candidate answer', path: 'answer.json' }) as Artifact;
}
async function submit(s: ReturnType<typeof fixture>, task: Task, artifact: Artifact, commandId?: string) {
  const policy = s.service.progress.criteria(task.id)!;
  return await s.service.tool('atlas', 'task_submit', { taskId: task.id, commandId,
    bindings: policy.criteria.map(c => ({ criterionId: c.id, evidenceIds: [artifact.id] })), note: 'Ready for review', limitations: ['Meaning requires independent judgment.'] }) as Task;
}
function snapshot(s: ReturnType<typeof fixture>) {
  return JSON.stringify({ entities: s.store.db.prepare('SELECT * FROM entities ORDER BY collection,id').all(),
    events: s.store.db.prepare('SELECT * FROM events ORDER BY id').all(), receipts: s.store.db.prepare('SELECT * FROM command_receipts ORDER BY principal_id,command_id').all(),
    progress: progressTables.map(table => s.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()) });
}

// These checks exercise the public application commands, not a test-only acceptance path.
test('criteria freeze at creation with explicit proposal authority and reject forged policy fields', async () => {
  const s = fixture();
  try {
    const task = await create(s), contract = s.service.progress.criteria(task.id)!;
    assert.equal(task.criteriaId, contract.id); assert.equal(contract.authorId, 'nova');
    assert.equal(contract.authority, 'agent-proposed'); assert.deepEqual(contract.criteria, criteria);
    assert.equal(contract.missionRevision, s.service.activeMission()!.revision);
    const before = snapshot(s);
    await assert.rejects(s.service.tool('atlas', 'task_update', { taskId: task.id, status: 'doing', criteria: [] }));
    for (const policy of [[jsonCriterion, jsonCriterion], [{ ...jsonCriterion, fields: [jsonCriterion.fields[0], jsonCriterion.fields[0]] }], [{ ...jsonCriterion, method: 'shell', command: 'echo pass' }]]) {
      await assert.rejects(s.service.tool('atlas', 'task_create', { ...input, criteria: policy }));
    }
    await assert.rejects(s.service.tool('atlas', 'task_create', { ...input, authority: 'operator', criteria }));
    assert.equal(snapshot(s), before);
  } finally { s.close(); }
});

test('submissions reject missing, duplicate, mismatched and wrong-kind criterion bindings atomically', async () => {
  const s = fixture();
  try {
    const task = await create(s), artifact = await publish(s);
    const note = s.service.knowledge.write('atlas', { title: 'Note', content: 'An answer', kind: 'fact' });
    const good = criteria.map(c => ({ criterionId: c.id, evidenceIds: [artifact.id] }));
    const before = snapshot(s);
    for (const fields of [{}, { evidenceIds: [artifact.id] }, { bindings: good.slice(0, 1) }, { bindings: [good[0], good[0]] },
      { bindings: good.map(b => ({ ...b, evidenceIds: [artifact.id, artifact.id] })) }, { bindings: good, evidenceIds: [artifact.id] },
      { bindings: good.map(b => ({ ...b, evidenceIds: [note.id] })) }, { bindings: [{ criterionId: 'invented', evidenceIds: [artifact.id] }] }]) {
      await assert.rejects(s.service.tool('atlas', 'task_submit', { taskId: task.id, note: 'Ready', ...fields }));
      assert.equal(snapshot(s), before);
    }
  } finally { s.close(); }
});

test('protected failures persist, cannot be overruled, and rejected attempts survive correction and stale reviews', async () => {
  const s = fixture();
  try {
    const task = await create(s), broken = await publish(s, '{"unrelated":"Missing answer"}');
    const first = await submit(s, task, broken, 'submit-broken');
    const old = s.service.progress.get({ taskId: task.id });
    assert.equal(old.submission!.checks[0]!.status, 'fail');
    assert.equal(old.submission!.criteriaHash, old.criteria!.sha256);
    assert.equal(old.submission!.evidence[0]!.sha256, broken.sha256);
    await inspectSubmission(s.service, 'iris', task.id);
    const before = snapshot(s);
    await assert.rejects(s.service.tool('iris', 'task_review', { taskId: task.id, ...reviewFields(s.service, task.id), accepted: true, note: 'I choose to override it' }), /protected check/);
    assert.equal(snapshot(s), before);
    const rejection = { commandId: 'reject-broken', taskId: task.id, ...reviewFields(s.service, task.id, false), accepted: false, note: 'The answer field is missing.' };
    await s.service.tool('iris', 'task_review', rejection);
    const corrected = await publish(s);
    const second = await submit(s, s.store.require('tasks', task.id), corrected, 'submit-corrected');
    assert.notEqual(first.submissionId, second.submissionId);
    assert.equal(s.service.progress.get({ taskId: task.id }).submission!.round, 2);
    await assert.rejects(s.service.tool('iris', 'task_review', { ...rejection, commandId: 'stale-rejection' }), /Stale submission/);
    // A retry returns its old receipt without reverting the newly submitted task.
    await s.service.tool('iris', 'task_review', rejection);
    assert.equal(s.store.require('tasks', task.id).submissionId, second.submissionId);
    const acceptance = { commandId: 'accept-corrected', taskId: task.id, ...reviewFields(s.service, task.id), accepted: true, note: 'The corrected answer was inspected.' };
    await assert.rejects(s.service.tool('iris', 'task_review', acceptance), /task_evidence_read/);
    await inspectSubmission(s.service, 'iris', task.id);
    const [a, b] = await Promise.all([s.service.tool('iris', 'task_review', acceptance), s.service.tool('iris', 'task_review', acceptance)]);
    assert.deepEqual(a, b); assert.equal(s.store.require('agents', 'atlas').completed, 1);
    const history = s.service.progress.get({ taskId: task.id, submissionId: first.submissionId });
    assert.equal(history.evaluation!.accepted, false); assert.equal(history.submission!.checks[0]!.status, 'fail');
    assert.equal(history.inspections.length, 1, 'rejections retain the actual read receipt when one exists');
    assert.equal(history.attempts.length, 2);
    assert.equal(s.service.progress.get({ taskId: task.id }).evaluation!.inspectionIds.length, 1);
  } finally { s.close(); }
});

test('reviews require full criterion verdicts, exact evidence bindings and the independent reviewer’s own reads', async () => {
  const s = fixture();
  try {
    const task = await create(s), artifact = await publish(s); await submit(s, task, artifact);
    const fields = reviewFields(s.service, task.id);
    await inspectSubmission(s.service, 'atlas', task.id);
    await assert.rejects(s.service.tool('atlas', 'task_review', { taskId: task.id, ...fields, accepted: true, note: 'Self approval' }), /cannot approve your own/);
    await assert.rejects(s.service.tool('iris', 'task_review', { taskId: task.id, ...fields, accepted: true, note: 'No read' }), /task_evidence_read/);
    await inspectSubmission(s.service, 'iris', task.id);
    const before = snapshot(s);
    for (const patch of [{ verdicts: fields.verdicts.slice(0, 1) }, { verdicts: [fields.verdicts[0], fields.verdicts[0]] },
      { verdicts: fields.verdicts.map(v => ({ ...v, evidenceIds: ['invented'] })) }, { verdicts: fields.verdicts.map(v => ({ ...v, verdict: 'uncertain' })) },
      { checks: [{ status: 'pass' }] }, { submissionId: 'invented' }]) {
      await assert.rejects(s.service.tool('iris', 'task_review', { taskId: task.id, ...fields, accepted: true, note: 'Invalid review', ...patch }));
      assert.equal(snapshot(s), before);
    }
    await assert.rejects(s.service.tool('iris', 'task_review', { taskId: task.id, accepted: true, note: 'Looks fine' }));
  } finally { s.close(); }
});

test('evidence reads bind the exact submission and expose bounded content without invented full-read claims', async () => {
  const s = fixture();
  try {
    const task = await create(s, [{ id: 'read', description: 'Inspect a document', method: 'judgment', evidenceKind: 'artifact' }]);
    const artifact = await publish(s, JSON.stringify({ answer: 'a'.repeat(20000) }));
    const submitted = await submit(s, task, artifact);
    const read = await s.service.tool('iris', 'task_evidence_read', { submissionId: submitted.submissionId, evidenceId: artifact.id, maxChars: 20 }) as any;
    assert.equal(read.content.length, 20); assert.equal(read.nextOffset, 20); assert.equal(read.truncated, true);
    assert.equal(read.receipt.returnedChars, 20); assert.equal(read.receipt.mode, 'text');
    assert.equal(read.receipt.sha256, artifact.sha256); assert.equal(read.receipt.submissionId, submitted.submissionId);
    const before = snapshot(s);
    for (const patch of [{ evidenceId: 'other' }, { submissionId: 'other' }, { offset: 5000000 }, { maxChars: 12001 }]) {
      await assert.rejects(s.service.tool('iris', 'task_evidence_read', { submissionId: submitted.submissionId, evidenceId: artifact.id, ...patch }));
      assert.equal(snapshot(s), before);
    }
    await assert.rejects(s.service.tool('iris', 'task_get', { taskId: (await create(s)).id, submissionId: submitted.submissionId }), /another task/);
  } finally { s.close(); }
});

test('changed artifact metadata cannot redirect an already inspected submission to new bytes', async () => {
  const s = fixture();
  try {
    const task = await create(s), artifact = await publish(s); await submit(s, task, artifact);
    await inspectSubmission(s.service, 'iris', task.id);
    const replacement = await publish(s, '{"answer":"A different answer"}');
    const stored = s.store.require('artifacts', replacement.id);
    s.store.patch('artifacts', artifact.id, { path: stored.path, sha256: stored.sha256, size: stored.size });
    const before = snapshot(s);
    await assert.rejects(s.service.tool('iris', 'task_review', { taskId: task.id, ...reviewFields(s.service, task.id), accepted: true, note: 'Old inspection' }), /integrity/i);
    assert.equal(snapshot(s), before);
  } finally { s.close(); }
});

test('corruption after inspection blocks acceptance while rejection retains the failed evidence binding', async () => {
  const s = fixture();
  try {
    const task = await create(s), artifact = await publish(s); await submit(s, task, artifact); await inspectSubmission(s.service, 'iris', task.id);
    const path = join(s.dir, s.store.require('artifacts', artifact.id).path);
    chmodSync(path, 0o600); writeFileSync(path, 'broken');
    await assert.rejects(s.service.tool('iris', 'task_review', { taskId: task.id, ...reviewFields(s.service, task.id), accepted: true, note: 'Old inspection' }), /integrity/i);
    await s.service.tool('iris', 'task_review', { taskId: task.id, ...reviewFields(s.service, task.id, false), accepted: false, note: 'Cannot verify current snapshot.' });
    const view = s.service.progress.get({ taskId: task.id });
    assert.equal(view.evaluation!.accepted, false); assert.equal(view.submission!.evidence[0]!.sha256, artifact.sha256);
  } finally { s.close(); }
});

test('JSON checks reject malformed data, wrong types, inherited fields and excessive input without executing it', () => {
  const policy: typeof jsonCriterion = { ...jsonCriterion, fields: [{ name: 'answer', type: 'string' }, { name: 'n', type: 'number' }, { name: 'b', type: 'boolean' }, { name: 'a', type: 'array' }, { name: 'o', type: 'object' }] };
  const good = { answer: 'Useful', n: 4, b: true, a: [], o: {} };
  assert.equal(checkJsonFields(Buffer.from(JSON.stringify(good)), policy).status, 'pass');
  for (const bytes of [Buffer.from('globalThis.executable = true'), Buffer.from([255, 254]), Buffer.from('[]'), Buffer.from('null'),
    ...[{ ...good, answer: ' ' }, { ...good, n: '4' }, { ...good, b: 1 }, { ...good, a: {} }, { ...good, o: [] }].map(v => Buffer.from(JSON.stringify(v))),
    Buffer.from('{"answer":"text","n":1e999,"b":true,"a":[],"o":{}}')]) assert.equal(checkJsonFields(bytes, policy).status, 'fail');
  assert.equal(checkJsonFields(Buffer.from('{}'), { ...jsonCriterion, fields: [{ name: 'toString', type: 'string' }] }).status, 'fail');
  assert.equal(checkJsonFields(Buffer.alloc(MAX_CHECK_BYTES + 1, 32), policy).status, 'error');
});

test('check errors remain visible and binary inspection receipts do not claim text or visual access', async () => {
  const s = fixture();
  try {
    const task = await create(s), artifact = await publish(s, JSON.stringify({ answer: 'x'.repeat(MAX_CHECK_BYTES) }));
    await submit(s, task, artifact);
    assert.equal(s.service.progress.get({ taskId: task.id }).submission!.checks[0]!.status, 'error');
    await assert.rejects(s.service.tool('iris', 'task_review', { taskId: task.id, ...reviewFields(s.service, task.id), accepted: true, note: 'Override error' }), /protected check/);
    const binaryTask = await create(s, [{ id: 'inspect', description: 'Inspect binary metadata', evidenceKind: 'artifact', method: 'judgment' }]);
    writeFileSync(join(s.service.workspace('atlas'), 'data.bin'), Buffer.from([0, 255, 1]));
    const binary = await s.service.tool('atlas', 'artifact_publish', { title: 'Binary', description: 'Metadata fixture', path: 'data.bin' }) as Artifact;
    const submitted = await submit(s, binaryTask, binary);
    const result = await s.service.tool('iris', 'task_evidence_read', { submissionId: submitted.submissionId, evidenceId: binary.id }) as any;
    assert.equal(result.content, undefined); assert.equal(result.receipt.mode, 'binary-metadata');
    assert.equal(result.receipt.returnedChars, 0); assert.equal(result.receipt.totalChars, undefined);
  } finally { s.close(); }
});

test('knowledge submissions continue to inspect the exact cited revision after newer revisions are published', async () => {
  const s = fixture();
  try {
    const task = await s.service.tool('nova', 'task_create', input) as Task;
    const old = s.service.knowledge.write('atlas', { title: 'Constraint', content: 'First version', kind: 'decision' });
    const submitted = await s.service.tool('atlas', 'task_submit', { taskId: task.id, evidenceIds: [old.id], note: 'Exact cited version' }) as Task;
    s.service.knowledge.write('atlas', { title: 'Constraint', content: 'Second version', kind: 'decision', previousId: old.id });
    const result = await s.service.tool('iris', 'task_evidence_read', { submissionId: submitted.submissionId, evidenceId: old.id }) as any;
    assert.equal(result.content, 'First version'); assert.equal(result.evidence.sha256, old.sha256);
    assert.equal(result.evidence.documentId, old.documentId);
  } finally { s.close(); }
});

test('attempt history is paged without losing earlier rejected evaluations', async () => {
  const s = fixture();
  try {
    const task = await create(s), artifact = await publish(s);
    for (let i = 0; i < 7; i++) {
      await submit(s, s.store.require('tasks', task.id), artifact);
      await s.service.tool('iris', 'task_review', { taskId: task.id, ...reviewFields(s.service, task.id, false), accepted: false, note: `Experiment ${i}: revise the argument.` });
    }
    const first = s.service.progress.get({ taskId: task.id });
    assert.equal(first.attempts.length, 5); assert.equal(first.nextOffset, 5);
    const second = s.service.progress.get({ taskId: task.id, offset: first.nextOffset });
    assert.equal(second.attempts.length, 2); assert.equal(second.nextOffset, null);
    assert.equal(new Set([...first.attempts, ...second.attempts].map(a => a.id)).size, 7);
    const original = s.service.progress.get({ taskId: task.id, submissionId: second.attempts.at(-1)!.id });
    assert.equal(original.submission!.round, 1); assert.equal(original.evaluation!.note, 'Experiment 0: revise the argument.');
  } finally { s.close(); }
});

test('progress ledger write failures roll back records, events, receipts, tasks and wakeups', async t => {
  for (const stage of ['criteria', 'submission', 'evaluation', 'inspection', 'inspection-event']) await t.test(stage, async () => {
    const s = fixture();
    try {
      let task: Task | undefined, artifact: Artifact | undefined;
      if (stage !== 'criteria') { task = await create(s); artifact = await publish(s); }
      if (['evaluation', 'inspection', 'inspection-event'].includes(stage)) await submit(s, task!, artifact!);
      if (stage === 'evaluation') await inspectSubmission(s.service, 'iris', task!.id);
      const table = ({ criteria: 'progress_criteria', submission: 'progress_submissions', evaluation: 'progress_evaluations', inspection: 'progress_inspections', 'inspection-event': 'events' })[stage]!;
      s.store.db.exec(`CREATE TEMP TRIGGER fail_progress BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected progress failure'); END;`);
      const before = snapshot(s);
      const action = stage === 'criteria' ? create(s) : stage === 'submission' ? submit(s, task!, artifact!) : stage === 'evaluation'
        ? s.service.tool('iris', 'task_review', { taskId: task!.id, ...reviewFields(s.service, task!.id), accepted: true, note: 'Checked' })
        : s.service.tool('iris', 'task_evidence_read', { submissionId: s.store.require('tasks', task!.id).submissionId, evidenceId: artifact!.id });
      await assert.rejects(action, /injected progress failure/); assert.equal(snapshot(s), before);
    } finally { s.close(); }
  });
});

test('accepted evaluation and retry identities survive reopen; ledgers reject update and deletion', async () => {
  const s = fixture();
  const task = await create(s), artifact = await publish(s); await submit(s, task, artifact, 'durable-submit'); await inspectSubmission(s.service, 'iris', task.id);
  const review = { commandId: 'durable-review', taskId: task.id, ...reviewFields(s.service, task.id), accepted: true, note: 'Recorded judgment' };
  const accepted = await s.service.tool('iris', 'task_review', review);
  for (const table of progressTables.filter(t => t !== 'progress_legacy_tasks')) {
    assert.throws(() => s.store.db.exec(`UPDATE ${table} SET data='{}'`), /immutable/);
    assert.throws(() => s.store.db.exec(`DELETE FROM ${table}`), /immutable/);
  }
  const before = snapshot(s);
  s.service.knowledge.close(); s.store.close();
  const reopened = new Store(join(s.dir, 'db.sqlite')); const service = new CollectiveService(reopened, s.config);
  try {
    assert.deepEqual(await service.tool('iris', 'task_review', review), accepted);
    assert.equal(snapshot({ ...s, store: reopened }), before);
    await assert.rejects(service.tool('iris', 'task_review', { ...review, note: 'Changed intent' }), /Command ID conflict/);
    assert.equal(service.progress.get({ taskId: task.id }).evaluation!.criteriaHash, service.progress.criteria(task.id)!.sha256);
  } finally { service.knowledge.close(); reopened.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test('migration preserves legacy accepted work and requires fresh submissions for old pending reviews', async () => {
  const s = fixture();
  const missionId = s.service.activeMission()!.id;
  const knowledge = s.service.knowledge.write('atlas', { title: 'Legacy rules', content: 'Match four pairs', kind: 'decision' });
  const task: Task = { ...input, id: 'old-done', missionId, status: 'done', dependencies: [], evidence: [knowledge.id], createdAt: new Date().toISOString(), review: { reviewerId: 'iris', accepted: true, note: 'Old review', at: new Date().toISOString() } };
  s.store.put('tasks', task); s.store.put('tasks', { ...task, id: 'old-review', status: 'review', review: undefined });
  for (const table of progressTables) s.store.db.exec(`DROP TABLE ${table}`);
  s.store.db.exec('PRAGMA user_version=3'); s.store.patch('settings', 'settings', { paused: false });
  const taskBytes = s.store.db.prepare("SELECT id,data FROM entities WHERE collection='tasks' ORDER BY id").all();
  const knowledgeBytes = s.store.db.prepare('SELECT * FROM knowledge_revisions ORDER BY id').all();
  s.service.knowledge.close(); s.store.close();
  const upgraded = new Store(join(s.dir, 'db.sqlite')); const service = new CollectiveService(upgraded, s.config);
  try {
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get()!.user_version, 4);
    assert.equal(upgraded.settings().paused, true);
    assert.deepEqual(upgraded.db.prepare('SELECT id,data FROM progress_legacy_tasks ORDER BY id').all(), taskBytes);
    assert.deepEqual(upgraded.db.prepare("SELECT id,data FROM entities WHERE collection='tasks' ORDER BY id").all(), taskBytes);
    assert.deepEqual(upgraded.db.prepare('SELECT * FROM knowledge_revisions ORDER BY id').all(), knowledgeBytes);
    const old = service.progress.get({ taskId: task.id }); assert.equal(old.legacy, true); assert.equal(old.criteria, null); assert.equal(old.evaluation, null);
    assert.throws(() => upgraded.db.exec("UPDATE progress_legacy_tasks SET data='{}'"), /immutable/);
    await assert.rejects(service.tool('iris', 'task_review', { taskId: 'old-review', submissionId: 'invented', accepted: true, note: 'Unsupported old review', verdicts: [{ criterionId: 'acceptance', evidenceIds: [knowledge.id], verdict: 'pass', rationale: 'Old' }] }), /Legacy reviews must be resubmitted/);
    await service.tool('atlas', 'task_submit', { taskId: 'old-review', evidenceIds: [knowledge.id], note: 'Fresh submission of legacy work' });
    await inspectSubmission(service, 'iris', 'old-review');
    await service.tool('iris', 'task_review', { taskId: 'old-review', ...reviewFields(service, 'old-review'), accepted: true, note: 'Explicit new judgment' });
    assert.equal(service.progress.criteria('old-review')!.authority, 'legacy');
    assert.deepEqual(upgraded.require('tasks', 'old-done'), task);
  } finally { service.knowledge.close(); upgraded.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test('operator task details expose the same frozen evaluation and require local authentication', async () => {
  const s = fixture();
  const scheduler = new Scheduler(s.store, s.config, s.service, new SimulationHarness(s.service));
  const discord = new DiscordBridge(s.service, s.config, scheduler);
  const server = createHttpServer(s.service, scheduler, discord, s.config);
  try {
    const task = await create(s), artifact = await publish(s); await submit(s, task, artifact);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); s.config.port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${s.config.port}`, path = `/api/tasks/get?taskId=${task.id}`;
    assert.equal((await fetch(base + path)).status, 403);
    const root = await fetch(base); await root.text(); const cookie = root.headers.get('set-cookie')!.split(';')[0]!;
    const response = await fetch(base + path, { headers: { cookie } }); assert.equal(response.status, 200);
    const view = await response.json() as any; assert.equal(view.submission.criteriaHash, view.criteria.sha256); assert.equal(view.submission.checks[0].status, 'pass');
    assert.equal((await fetch(base + path + '&offset=-1', { headers: { cookie } })).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); s.close(); }
});
