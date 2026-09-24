import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Mode } from './types.js';

export interface Config { root: string; dataDir: string; port: number; mode: Mode; claudeBin: string; discordToken?: string; discordGuildId?: string; operatorIds: string[]; githubToken?: string; githubOwner?: string; }
export function loadConfig(root = process.cwd()): Config {
  // Deliberately small dotenv parser. Values remain on the server, never in snapshots.
  const env = { ...process.env };
  const path = resolve(root, '.env');
  if (existsSync(path)) for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !env[match[1]!]) env[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  const port = Number(env.COLLECTIVE_PORT || 4310);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('COLLECTIVE_PORT must be between 1024 and 65535');
  return { root, dataDir: resolve(root, env.COLLECTIVE_DATA_DIR || '.collective'), port, mode: env.COLLECTIVE_MODE === 'simulation' ? 'simulation' : 'live', claudeBin: env.CLAUDE_BIN || 'claude', discordToken: env.DISCORD_BOT_TOKEN || undefined, discordGuildId: env.DISCORD_GUILD_ID || undefined, operatorIds: (env.DISCORD_OPERATOR_IDS || '').split(',').map(s => s.trim()).filter(Boolean), githubToken: env.GITHUB_TOKEN || undefined, githubOwner: env.GITHUB_OWNER || undefined };
}
