import { createHash } from 'node:crypto';
import type { Store } from '../store.js';
import { nowIso } from '../store.js';

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function executeCommand<T>(
  store: Store,
  identity: { principalId: string; commandId: string; name: string; missionId: string },
  payload: unknown,
  apply: () => T,
): T {
  // Caller owns the transaction and checks current authority before receipt lookup.
  if (!store.inTransaction) throw new Error('Commands require an application transaction.');
  const payloadHash = createHash('sha256').update(stable(payload)).digest('hex');
  const previous = store.db.prepare('SELECT * FROM command_receipts WHERE principal_id=? AND command_id=?')
    .get(identity.principalId, identity.commandId) as {
      command_name: string; mission_id: string; payload_hash: string; result_json: string;
    } | undefined;
  if (previous) {
    if (previous.command_name !== identity.name || previous.mission_id !== identity.missionId || previous.payload_hash !== payloadHash) {
      throw new Error('Command ID conflict: reuse an ID only for the same command and payload.');
    }
    return JSON.parse(previous.result_json) as T;
  }
  const result = apply();
  store.db.prepare(`INSERT INTO command_receipts
    (principal_id,command_id,command_name,mission_id,payload_hash,result_json,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(identity.principalId, identity.commandId, identity.name, identity.missionId, payloadHash, JSON.stringify(result), nowIso());
  return result;
}
