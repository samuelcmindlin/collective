import type { DatabaseSync } from 'node:sqlite';
import type { Job, Mission, Task } from '../types.js';
import { knowledgeSchema, migrateLegacyKnowledge } from './knowledge-migration.js';
import { progressSchema } from './progress-migration.js';

export const schemaVersion = 4;

const migrations = [
  `CREATE TABLE IF NOT EXISTS entities (collection TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(collection,id));
   CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,actor_id TEXT NOT NULL,entity_id TEXT,data TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS job_dedupe ON entities(json_extract(data,'$.dedupeKey')) WHERE collection='jobs';
   CREATE UNIQUE INDEX IF NOT EXISTS message_discord ON entities(json_extract(data,'$.discordId')) WHERE collection='messages' AND json_extract(data,'$.discordId') IS NOT NULL;
   CREATE UNIQUE INDEX IF NOT EXISTS outbox_entity ON entities(json_extract(data,'$.kind'),json_extract(data,'$.entityId')) WHERE collection='outbox';
   CREATE INDEX IF NOT EXISTS jobs_status ON entities(collection,json_extract(data,'$.status'));`,
  `CREATE TABLE command_receipts (
     principal_id TEXT NOT NULL,
     command_id TEXT NOT NULL,
     command_name TEXT NOT NULL,
     mission_id TEXT NOT NULL,
     payload_hash TEXT NOT NULL,
     result_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (principal_id, command_id)
   );
   CREATE INDEX command_receipts_mission ON command_receipts(mission_id, principal_id, created_at);`,
  knowledgeSchema,
  progressSchema,
];

export function migrate(db: DatabaseSync) {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (current > schemaVersion) throw new Error(`Database schema ${current} is newer than supported schema ${schemaVersion}.`);
  if (current === schemaVersion) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = current; index < schemaVersion; index++) {
      db.exec(migrations[index]!);
      if (index === 2) migrateLegacyKnowledge(db);
    }
    // Unscoped legacy work is retained. Only work whose mission can be established
    // from an existing task or mission payload is adopted; no date-based guesses.
    if (current === 1) {
      backfillJobScopes(db);
      db.exec("UPDATE entities SET data=json_set(data,'$.paused',json('true')) WHERE collection='settings' AND id='settings';");
    }
    db.exec(`PRAGMA user_version=${schemaVersion}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function backfillJobScopes(db: DatabaseSync) {
  const read = <T>(collection: string, id: unknown): T | undefined => {
    if (typeof id !== 'string') return undefined;
    const row = db.prepare('SELECT data FROM entities WHERE collection=? AND id=?').get(collection, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  };
  const rows = db.prepare("SELECT id,data FROM entities WHERE collection='jobs'").all() as { id: string; data: string }[];
  for (const row of rows) {
    const job = JSON.parse(row.data) as Job;
    const task = read<Task>('tasks', job.payload?.taskId);
    const mission = read<Mission>('missions', job.payload?.missionId ?? task?.missionId);
    if (mission && (!job.payload?.revision || job.payload.revision === mission.revision)) {
      job.missionId = mission.id;
      job.missionRevision = mission.revision;
    } else if (['pending', 'failed', 'running'].includes(job.status)) {
      job.status = 'cancelled';
      job.error = 'Legacy job has no verified mission scope; recreate useful work under the current mission.';
    }
    db.prepare("UPDATE entities SET data=? WHERE collection='jobs' AND id=?").run(JSON.stringify(job), row.id);
  }
}
