import { randomBytes } from 'node:crypto';
import { Store, id, nowIso } from './store.js';
import { isOpen, localParts, nextOpen } from './schedule.js';
import type { Config } from './config.js';
import type { Harness, RunResult } from './claude.js';
import type { CollectiveService } from './service.js';
import type { Job, Run, RuntimeStatus } from './types.js';

export class Scheduler {
  readonly controllers = new Map<string, AbortController>();
  private tokens = new Map<string, { runId: string; expires: number }>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopping = false;
  private runtimeError?: string;
  status: RuntimeStatus;
  constructor(readonly store: Store, readonly config: Config, readonly service: CollectiveService, public harness: Harness) {
    this.status = { mode: config.mode, discord: config.discordToken && config.discordGuildId ? 'connecting' : 'unconfigured', claude: 'unknown', activeRuns: 0 };
  }
  grantRun(runId: string) { const token = randomBytes(32).toString('hex'); this.tokens.set(token, { runId, expires: Date.now() + (this.store.settings().maxRunSeconds + 60) * 1000 }); return token; }
  authenticateRun(token: string) {
    const entry = this.tokens.get(token);
    if (!entry || entry.expires < Date.now() || this.store.settings().paused) return undefined;
    const run = this.store.get('runs', entry.runId);
    const controller = run && this.controllers.get(run.id);
    if (!run || run.status !== 'running' || !controller || controller.signal.aborted) return undefined;
    const job = this.store.require('jobs', run.jobId);
    if (job.status !== 'running' || job.agentId !== run.agentId || job.attempts !== run.attempt || !this.store.isCurrentMission(job)) return undefined;
    return { run, job, agent: this.store.require('agents', run.agentId) };
  }
  blockReason(at = new Date()): string | undefined {
    const settings = this.store.settings();
    if (this.runtimeError) return this.runtimeError;
    if (settings.paused) return 'Paused by you';
    if (!this.service.activeMission()) return 'Set an active mission to begin';
    if (this.config.mode === 'simulation') return undefined;
    if (!isOpen(at, settings)) return 'Outside working hours';
    if (this.status.discord !== 'connected') return 'Connect Discord before starting live work';
    if (this.store.all('outbox').some(o => o.status === 'failed')) return 'Discord delivery failed; inspect Activity and retry delivery';
    if (this.status.claude === 'unauthenticated') return 'Sign into Claude Code locally, then check the installation in Settings';
    if (this.status.claude !== 'available') return 'Claude Code is not available';
    const quota = this.store.all('quotas').at(-1);
    if (!quota || at.getTime() - Date.parse(quota.observedAt) > settings.quotaMaxAgeMinutes * 60000) return 'Quota data is missing or stale; refresh usage in Settings';
    if (quota.fiveHourUsed === undefined || quota.weeklyUsed === undefined) return 'Both five-hour and weekly quota readings are required';
    if (quota.extraUsageEnabled !== false) return 'Confirm paid overage is disabled for subscription-only operation';
    if ((quota.fiveHourReset && Date.parse(quota.fiveHourReset) <= at.getTime()) || (quota.weeklyReset && Date.parse(quota.weeklyReset) <= at.getTime())) return 'A quota window reset; refresh usage before resuming';
    if (Math.max(quota.fiveHourUsed, quota.weeklyUsed) >= settings.quotaStopPercent) return 'Account usage reached your stop threshold';
    const day = localParts(at, settings.timezone).day;
    if (this.store.all('runs').filter(r => localParts(new Date(r.startedAt), settings.timezone).day === day).length >= settings.maxRunsPerDay) return 'Daily work-episode limit reached';
    return undefined;
  }
  snapshotStatus(at = new Date()): RuntimeStatus {
    return { ...this.status, activeRuns: this.controllers.size, blockReason: this.blockReason(at), nextOpen: this.config.mode === 'live' && !isOpen(at, this.store.settings()) ? nextOpen(at, this.store.settings()) : undefined };
  }
  start() {
    this.stopping = false;
    this.timer = setInterval(() => void this.tick().catch(error => this.halt(error)), 1000);
    this.timer.unref();
  }
  abortActive() { for (const controller of this.controllers.values()) controller.abort(); }
  pause() {
    this.store.transaction(() => {
      this.store.patch('settings', 'settings', { paused: true });
      this.store.event('collective.paused', 'operator', undefined);
    });
    this.abortActive();
  }
  resume() {
    if (this.runtimeError) throw new Error(this.runtimeError);
    this.store.transaction(() => {
      this.store.patch('settings', 'settings', { paused: false });
      this.store.event('collective.resumed', 'operator', undefined);
    });
    void this.tick().catch(error => this.halt(error));
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.abortActive();
    for (let i = 0; i < 80 && this.controllers.size; i++) await new Promise(r => setTimeout(r, 100));
  }
  async tick(at = new Date()) {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      const reason = this.blockReason(at);
      if (reason) {
        if (reason !== 'Daily work-episode limit reached') this.abortActive();
        return;
      }
      this.advanceMeetings(at);
      while (this.controllers.size < this.store.settings().maxConcurrent && !this.blockReason(at)) {
        const started = this.store.transaction(() => {
          const job = this.store.claimJob(at);
          if (!job) return undefined;
          const run = this.store.put('runs', {
            id: id('run'), agentId: job.agentId, jobId: job.id, attempt: job.attempts,
            status: 'running', inputTokens: 0, outputTokens: 0, estimatedCost: 0,
            turns: 0, startedAt: at.toISOString(),
          });
          this.store.patch('agents', job.agentId, { status: 'working' });
          this.store.event('agent.started', job.agentId, run.id, { kind: job.kind });
          return { job, run };
        });
        if (!started) break;
        this.launch(started.job, started.run);
      }
    } finally { this.ticking = false; }
  }
  private advanceMeetings(at: Date) {
    for (const snapshot of this.store.all('meetings')) this.store.transaction(() => {
      const meeting = this.store.require('meetings', snapshot.id);
      if (meeting.status === 'complete') return;
      if (!this.store.isCurrentMission(meeting)) {
        this.store.patch('meetings', meeting.id, { status: 'complete', outcome: 'Inactive or unknown mission; reschedule if still useful.' });
        this.store.event('meeting.cancelled', 'system', meeting.id);
        return;
      }
      if (meeting.status === 'scheduled' && Date.parse(meeting.startsAt) <= at.getTime()) {
        if (Date.parse(meeting.endsAt) <= at.getTime()) {
          this.store.patch('meetings', meeting.id, { status: 'complete', outcome: 'Missed while the collective was paused or offline; reschedule if still needed.' });
          this.store.event('meeting.missed', 'system', meeting.id);
          return;
        }
        if (this.store.all('runs').some(r => r.status === 'running' && meeting.participants.includes(r.agentId))) return;
        this.store.patch('meetings', meeting.id, { status: 'active' });
        for (const agentId of meeting.participants) {
          this.store.patch('agents', agentId, { roomId: meeting.roomId });
          this.store.enqueue(agentId, 'meeting', { meetingId: meeting.id }, `meeting:${meeting.id}:${agentId}`, nowIso(), meeting);
        }
        this.store.event('meeting.started', 'system', meeting.id);
      } else if (meeting.status === 'active' && Date.parse(meeting.endsAt) <= at.getTime()) {
        this.store.patch('meetings', meeting.id, { status: 'complete', outcome: meeting.outcome ?? 'Time limit reached. No outcome was recorded.' });
        this.store.event('meeting.ended', 'system', meeting.id);
      }
    });
  }
  private ownsAttempt(run: Run, job: Job): boolean {
    const currentRun = this.store.require('runs', run.id);
    const currentJob = this.store.require('jobs', job.id);
    return currentRun.status === 'running' && currentJob.status === 'running'
      && currentJob.attempts === run.attempt && currentRun.attempt === run.attempt;
  }
  private launch(job: Job, run: Run) {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return { summary: 'Paused before launch.', inputTokens: 0, outputTokens: 0, estimatedCost: 0, turns: 0, interrupted: true };
      return this.harness.execute(this.store.require('agents', job.agentId), job, run, controller.signal, event => {
        try { this.handleHarnessEvent(run.id, event); } catch (error) { this.halt(error); }
      });
    }).then(
      result => this.finish(run, job, { ...result, interrupted: result.interrupted || controller.signal.aborted }),
      error => this.fail(run, job, error),
    ).catch(error => this.halt(error)).finally(() => {
      this.controllers.delete(run.id);
      for (const [token, entry] of this.tokens) if (entry.runId === run.id) this.tokens.delete(token);
    });
  }
  private finish(run: Run, job: Job, result: RunResult) {
    this.store.transaction(() => {
      if (!this.ownsAttempt(run, job)) return;
      const current = this.store.isCurrentMission(job);
      const interrupted = result.interrupted || !current;
      this.store.patch('runs', run.id, { ...result, status: interrupted ? 'interrupted' : 'complete', endedAt: nowIso() });
      this.store.patch('agents', job.agentId, { status: 'idle', sessionId: result.sessionId ?? this.store.require('agents', job.agentId).sessionId });
      this.store.patch('jobs', job.id, { status: !current ? 'cancelled' : interrupted ? 'pending' : 'done', availableAt: new Date(Date.now() + 3000).toISOString() });
      if (!interrupted && job.kind !== 'message') {
        const task = this.store.all('tasks').find(t => t.missionId === job.missionId && t.ownerId === job.agentId && t.status === 'doing');
        if (task) this.store.enqueue(job.agentId, 'continue', { taskId: task.id }, `continue:${run.id}`, new Date(Date.now() + 3000).toISOString(), job);
      }
      this.store.event(interrupted ? 'run.interrupted' : 'run.completed', job.agentId, run.id, { summary: result.summary });
    });
  }
  private fail(run: Run, job: Job, error: unknown) {
    this.store.transaction(() => {
      if (!this.ownsAttempt(run, job)) return;
      const message = error instanceof Error ? error.message : String(error);
      const current = this.store.isCurrentMission(job);
      const retry = current && !/auth|login|permission|sandbox|quota|usage limit|rate.limit/i.test(message) && job.attempts < 3;
      this.store.patch('runs', run.id, { status: 'failed', error: message, endedAt: nowIso() });
      this.store.patch('jobs', job.id, { status: !current ? 'cancelled' : retry ? 'pending' : 'failed', error: message, availableAt: new Date(Date.now() + 15000 * job.attempts).toISOString() });
      this.store.patch('agents', job.agentId, { status: 'waiting' });
      this.store.event('run.failed', job.agentId, run.id, { error: message, retry });
    });
  }
  private halt(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.runtimeError = `Runtime persistence failed; restart the supervisor to recover: ${message}`;
    this.abortActive();
  }
  private handleHarnessEvent(runId: string, event: any) {
    const run = this.store.require('runs', runId);
    const job = this.store.require('jobs', run.jobId);
    if (!this.ownsAttempt(run, job) || !this.store.isCurrentMission(job) || this.controllers.get(runId)?.signal.aborted) return;
    this.store.transaction(() => {
    if (event.session_id) { this.store.patch('runs', runId, { sessionId: event.session_id }); this.store.patch('agents', run.agentId, { sessionId: event.session_id }); }
    if (event.type === 'system' && event.subtype === 'init') {
      const server = event.mcp_servers?.find((s: any) => s.name === 'collective');
      if (server && server.status !== 'connected' && server.status !== 'pending') this.store.event('integration.warning', run.agentId, runId, { message: 'Collective MCP tools did not connect.' });
    }
    if (event.type === 'rate_limit_event') {
      const info = event.rate_limit_info ?? event.rateLimitInfo;
      const raw = info?.utilization;
      const value = typeof raw === 'number' ? raw * 100 : undefined;
      const type = info?.rateLimitType ?? info?.rate_limit_type;
      if (value !== undefined && (type === 'five_hour' || type === 'seven_day')) {
        const previous = this.store.all('quotas').at(-1);
        // Never refresh the timestamp for the other window using a partial signal.
        if (previous && Date.now() - Date.parse(previous.observedAt) < 60000) this.store.put('quotas', { ...previous, id: id('quota'), source: 'provider', [type === 'five_hour' ? 'fiveHourUsed' : 'weeklyUsed']: value, observedAt: previous.observedAt });
      }
      if (info?.status === 'rejected') this.controllers.get(runId)?.abort();
    }
    // Do not broadcast raw prompts, private reasoning, or tool inputs into Discord/UI.
    if (event.type === 'assistant') for (const block of event.message?.content ?? []) if (block.type === 'tool_use') this.store.event('agent.tool', run.agentId, runId, { tool: block.name });
    });
  }
}
