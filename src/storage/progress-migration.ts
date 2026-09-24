export const progressTables = ['progress_criteria', 'progress_submissions', 'progress_inspections', 'progress_evaluations', 'progress_legacy_tasks'] as const;
export const progressSchema = `
CREATE TABLE progress_criteria(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
CREATE TABLE progress_submissions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX progress_submissions_task ON progress_submissions(task_id);
CREATE TABLE progress_inspections(id TEXT PRIMARY KEY,submission_id TEXT NOT NULL,principal_id TEXT NOT NULL,evidence_id TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX progress_inspections_lookup ON progress_inspections(submission_id,principal_id,evidence_id);
CREATE TABLE progress_evaluations(id TEXT PRIMARY KEY,submission_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
CREATE TABLE progress_legacy_tasks(id TEXT PRIMARY KEY,data TEXT NOT NULL);
INSERT INTO progress_legacy_tasks SELECT id,data FROM entities WHERE collection='tasks';
${progressTables.map(table => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Progress records are immutable'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Progress records are immutable'); END;`).join('\n')}
UPDATE entities SET data=json_set(data,'$.paused',json('true')) WHERE collection='settings' AND id='settings';
`;
