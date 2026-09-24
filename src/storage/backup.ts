import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { schemaVersion } from './migrations.js';

/** Copy committed SQLite state, including WAL, before a startup migration. */
export async function backupBeforeMigration(databasePath: string): Promise<string | undefined> {
  if (!existsSync(databasePath)) return undefined;
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = Number((source.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version >= schemaVersion) return undefined;
    const directory = join(dirname(databasePath), 'backups');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = join(directory, `${basename(databasePath)}.v${version}.${randomUUID()}.backup`);
    await backup(source, destination);
    chmodSync(destination, 0o600);
    return destination;
  } finally { source.close(); }
}
