import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v3';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './config.js';
import { workerEnvironment } from './claude.js';
import { Store, id, nowIso } from './store.js';
import { isOpen } from './schedule.js';

const windowSchema = z.object({ utilization: z.number().min(0).max(100), resets_at: z.string().datetime().nullable() });
export function parseQuotaReport(input: unknown) {
  if (input && typeof input === 'object' && 'rate_limits_available' in input && input.rate_limits_available === true && 'rate_limits' in input && input.rate_limits === null) throw new Error('Claude recognizes the subscription, but its usage endpoint returned no quota snapshot.');
  const report = z.object({ rate_limits_available: z.literal(true), rate_limits: z.object({ five_hour: windowSchema, seven_day: windowSchema, extra_usage: z.object({ is_enabled: z.boolean() }).nullable().optional() }) }).parse(input);
  return { fiveHourUsed: report.rate_limits.five_hour.utilization, weeklyUsed: report.rate_limits.seven_day.utilization, fiveHourReset: report.rate_limits.five_hour.resets_at ?? undefined, weeklyReset: report.rate_limits.seven_day.resets_at ?? undefined, extraUsageEnabled: report.rate_limits.extra_usage?.is_enabled };
}

/** Optional, pinned experimental integration. Failure never becomes zero quota. */
export class QuotaMonitor {
  private timer?: NodeJS.Timeout;
  private pending?: Promise<unknown>;
  constructor(private store: Store, private config: Config) {}
  start() {
    if (this.config.mode === 'simulation') return;
    this.timer = setInterval(() => { if (!this.store.settings().paused && isOpen(new Date(), this.store.settings())) void this.refresh().catch(() => {}); }, 60000);
    this.timer.unref();
  }
  refresh(): Promise<unknown> {
    if (this.config.mode !== 'live') return Promise.reject(new Error('Simulation does not query your provider account.'));
    if (this.pending) return this.pending;
    this.pending = this.read().finally(() => { this.pending = undefined; }); return this.pending;
  }
  private async read() {
    const cwd = resolve(this.config.dataDir, 'control', 'quota'); mkdirSync(cwd, { recursive: true, mode: 0o700 });
    let release!: () => void;
    const ready = new Promise<void>(r => { release = r; });
    async function* noPrompts(): AsyncGenerator<never> { await ready; }
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 20000);
    const session = query({ prompt: noPrompts(), options: { cwd, pathToClaudeCodeExecutable: this.config.claudeBin, env: workerEnvironment(), tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], permissionMode: 'dontAsk', persistSession: false, abortController: controller, extraArgs: { restricted: null, 'permission-prompts': 'none' }, settings: { disableAllHooks: true } } });
    try {
      // This control request reads usage; no user prompt is yielded and no model run is requested.
      const raw = await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      const report = parseQuotaReport(raw);
      const row = this.store.put('quotas', { id: id('quota'), ...report, observedAt: nowIso(), source: 'provider' });
      this.store.event('quota.updated', 'system', row.id, { source: 'provider' }); return row;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.event('quota.unavailable', 'system', undefined, { message: message.slice(0, 300) });
      throw new Error('Provider quota is unavailable. Check Claude’s usage page and record a current reading manually; unattended work stays blocked without fresh readings.');
    } finally { clearTimeout(timeout); release(); session.close(); }
  }
  async stop() { if (this.timer) clearInterval(this.timer); await this.pending?.catch(() => {}); }
}
