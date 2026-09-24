// Read-only with respect to app data: every probe uses its own in-memory database.
// Run after `npm run build`. These characterize the reviewed prototype; they are
// not regression tests that require these shortcomings to remain unfixed.
import { Store } from '../dist/src/store.js';
import { seed } from '../dist/src/seed.js';
import { CollectiveService } from '../dist/src/service.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

function fixture() {
  const store = new Store(':memory:');
  seed(store);
  const service = new CollectiveService(store, {
    root: process.cwd(), dataDir: '/tmp/collective-review-unused', port: 4399,
    mode: 'simulation', claudeBin: 'unused', operatorIds: [],
  });
  return { store, service };
}

const findings = [];
{
  const { store, service } = fixture();
  service.setMission('First mission', 'Create a game', [], 'operator');
  const beforeJobs = store.all('jobs').length;
  store.enqueue = () => { throw new Error('Injected enqueue failure'); };
  let rejected = false;
  try {
    await service.tool('nova', 'task_create', {
      title: 'Build', description: 'Build the game', ownerId: 'ember', acceptance: 'Playable',
    });
  } catch { rejected = true; }
  findings.push({ id: 'R1', probe: 'Failure between task creation and job enqueue',
    commandRejected: rejected, tasksPersisted: store.all('tasks').length,
    jobsAdded: store.all('jobs').length - beforeJobs });
  store.close();
}
{
  const { store, service } = fixture();
  service.setMission('Old mission', 'Create a game', [], 'operator');
  const task = await service.tool('nova', 'task_create', {
    title: 'Old task', description: 'Work for the old mission', ownerId: 'ember', acceptance: 'A working game',
  });
  service.setMission('New mission', 'Investigate a different topic', [], 'operator');
  const note = await service.tool('ember', 'knowledge_write', {
    title: 'Unrelated note', content: 'The sky is blue.', kind: 'hypothesis',
  });
  let submissionRejected = false;
  let reviewRejected = false;
  try { await service.tool('ember', 'task_submit', { taskId: task.id, evidenceIds: [note.id], note: 'Done' }); }
  catch { submissionRejected = true; }
  try { await service.tool('iris', 'task_review', { taskId: task.id, accepted: true, note: 'Looks fine' }); }
  catch { reviewRejected = true; }
  findings.push({ id: 'R2', probe: 'Mutation of a task after its mission is replaced',
    taskInActiveMission: task.missionId === service.activeMission().id,
    oldTaskStatus: store.require('tasks', task.id).status, submissionRejected, reviewRejected });
  store.close();
}
{
  const { store, service } = fixture();
  service.setMission('Current mission', 'Create a game', [], 'operator');
  const task = await service.tool('nova', 'task_create', {
    title: 'Build a game', description: 'Create a playable game', ownerId: 'ember', acceptance: 'A working game',
  });
  const note = await service.tool('ember', 'knowledge_write', {
    title: 'Unrelated note', content: 'The sky is blue.', kind: 'hypothesis',
  });
  const reviewNote = 'Looks fine';
  await service.tool('ember', 'task_submit', { taskId: task.id, evidenceIds: [note.id], note: 'Done' });
  await service.tool('iris', 'task_review', { taskId: task.id, accepted: true, note: reviewNote });
  findings.push({ id: 'R4', probe: 'Acceptance of current-mission work with unrelated evidence',
    taskInActiveMission: task.missionId === service.activeMission().id,
    taskStatus: store.require('tasks', task.id).status,
    evidenceTitle: store.require('knowledge', note.id).title,
    reviewNote });
  store.close();
}
{
  const { store, service } = fixture();
  const original = await service.tool('atlas', 'knowledge_write', {
    title: 'Early important decision', content: 'The game must support keyboard controls.', kind: 'decision',
  });
  for (let i = 0; i < 30; i++) await service.tool('atlas', 'knowledge_write', {
    title: `Later note ${i}`, content: 'A routine observation.', kind: 'hypothesis',
  });
  const context = service.context('ember');
  findings.push({ id: 'R3a', probe: 'Retrieval after 30 newer records',
    storedRecords: store.all('knowledge').length,
    recordsInContext: context.knowledge.length,
    importantDecisionPresent: context.knowledge.some(k => k.id === original.id) });
  const a = await service.tool('atlas', 'knowledge_write', {
    title: 'Decision revision A', content: 'Keyboard and pointer controls.', kind: 'decision', previousId: original.id,
  });
  const b = await service.tool('ember', 'knowledge_write', {
    title: 'Decision revision B', content: 'Pointer controls only.', kind: 'decision', previousId: original.id,
  });
  findings.push({ id: 'R3b', probe: 'Competing revisions from the same parent',
    revisions: [a.revision, b.revision],
    bothPresentedAsCurrent: service.context('nova').knowledge.filter(k => [a.id, b.id].includes(k.id)).length === 2 });
  store.close();
}
const sourceFiles = ['src/service.ts', 'src/store.ts', 'src/scheduler.ts', 'src/discord.ts', 'src/claude.ts', 'src/application/tasks.ts', 'src/application/commands.ts', 'src/storage/migrations.ts'];
console.log(JSON.stringify({ recordedAt: new Date().toISOString(), method: 'In-memory domain probes; no models, credentials, app databases, or network',
  sourceHashes: Object.fromEntries(sourceFiles.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])), findings }, null, 2));
