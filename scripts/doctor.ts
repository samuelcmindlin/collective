import { loadConfig } from '../src/config.js';
import { checkClaude } from '../src/claude.js';
const config = loadConfig();
const claude = await checkClaude(config.claudeBin);
console.log(JSON.stringify({ node: process.version, claude, workerIsolation: { verified: false, liveLaunchEnabled: false, reason: 'Whole-worker isolation and subscription/MCP compatibility are not yet verified. See docs/ISOLATION-REHEARSAL.md.' }, discord: { tokenConfigured: !!config.discordToken, guildConfigured: !!config.discordGuildId, operatorCount: config.operatorIds.length }, githubConfigured: !!(config.githubToken && config.githubOwner), mode: config.mode, dataDir: config.dataDir, note: 'This check makes no model calls and reveals no credentials.' }, null, 2));
