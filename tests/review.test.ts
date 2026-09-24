import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { seed } from '../src/seed.js';
import { CollectiveService } from '../src/service.js';
import type { Artifact, Task } from '../src/types.js';
import { readArtifactSnapshot, MAX_ARTIFACT_BYTES } from '../src/storage/artifacts.js';
import { createHttpServer } from '../src/http.js';
import { Scheduler } from '../src/scheduler.js';
import { SimulationHarness } from '../src/simulation.js';
import { DiscordBridge } from '../src/discord.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'collective-review-'));
  const store = new Store(':memory:'); seed(store);
  const config = { root: process.cwd(), dataDir: dir, port: 0, mode: 'simulation' as const, claudeBin: 'unused', operatorIds: [] };
  const service = new CollectiveService(store, config); service.setMission('Review', 'Test the boundaries', [], 'operator');
  return { dir, store, service, close() { service.knowledge.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const note = { title: 'Early decision', content: 'An old constraint', kind: 'decision' as const };

test('revising an older document brings its latest revision into recent context', () => {
  const s = fixture();
  try {
    const old = s.service.knowledge.write('atlas', note);
    for (let i = 0; i < 30; i++) s.service.knowledge.write('atlas', { ...note, title: `Later ${i}` });
    const revised = s.service.knowledge.write('atlas', { ...note, previousId: old.id, content: 'The corrected current constraint' });
    assert.equal(s.service.context('ember').knowledge[0]!.id, revised.id);
  } finally { s.close(); }
});

test('agents can follow catalog pagination beyond the first page without guessing keywords', async () => {
  const s = fixture();
  try {
    for (let i = 0; i < 25; i++) s.service.knowledge.write('atlas', { ...note, title: `Record ${i}` });
    for (let i = 0; i < 30; i++) s.service.knowledge.write('atlas', { ...note, title: `Private ${i}`, namespace: 'agent' });
    const first = await s.service.tool('ember', 'knowledge_search', { query: '', limit: 20 }) as { entries: { id: string }[]; nextOffset: number };
    const second = await s.service.tool('ember', 'knowledge_search', { query: '', limit: 20, offset: first.nextOffset }) as typeof first;
    assert.equal(second.entries.length, 5);
    assert.equal(new Set([...first.entries, ...second.entries].map(e => e.id)).size, 25);
    await assert.rejects(s.service.tool('ember', 'knowledge_search', { query: 'constraint', offset: 20 }), /empty catalog query/);
    for (const args of [{ offset: -1 }, { offset: 1.5 }, { limit: 21 }]) {
      await assert.rejects(s.service.tool('ember', 'knowledge_search', args));
    }
    assert.throws(() => s.service.knowledge.list({ kind: 'agent', id: 'ember' }, -1));
  } finally { s.close(); }
});

test('large legacy conflicts cannot make recent context grow without a bound', () => {
  const s = fixture();
  try {
    const entry = s.service.knowledge.write('atlas', note);
    const doc = s.service.knowledge.document(entry.documentId)!;
    const heads = Array.from({ length: 2000 }, (_, i) => `legacy-${i}`);
    s.store.transaction(() => {
      const revision = s.service.knowledge.revision(entry.id)!;
      for (const id of heads) s.service.knowledge.insertRevision({ ...revision, id, parentIds: [entry.id], source: { type: 'legacy' } });
      s.service.knowledge.saveDocument({ ...doc, currentRevisionId: undefined, status: 'conflicted', heads });
      s.service.knowledge.changed();
    });
    const packet = s.service.context('ember').knowledge;
    assert.ok(JSON.stringify(packet).length < 4000);
    const history = s.service.knowledge.history({ kind: 'agent', id: 'ember' }, { documentId: doc.id });
    assert.ok(JSON.stringify(history.document).length < 4000);
    assert.equal(history.document.headCount, 2000);
    assert.equal(history.revisions.length, 10);
    assert.ok(history.revisions.every(r => r.isHead));
    const recovered = [...history.document.heads];
    let next = history.nextHeadOffset;
    while (next !== null) {
      const page = s.service.knowledge.history({ kind: 'agent', id: 'ember' }, { documentId: doc.id, headOffset: next, limit: 1 });
      recovered.push(...page.document.heads); next = page.nextHeadOffset;
    }
    assert.deepEqual(recovered, heads, 'bounded history preserves access to every conflict head');
    assert.equal(s.service.knowledge.get({ kind: 'agent', id: 'ember' }, { revisionId: heads.at(-1) }).content, note.content);
  } finally { s.close(); }
});

test('artifact reads reject changed stored bytes instead of returning an obsolete evidence hash', async () => {
  const s = fixture();
  try {
    writeFileSync(join(s.service.workspace('atlas'), 'evidence.txt'), 'Original evidence');
    const artifact = await s.service.tool('atlas', 'artifact_publish', { title: 'Evidence', description: 'An immutable source', path: 'evidence.txt' }) as Artifact;
    const stored = s.store.require('artifacts', artifact.id);
    const path = join(s.dir, stored.path);
    const original = await s.service.tool('iris', 'artifact_read', { artifactId: artifact.id }) as { content: string };
    assert.equal(original.content, 'Original evidence');
    const inspections = s.store.events(0, 1000).filter(e => e.type === 'artifact.inspected').length;
    chmodSync(path, 0o600); writeFileSync(path, 'Tampered evidence'); // Same length: hash, not size, must reject it.
    await assert.rejects(s.service.tool('iris', 'artifact_read', { artifactId: artifact.id }), /integrity/i);
    assert.equal(s.store.events(0, 1000).filter(e => e.type === 'artifact.inspected').length, inspections);
  } finally { s.close(); }
});

test('missing, escaped, symlinked, nonregular and oversized artifact snapshots fail closed', async () => {
  const s = fixture();
  try {
    const content = Buffer.from([0, 255, 4]);
    writeFileSync(join(s.service.workspace('atlas'), 'data.bin'), content);
    const published = await s.service.tool('atlas', 'artifact_publish', { title: 'Binary', description: 'Binary evidence', path: 'data.bin' }) as Artifact;
    const artifact = s.store.require('artifacts', published.id);
    assert.deepEqual(readArtifactSnapshot(s.dir, artifact), content);
    for (const change of [{ size: artifact.size + 1 }, { size: MAX_ARTIFACT_BYTES + 1 }, { path: '../escape.bin' }, { path: 'artifacts/missing' }, { path: 'artifacts' }, { path: 'workspaces/atlas/data.bin' }]) {
      assert.throws(() => readArtifactSnapshot(s.dir, { ...artifact, ...change }), /integrity/i);
    }
    const path = join(s.dir, artifact.path);
    rmSync(path); symlinkSync(join(s.service.workspace('atlas'), 'data.bin'), path);
    await assert.rejects(s.service.tool('iris', 'artifact_read', { artifactId: artifact.id }), /integrity/i);
    rmSync(path); mkdirSync(path);
    assert.throws(() => readArtifactSnapshot(s.dir, artifact), /integrity/i);
    const directory = join(s.dir, 'artifacts');
    const relocated = join(s.dir, 'relocated-artifacts');
    renameSync(directory, relocated); symlinkSync(relocated, directory);
    assert.throws(() => readArtifactSnapshot(s.dir, artifact), /integrity/i);
  } finally { s.close(); }
});

test('corrupt artifacts cannot be submitted or accepted, and a rejected review remains possible', async () => {
  const s = fixture();
  try {
    const task = await s.service.tool('nova', 'task_create', { title: 'Evidence', description: 'Inspect evidence', acceptance: 'A useful output', ownerId: 'atlas' }) as Task;
    writeFileSync(join(s.service.workspace('atlas'), 'evidence.txt'), 'Original evidence');
    const published = await s.service.tool('atlas', 'artifact_publish', { title: 'Evidence', description: 'An immutable source', path: 'evidence.txt' }) as Artifact;
    const artifact = s.store.require('artifacts', published.id);
    const path = join(s.dir, artifact.path);
    const effects = () => JSON.stringify({ task: s.store.require('tasks', task.id), jobs: s.store.all('jobs'), agents: s.store.all('agents'), events: s.store.events(0, 1000), receipts: s.store.db.prepare('SELECT * FROM command_receipts').all() });
    chmodSync(path, 0o600); writeFileSync(path, 'Tampered evidence');
    let before = effects();
    const submit = { commandId: 'submit-evidence', taskId: task.id, evidenceIds: [artifact.id], note: 'Ready' };
    await assert.rejects(s.service.tool('atlas', 'task_submit', submit), /integrity/i);
    assert.equal(effects(), before);
    writeFileSync(path, 'Original evidence');
    await s.service.tool('atlas', 'task_submit', submit);
    writeFileSync(path, 'Tampered evidence');
    before = effects();
    await assert.rejects(s.service.tool('iris', 'task_review', { commandId: 'accept-evidence', taskId: task.id, accepted: true, note: 'Ready' }), /integrity/i);
    assert.equal(effects(), before);
    await s.service.tool('iris', 'task_review', { taskId: task.id, accepted: false, note: 'Stored evidence is corrupt; publish a fresh snapshot.' });
    assert.equal(s.store.require('tasks', task.id).status, 'todo');
  } finally { s.close(); }
});

test('operator artifact previews verify bytes and knowledge endpoints share pagination validation', async () => {
  const s = fixture();
  const config = s.service.config;
  const scheduler = new Scheduler(s.store, config, s.service, new SimulationHarness(s.service));
  const discord = new DiscordBridge(s.service, config, scheduler);
  const server = createHttpServer(s.service, scheduler, discord, config);
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    config.port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${config.port}`;
    const root = await fetch(base); await root.text();
    const cookie = root.headers.get('set-cookie')!.split(';')[0]!;
    const headers = { cookie };
    for (let i = 0; i < 25; i++) s.service.knowledge.write('atlas', { ...note, title: `Record ${i}` });
    const first = await (await fetch(`${base}/api/knowledge/search`, { headers })).json() as { nextOffset: number };
    const second = await (await fetch(`${base}/api/knowledge/search?offset=${first.nextOffset}`, { headers })).json() as { entries: unknown[] };
    assert.equal(second.entries.length, 5);
    assert.equal((await fetch(`${base}/api/knowledge/search?query=constraint&offset=20`, { headers })).status, 400);
    writeFileSync(join(s.service.workspace('atlas'), 'preview.html'), '<p>Original</p>');
    const published = await s.service.tool('atlas', 'artifact_publish', { title: 'Preview', description: 'Snapshot', path: 'preview.html' }) as Artifact;
    const url = `${base}/api/artifacts/${published.id}/content`;
    assert.equal(await (await fetch(url, { headers })).text(), '<p>Original</p>');
    const path = join(s.dir, s.store.require('artifacts', published.id).path);
    chmodSync(path, 0o600); writeFileSync(path, '<p>Tampered</p>');
    for (const suffix of ['', '?download']) {
      const response = await fetch(url + suffix, { headers });
      assert.equal(response.status, 400);
      assert.match(response.headers.get('content-type')!, /application\/json/);
      const body = await response.text(); assert.match(body, /integrity/i); assert.doesNotMatch(body, /<p>Tampered/);
    }
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    s.close();
  }
});
