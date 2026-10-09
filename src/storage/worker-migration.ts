export const workerSchema = `
CREATE TABLE worker_intents (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('planned','provisioning','ready','stopping','unknown','removed')),
  data TEXT NOT NULL
);
CREATE UNIQUE INDEX worker_active_agent ON worker_intents(agent_id) WHERE phase!='removed';
CREATE INDEX worker_unresolved ON worker_intents(phase) WHERE phase!='removed';
`;
