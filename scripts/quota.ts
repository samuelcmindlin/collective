import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { seed } from '../src/seed.js';
import { QuotaMonitor } from '../src/quota.js';
const config = loadConfig(); const store = new Store(':memory:'); seed(store);
const monitor = new QuotaMonitor(store, config);
try { console.log(JSON.stringify(await monitor.refresh(), null, 2)); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); console.error(JSON.stringify(store.events(0, 1)[0]?.data)); process.exitCode = 1; }
finally { await monitor.stop(); store.close(); }
