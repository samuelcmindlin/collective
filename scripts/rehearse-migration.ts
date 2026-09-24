import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

function snapshot(db: DatabaseSync) {
  return {
    version: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    entities: db.prepare('SELECT collection,id,data FROM entities ORDER BY collection,id').all() as { collection: string; id: string; data: string }[],
    events: db.prepare('SELECT * FROM events ORDER BY id').all(),
    receipts: db.prepare("SELECT name FROM sqlite_master WHERE name='command_receipts'").get()
      ? db.prepare('SELECT * FROM command_receipts ORDER BY principal_id,command_id').all() : [],
    knowledge: ['knowledge_documents', 'knowledge_revisions', 'knowledge_generation'].map(table => ({ table,
      rows: db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table) ? db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() : [] })),
  };
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Sources are read-only. Every migration/recovery/restore runs on an isolated copy.
const sources = process.argv.slice(2);
if (!sources.length) throw new Error('Provide a database path to rehearse on a copy. The original is never migrated.');
for (const sourcePath of sources) {
  const file = resolve(sourcePath);
  if (!existsSync(file)) throw new Error(`Database does not exist: ${file}`);
  const directory = mkdtempSync(join(tmpdir(), 'collective-migration-rehearsal-'));
  const frozen = join(directory, 'before.sqlite');
  const candidate = join(directory, 'candidate.sqlite');
  const restored = join(directory, 'restored.sqlite');
  try {
    const source = new DatabaseSync(file, { readOnly: true });
    try { await backup(source, frozen); } finally { source.close(); }
    const baseline = new DatabaseSync(frozen, { readOnly: true });
    try {
      const before = snapshot(baseline);
      await backup(baseline, candidate);
      const migrated = new Store(candidate);
      let after: ReturnType<typeof snapshot>;
      let recoveryJobs: number;
      try {
        after = snapshot(migrated.db);
        const unchanged = (rows: typeof before.entities) => rows.filter(row => !['jobs', 'settings'].includes(row.collection));
        assert.deepEqual(unchanged(after.entities), unchanged(before.entities), 'non-runtime entities retain their exact content');
        assert.deepEqual(after.events, before.events, 'historical events are preserved');
        assert.deepEqual(after.receipts, before.receipts, 'command receipts are preserved');
        assert.equal(after.entities.length, before.entities.length, 'no entity was removed');
        assert.equal((migrated.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
        for (const row of before.entities.filter(row => row.collection === 'knowledge')) {
          const legacy = JSON.parse(row.data);
          const revision = migrated.db.prepare('SELECT data FROM knowledge_revisions WHERE id=?').get(row.id) as { data: string } | undefined;
          assert.ok(revision, 'legacy evidence ID resolves');
          const current = JSON.parse(revision.data);
          assert.equal(current.content, legacy.content);
          assert.equal(current.sha256, createHash('sha256').update(legacy.content).digest('hex'));
        }
        migrated.recover();
        recoveryJobs = migrated.all('jobs').filter(job => job.status === 'pending').length;
      } finally { migrated.close(); }
      await backup(baseline, restored);
      const restoredDb = new DatabaseSync(restored, { readOnly: true });
      try { assert.equal(digest(snapshot(restoredDb)), digest(before), 'restoring the original schema and state is exact'); }
      finally { restoredDb.close(); }
      console.log(JSON.stringify({ source: sourcePath, fromVersion: before.version, toVersion: after.version,
        entitiesPreserved: before.entities.length, eventsPreserved: before.events.length,
        pendingJobsAfterRecovery: recoveryJobs, integrity: 'ok', restore: 'exact', originalModified: false }));
    } finally { baseline.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
