import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

// Frozen local source commit, synthetic notes and labels are identical for both engines.
const commit = 'dfd605b';
const git = path => execFileSync('git', ['show', `${commit}:${path}`], { encoding: 'utf8' });
const catalog = JSON.parse(git('docs/catalog.json'));
const docs = catalog.documents.map(d => ({ id: d.id, title: d.id, body: git(d.path) }));
docs.push(
  { id: 'constraint', title: 'Orbit launch constraint', body: 'Orbit must work offline without external fonts or a network connection.' },
  { id: 'reset', title: 'Orbit reset decision', body: 'Restart clears pending timers, moves and revealed cards before starting a new round.' },
  { id: 'conflict', title: 'Disputed hypothesis', body: 'Hypothesis only: timed rounds might improve replay. This claim is disputed and untested.' },
);
for (let i = 0; i < 1000; i++) docs.push({ id: `noise-${i}`, title: `Daily observation ${i}`, body: `Routine progress note ${i}: the team discussed colors and icons for the office.` });
const labels = [
  ['offline network', ['constraint']], ['pending timers', ['reset']], ['disputed hypothesis', ['conflict']],
  ['rollback', ['platform.foundation-implementation']], ['quota', ['operator.setup', 'platform.plan']],
  ['immutable revision', ['platform.knowledge', 'platform.design-knowledge']],
  ['protected ownership', ['platform.knowledge', 'platform.design-knowledge']],
  ['independent review', ['platform.design-progress', 'platform.prototype-decisions']],
  ['Discord', ['operator.setup']], ['private draft', ['platform.plan', 'platform.design-workspaces-prs']],
  ['works without internet', ['constraint']], ['clear delayed callbacks', ['reset']],
  ['zxqv nonexistent aeroponics', []],
];
const dir = mkdtempSync(join(tmpdir(), 'collective-retrieval-'));
const data = join(dir, 'approved'); mkdirSync(data);
for (const d of docs) writeFileSync(join(data, `${d.id}.md`), `# ${d.title}\n\n${d.body}`);
const db = new DatabaseSync(':memory:');
let qmd;
try {
  const metrics = {};
  let start = performance.now();
  db.exec('CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED,title,body,tokenize="unicode61"); BEGIN;');
  for (const d of docs) db.prepare('INSERT INTO search VALUES(?,?,?)').run(d.id, d.title, d.body);
  db.exec('COMMIT');
  const ftsIndexMs = performance.now() - start;
  const tokenize = q => (q.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 24).map(w => `"${w}"`).join(' AND ');
  const engines = [{ name: 'sqlite-fts5', indexMs: ftsIndexMs, search: q => db.prepare('SELECT id FROM search WHERE search MATCH ? ORDER BY bm25(search),id LIMIT 5').all(tokenize(q)).map(r => r.id) }];
  if (process.argv[2]) {
    const { createStore } = await import(pathToFileURL(process.argv[2]).href);
    start = performance.now();
    qmd = await createStore({ dbPath: join(dir, 'qmd.sqlite'), config: { collections: { approved: { path: data, pattern: '*.md' } } } });
    await qmd.update();
    engines.push({ name: 'qmd-2.8.3-lexical', indexMs: performance.now() - start, search: async q => (await qmd.searchLex(q, { limit: 5, collection: 'approved' })).map(r => r.filepath.split('/').at(-1).replace(/\.md$/, '')) });
  }
  for (const engine of engines) {
    const queries = [];
    for (const [query, relevant] of labels) {
      start = performance.now(); const hits = await engine.search(query); const latencyMs = performance.now() - start;
      const first = hits.findIndex(id => relevant.includes(id));
      queries.push({ query, relevant, hits, recallAt5: relevant.length ? relevant.filter(id => hits.includes(id)).length / relevant.length : null, reciprocalRank: relevant.length ? first < 0 ? 0 : 1 / (first + 1) : null, latencyMs });
    }
    const answered = queries.filter(q => q.relevant.length);
    metrics[engine.name] = { indexMs: engine.indexMs, meanRecallAt5: answered.reduce((sum, q) => sum + q.recallAt5, 0) / answered.length, meanReciprocalRank: answered.reduce((sum, q) => sum + q.reciprocalRank, 0) / answered.length, queries };
  }
  console.log(JSON.stringify({ sourceCommit: execFileSync('git', ['rev-parse', commit], { encoding: 'utf8' }).trim(), fixtureHash: createHash('sha256').update(JSON.stringify({ docs, labels })).digest('hex'), documents: docs.length, node: process.version, sqlite: db.prepare('SELECT sqlite_version() AS version').get().version, platform: `${platform()}-${arch()}`, modelCalls: 0, retrievalNetworkCalls: 'No network APIs invoked by this script; packet traffic not instrumented', note: 'Lexical screening only. Access/citations/update/handoff gates belong to the integration suite. No semantic accuracy or production latency claim.', metrics }, null, 2));
} finally { await qmd?.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
