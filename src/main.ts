import { mkdirSync, openSync, closeSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { seed } from './seed.js';
import { CollectiveService } from './service.js';
import { Scheduler } from './scheduler.js';
import { ClaudeHarness, checkClaude, type Harness } from './claude.js';
import { SimulationHarness } from './simulation.js';
import { DiscordBridge } from './discord.js';
import { createHttpServer } from './http.js';
import { QuotaMonitor } from './quota.js';
import { backupBeforeMigration } from './storage/backup.js';
import { readRegisteredSnapshot, importRegisteredSnapshot } from './knowledge/import.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const lock = resolve(config.dataDir, 'supervisor.lock');
try {
  const pid = Number(readFileSync(lock, 'utf8')); let alive = false;
  if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') alive = true; } }
  if (alive) throw new Error(`Collective is already running with PID ${pid}.`);
  unlinkSync(lock);
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
let store: Store;
try {
  const databasePath = resolve(config.dataDir, 'collective.sqlite');
  const backup = await backupBeforeMigration(databasePath);
  if (backup) console.log(`Saved pre-migration database backup: ${backup}`);
  store = new Store(databasePath); seed(store); store.recover();
} catch (error) { try { unlinkSync(lock); } catch {} throw error; }
const service = new CollectiveService(store, config);
try {
  const imported = importRegisteredSnapshot(service.knowledge, readRegisteredSnapshot(config.root));
  console.log(`Registered knowledge from ${imported.commit.slice(0, 12)}: ${imported.created} revisions, ${imported.unchanged} unchanged, ${imported.withdrawn} withdrawn.`);
} catch (error) { service.knowledge.close(); store.close(); try { unlinkSync(lock); } catch {} throw error; }
const scheduler = new Scheduler(store, config, service, null as unknown as Harness);
scheduler.harness = config.mode === 'simulation' ? new SimulationHarness(service) : new ClaudeHarness(service, config, runId => scheduler.grantRun(runId));
const discord = new DiscordBridge(service, config, scheduler);
const quota = new QuotaMonitor(store, config);
const server = createHttpServer(service, scheduler, discord, config, quota);
server.on('error', error => { console.error(error.message); try { unlinkSync(lock); } catch {} process.exitCode = 1; });
server.listen(config.port, '127.0.0.1', () => {
  console.log(`Collective is ready at http://127.0.0.1:${config.port} (${config.mode})`);
  console.log(config.mode === 'simulation' ? 'Rehearsal mode: no model calls or external actions. Press Run in the app.' : 'Live setup: Claude launches are disabled pending whole-worker isolation verification. See docs/ISOLATION-REHEARSAL.md.');
  scheduler.start(); quota.start(); void discord.connect();
  void checkClaude(config.claudeBin).then(result => { if (!closing) { scheduler.status.claude = result.available ? result.subscriptionLogin ? 'available' : 'unauthenticated' : 'missing'; store.event('claude.checked', 'system', undefined, result); } });
});
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  await Promise.all([quota.stop(), scheduler.stop()]); await discord.stop(); server.closeAllConnections(); server.close(); service.knowledge.close(); store.close();
  try { unlinkSync(lock); } catch {} process.exit(0);
}
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
