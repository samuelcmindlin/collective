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
  service.knowledge.close(); store.close();
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
  try { await service.tool('iris', 'task_review', { taskId: task.id, submissionId: 'not-submitted', verdicts: [{ criterionId: 'acceptance', verdict: 'pass', evidenceIds: [note.id], rationale: 'Old mission probe' }], accepted: true, note: 'Looks fine' }); }
  catch { reviewRejected = true; }
  findings.push({ id: 'R2', probe: 'Mutation of a task after its mission is replaced',
    taskInActiveMission: task.missionId === service.activeMission().id,
    oldTaskStatus: store.require('tasks', task.id).status, submissionRejected, reviewRejected });
  service.knowledge.close(); store.close();
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
  let unstructuredReviewRejected = false;
  try { await service.tool('iris', 'task_review', { taskId: task.id, accepted: true, note: reviewNote }); }
  catch { unstructuredReviewRejected = true; }
  const { submission } = service.progress.get({ taskId: task.id });
  await service.tool('iris', 'task_evidence_read', { submissionId: submission.id, evidenceId: note.id });
  await service.tool('iris', 'task_review', { taskId: task.id, submissionId: submission.id, accepted: true,
    verdicts: submission.bindings.map(binding => ({ ...binding, verdict: 'pass', rationale: 'Intentionally poor subjective judgment in a diagnostic probe.' })), note: reviewNote });
  findings.push({ id: 'R4', probe: 'Acceptance of current-mission work with unrelated evidence',
    taskInActiveMission: task.missionId === service.activeMission().id,
    unstructuredReviewRejected, subjectiveSemanticGapRemains: true, taskStatus: store.require('tasks', task.id).status,
    evidenceTitle: service.knowledge.get({ kind: 'agent', id: 'iris' }, { revisionId: note.id }).title,
    reviewNote });
  service.knowledge.close(); store.close();
}
{
  const { store, service } = fixture();
  service.setMission('Knowledge retrieval', 'Record and reuse decisions', [], 'operator');
  const original = await service.tool('atlas', 'knowledge_write', {
    title: 'Early important decision', content: 'The game must support keyboard controls.', kind: 'decision',
  });
  for (let i = 0; i < 30; i++) await service.tool('atlas', 'knowledge_write', {
    title: `Later note ${i}`, content: 'A routine observation.', kind: 'hypothesis',
  });
  const context = service.context('ember');
  findings.push({ id: 'R3a', probe: 'Retrieval after 30 newer records',
    storedRecords: store.db.prepare('SELECT COUNT(*) AS count FROM knowledge_revisions').get().count,
    recordsInContext: context.knowledge.length,
    importantDecisionPresent: context.knowledge.some(k => k.id === original.id),
    searchableBeyondContext: service.knowledge.search({ kind: 'agent', id: 'ember' }, { query: 'keyboard controls' }).entries.some(k => k.id === original.id) });
  const a = await service.tool('atlas', 'knowledge_write', {
    title: 'Decision revision A', content: 'Keyboard and pointer controls.', kind: 'decision', previousId: original.id,
  });
  let competingRevisionRejected = false;
  try { await service.tool('ember', 'knowledge_write', {
    title: 'Decision revision B', content: 'Pointer controls only.', kind: 'decision', previousId: original.id,
  }); } catch { competingRevisionRejected = true; }
  findings.push({ id: 'R3b', probe: 'Competing revisions from the same parent',
    competingRevisionRejected, currentRevision: service.knowledge.get({ kind: 'agent', id: 'nova' }, { documentId: original.documentId }).id,
    originalCitationStillReadable: service.knowledge.get({ kind: 'agent', id: 'nova' }, { revisionId: original.id }).content.includes('keyboard'),
    acceptedRevision: a.id });
  service.knowledge.close(); store.close();
}
const sourceFiles = ['src/service.ts', 'src/store.ts', 'src/scheduler.ts', 'src/discord.ts', 'src/claude.ts', 'src/application/tasks.ts', 'src/application/commands.ts', 'src/storage/migrations.ts', 'src/knowledge/repository.ts', 'src/knowledge/import.ts', 'src/knowledge/search.ts', 'src/progress/repository.ts', 'src/progress/checks.ts', 'src/progress/schemas.ts'];
console.log(JSON.stringify({ recordedAt: new Date().toISOString(), method: 'In-memory domain probes; no models, credentials, app databases, or network',
  sourceHashes: Object.fromEntries(sourceFiles.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])), findings }, null, 2));
