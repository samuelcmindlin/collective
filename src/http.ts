import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { z } from 'zod/v3';
import type { Config } from './config.js';
import type { CollectiveService, ToolName } from './service.js';
import { toolSchemas } from './service.js';
import { isTaskTool } from './application/tasks.js';
import { isKnowledgeWrite } from './knowledge/repository.js';
import { readArtifactSnapshot } from './storage/artifacts.js';
import type { Scheduler } from './scheduler.js';
import type { DiscordBridge } from './discord.js';
import { id, nowIso } from './store.js';
import { checkClaude } from './claude.js';
import type { QuotaMonitor } from './quota.js';

const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function validHost(host: string | undefined, port: number) { return host === `127.0.0.1:${port}` || host === `localhost:${port}`; }
export function validOrigin(origin: string | undefined, port: number) { return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`; }
async function body(req: IncomingMessage): Promise<unknown> {
  let buffer = ''; for await (const chunk of req) { buffer += chunk.toString(); if (Buffer.byteLength(buffer) > 100000) throw new Error('Request body is too large.'); }
  return buffer ? JSON.parse(buffer) : {};
}
function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
const settingsSchema = z.object({ timezone: z.string().refine(t => { try { new Intl.DateTimeFormat('en', { timeZone: t }); return true; } catch { return false; } }), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7), startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(1).max(24), maxConcurrent: z.number().int().min(1).max(4), maxTurnsPerRun: z.number().int().min(1).max(30), maxRunsPerDay: z.number().int().min(1).max(500), maxRunSeconds: z.number().int().min(30).max(1800), quotaStopPercent: z.number().min(1).max(95), quotaMaxAgeMinutes: z.number().int().min(1).max(60), model: z.enum(['sonnet', 'opus', 'haiku']), theme: z.enum(['office', 'ship', 'castle']), maxAgents: z.number().int().min(2).max(12), maxConversationDepth: z.number().int().min(0).max(5) }).partial().strict();

export function createHttpServer(service: CollectiveService, scheduler: Scheduler, discord: DiscordBridge, config: Config, quotaMonitor?: QuotaMonitor) {
  const operatorToken = randomBytes(32).toString('hex');
  const cookieName = `collective_operator_${config.port}=`;
  const sse = new Set<ServerResponse>();
  const onEvent = () => { for (const res of sse) res.write('event: change\ndata: {}\n\n'); };
  service.store.changes.on('event', onEvent);
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (!validHost(req.headers.host, config.port)) return json(res, 403, { error: 'Invalid host.' });
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${config.port}`);
      if (url.pathname === '/health') return json(res, 200, { ok: true, mode: config.mode });
      if (url.pathname === '/agent/tools') {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST required.' });
        const runToken = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
        let auth = scheduler.authenticateRun(runToken);
        if (!auth) return json(res, 401, { error: 'Run token is missing, expired, or inactive.' });
        const input = z.object({ name: z.string(), arguments: z.unknown(), commandId: z.string().trim().min(1).max(128).optional() }).parse(await body(req));
        auth = scheduler.authenticateRun(runToken);
        if (!auth) return json(res, 401, { error: 'Run ended or was paused while receiving the request.' });
        if (!Object.hasOwn(toolSchemas, input.name)) return json(res, 400, { error: 'Unknown collective tool.' });
        if ((isTaskTool(input.name) || isKnowledgeWrite(input.name)) && !input.commandId && !(input.arguments && typeof input.arguments === 'object' && 'commandId' in input.arguments && input.arguments.commandId)) {
          return json(res, 400, { error: 'Task and knowledge commands require a stable commandId.' });
        }
        const result = await service.tool(auth.agent.id, input.name as ToolName, input.arguments, auth.job, input.commandId);
        return json(res, 200, result);
      }
      const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(cookieName))?.slice(cookieName.length) ?? '';
      if (url.pathname.startsWith('/api/')) {
        if (!equal(cookie, operatorToken) || !validOrigin(req.headers.origin, config.port) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Open the local Collective app to access this endpoint.' });
        if (req.method !== 'GET' && req.headers['x-collective-local'] !== '1') return json(res, 403, { error: 'Local operator header required.' });
        if (url.pathname === '/api/tasks/get' && req.method === 'GET') return json(res, 200, service.progress.get({ taskId: url.searchParams.get('taskId'), submissionId: url.searchParams.get('submissionId') ?? undefined, offset: Number(url.searchParams.get('offset') ?? 0) }));
        if (url.pathname === '/api/knowledge/search' && req.method === 'GET') {
          const query = url.searchParams.get('query') ?? '';
          const offset = z.coerce.number().int().min(0).max(100000).parse(url.searchParams.get('offset') ?? 0);
          return json(res, 200, service.knowledge.search({ kind: 'operator' }, { query, limit: 20, offset }));
        }
        if (url.pathname === '/api/knowledge/get' && req.method === 'GET') return json(res, 200, service.knowledge.get({ kind: 'operator' }, Object.fromEntries(url.searchParams)));
        if (url.pathname === '/api/knowledge/history' && req.method === 'GET') return json(res, 200, service.knowledge.history({ kind: 'operator' }, { documentId: url.searchParams.get('documentId'), offset: Number(url.searchParams.get('offset') ?? 0), headOffset: Number(url.searchParams.get('headOffset') ?? 0), limit: 20 }));
        if (url.pathname === '/api/state' && req.method === 'GET') {
          const store = service.store;
          return json(res, 200, { mode: config.mode, status: scheduler.snapshotStatus(), settings: store.settings(), agents: store.all('agents'), rooms: store.all('rooms'), missions: store.all('missions'), tasks: store.all('tasks'), messages: store.all('messages').slice(-200), knowledge: service.knowledge.list({ kind: 'operator' }, 20).entries, artifacts: store.all('artifacts').map(({ path: _path, ...a }) => a), meetings: store.all('meetings'), requests: store.all('requests'), runs: store.all('runs').slice(-100), jobs: store.all('jobs').filter(j => j.status !== 'done').slice(-100), events: store.events(0, 60), quota: store.all('quotas').at(-1) ?? null, connections: { discordConfigured: !!(config.discordToken && config.discordGuildId), guildId: config.discordGuildId, operatorsConfigured: config.operatorIds.length > 0, githubConfigured: !!(config.githubToken && config.githubOwner), githubOwner: config.githubOwner } });
        }
        if (url.pathname === '/api/events' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.write(': connected\n\n'); sse.add(res); req.on('close', () => sse.delete(res)); return; }
        const artifactMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/content$/);
        if (artifactMatch && req.method === 'GET') {
          const artifact = service.store.require('artifacts', artifactMatch[1]!);
          const bytes = readArtifactSnapshot(config.dataDir, artifact);
          res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
          res.setHeader('Content-Type', `${artifact.mime}; charset=utf-8`); res.setHeader('Cache-Control', 'no-store');
          if (url.searchParams.has('download')) res.setHeader('Content-Disposition', `attachment; filename="${artifact.id}${extname(artifact.path)}"`);
          res.end(bytes); return;
        }
        if (req.method !== 'POST') return json(res, 404, { error: 'Unknown endpoint.' });
        const input = await body(req);
        if (url.pathname === '/api/control') {
          const { action } = z.object({ action: z.enum(['pause', 'resume', 'retry-failed']) }).parse(input);
          if (action === 'pause') scheduler.pause();
          else if (action === 'resume') {
            const mission = service.store.all('missions').at(-1);
            if (!service.activeMission() && mission?.status === 'complete') throw new Error('This mission is complete. Set a new direction before starting more work.');
            if (!service.activeMission() && mission) service.setMission(mission.title, mission.brief, mission.criteria, 'operator');
            scheduler.resume();
          } else {
            service.store.transaction(() => {
            for (const job of service.store.all('jobs').filter(j => j.status === 'failed' && service.store.isCurrentMission(j))) service.store.patch('jobs', job.id, { status: 'pending', availableAt: nowIso(), error: undefined });
            for (const out of service.store.all('outbox').filter(o => o.status === 'failed')) service.store.patch('outbox', out.id, { status: 'pending', attempts: 1, nextAttemptAt: nowIso(), error: undefined });
            service.store.event('work.retried', 'operator', undefined);
            });
          }
          return json(res, 200, scheduler.snapshotStatus());
        }
        if (url.pathname === '/api/mission') { const m = z.object({ title: z.string().trim().min(1).max(200), brief: z.string().trim().min(1).max(10000), criteria: z.array(z.string().trim().min(1).max(500)).max(12) }).parse(input); return json(res, 200, service.setMission(m.title, m.brief, m.criteria, 'operator')); }
        if (url.pathname === '/api/feedback') {
          const { content } = z.object({ content: z.string().trim().min(1).max(4000) }).parse(input);
          service.store.transaction(() => {
            const mission = service.activeMission(); if (!mission) throw new Error('No active mission.');
            const event = service.store.event('user.feedback', 'operator', mission.id, { content });
            service.store.enqueue('nova', 'feedback', { content, operatorFeedback: true }, `feedback:${event.id}`);
          });
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/message') {
          const { roomId, content, recipients } = z.object({ roomId: z.string(), content: z.string().trim().min(1).max(1800), recipients: z.array(z.string()).default([]) }).parse(input);
          service.store.require('rooms', roomId);
          for (const recipient of recipients) if (service.store.require('agents', recipient).roomId !== roomId) throw new Error('Addressed agent is not in this room.');
          const message = service.store.transaction(() => {
            const row = service.store.put('messages', { ...service.store.missionScope(), id: id('msg'), roomId, authorId: 'operator', authorName: 'You', content, recipients, depth: 0, delivery: 'pending', createdAt: nowIso() });
            service.outbox('message', row.id, roomId); service.store.event('message.queued', 'operator', row.id, { roomId }); return row;
          });
          return json(res, 200, message);
        }
        if (url.pathname === '/api/request/decision') { const r = z.object({ requestId: z.string(), decision: z.enum(['approved', 'denied', 'revoked']), note: z.string().max(4000).default(''), expiresAt: z.string().datetime().optional() }).parse(input); return json(res, 200, service.decideRequest(r.requestId, r.decision, r.note, 'operator', r.expiresAt)); }
        if (url.pathname === '/api/settings') {
          const patch = settingsSchema.parse(input); const next = { ...service.store.settings(), ...patch };
          if (next.startHour >= next.endHour) throw new Error('Closing hour must be after opening hour.');
          service.store.transaction(() => { service.store.patch('settings', 'settings', patch); service.store.event('settings.updated', 'operator', undefined, patch); }); return json(res, 200, next);
        }
        if (url.pathname === '/api/quota') {
          const quota = z.object({ fiveHourUsed: z.number().min(0).max(100), weeklyUsed: z.number().min(0).max(100), extraUsageEnabled: z.literal(false) }).parse(input);
          const row = service.store.transaction(() => { const row = service.store.put('quotas', { id: id('quota'), ...quota, observedAt: nowIso(), source: 'operator' }); service.store.event('quota.updated', 'operator', row.id); return row; }); return json(res, 200, row);
        }
        if (url.pathname === '/api/quota/refresh') { if (!quotaMonitor) throw new Error('Quota monitor is unavailable.'); return json(res, 200, await quotaMonitor.refresh()); }
        if (url.pathname === '/api/claude/check') { const result = await checkClaude(config.claudeBin); scheduler.status.claude = result.available ? result.subscriptionLogin ? 'available' : 'unauthenticated' : 'missing'; return json(res, 200, result); }
        if (url.pathname === '/api/setup/discord') {
          if (config.mode === 'simulation') throw new Error('Connect Discord in the live app, not the isolated simulation.');
          const setup = z.object({ token: z.string().trim().min(20).max(300).regex(/^[A-Za-z0-9_.-]+$/), guildId: z.string().regex(/^\d{15,25}$/), operatorIds: z.array(z.string().regex(/^\d{15,25}$/)).min(1).max(10) }).parse(input);
          const envPath = resolve(config.root, '.env');
          let lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
          lines = lines.filter(line => !/^\s*(DISCORD_BOT_TOKEN|DISCORD_GUILD_ID|DISCORD_OPERATOR_IDS)\s*=/.test(line));
          lines.push(`DISCORD_BOT_TOKEN=${setup.token}`, `DISCORD_GUILD_ID=${setup.guildId}`, `DISCORD_OPERATOR_IDS=${setup.operatorIds.join(',')}`);
          writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
          chmodSync(envPath, 0o600);
          config.discordToken = setup.token; config.discordGuildId = setup.guildId; config.operatorIds = setup.operatorIds;
          await discord.stop(); scheduler.status.discord = 'connecting'; await discord.connect(); return json(res, 200, { status: scheduler.status.discord, error: scheduler.status.discordError });
        }
        if (url.pathname === '/api/discord/provision') { await discord.provision(); return json(res, 200, { ok: true }); }
        if (url.pathname === '/api/mission/complete') {
          const mission = service.activeMission(); if (!mission) throw new Error('No active mission.');
          const tasks = service.store.all('tasks').filter(t => t.missionId === mission.id);
          if (!tasks.length || tasks.some(t => t.status !== 'done')) throw new Error('All mission tasks must have accepted evidence before completion.');
          const { note } = z.object({ note: z.string().trim().min(1).max(4000) }).parse(input);
          service.store.transaction(() => {
            service.store.patch('missions', mission.id, { status: 'complete' });
            service.store.patch('settings', 'settings', { paused: true });
            for (const job of service.store.all('jobs').filter(j => ['pending', 'failed'].includes(j.status))) service.store.patch('jobs', job.id, { status: 'cancelled', error: 'Mission completed.' });
            service.store.event('mission.completed', 'operator', mission.id, { note });
          });
          scheduler.abortActive(); return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: 'Unknown endpoint.' });
      }
      const files: Record<string, { path: string; mime: string }> = { '/': { path: 'index.html', mime: 'text/html' }, '/app.js': { path: 'app.js', mime: 'text/javascript' }, '/style.css': { path: 'style.css', mime: 'text/css' } };
      const file = files[url.pathname]; if (!file || req.method !== 'GET') return json(res, 404, { error: 'Not found.' });
      if (url.pathname === '/') {
        if (!validOrigin(req.headers.origin, config.port) || (req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] !== 'navigate')) return json(res, 403, { error: 'Open this app directly.' });
        res.setHeader('Set-Cookie', `${cookieName}${operatorToken}; HttpOnly; SameSite=Strict; Path=/`);
      }
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      res.setHeader('Content-Type', `${file.mime}; charset=utf-8`); res.setHeader('Cache-Control', 'no-store'); res.end(readFileSync(resolve(config.root, 'public', file.path)));
    })().catch(error => { if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : 'Request failed.' }); else res.end(); });
  });
  const heartbeat = setInterval(() => { for (const res of sse) res.write(': heartbeat\n\n'); }, 15000); heartbeat.unref();
  server.on('close', () => { clearInterval(heartbeat); service.store.changes.off('event', onEvent); for (const res of sse) res.end(); });
  return server;
}
