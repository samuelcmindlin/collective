import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store, nowIso } from '../src/store.js';
import { seed } from '../src/seed.js';
import { CollectiveService } from '../src/service.js';
import { Scheduler } from '../src/scheduler.js';
import { SimulationHarness } from '../src/simulation.js';
import { DiscordBridge, discordScopeText, isDiscordOperator } from '../src/discord.js';
import { isOpen, nextOpen } from '../src/schedule.js';
import { ClaudeHarness, claudeArgs, claudeSettings, workerEnvironment } from '../src/claude.js';
import { isPublicAddress, readPublicPage } from '../src/web-read.js';
import { createHttpServer } from '../src/http.js';
import type { Config } from '../src/config.js';
import { parseQuotaReport } from '../src/quota.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function setup(mode: Config['mode'] = 'simulation') {
  const dir = mkdtempSync(join(tmpdir(), 'collective-test-'));
  const config: Config = { root: process.cwd(), dataDir: dir, port: 4391, mode, claudeBin: 'claude', operatorIds: ['123456789012345678'] };
  const store = new Store(join(dir, 'db.sqlite')); seed(store);
  const service = new CollectiveService(store, config);
  const scheduler = new Scheduler(store, config, service, new SimulationHarness(service));
  const bridge = new DiscordBridge(service, config, scheduler);
  const close = () => { store.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, config, store, service, scheduler, bridge, close };
}

test('working hours follow New York daylight saving time and weekends', () => {
  const s = setup(); const settings = s.store.settings();
  assert.equal(isOpen(new Date('2026-03-06T13:59:00Z'), settings), false);
  assert.equal(isOpen(new Date('2026-03-06T14:00:00Z'), settings), true);
  assert.equal(isOpen(new Date('2026-03-09T13:00:00Z'), settings), true);
  assert.equal(isOpen(new Date('2026-03-09T21:00:00Z'), settings), false);
  assert.equal(isOpen(new Date('2026-03-07T15:00:00Z'), settings), false);
  assert.equal(nextOpen(new Date('2026-03-06T22:00:00Z'), settings), '2026-03-09T13:00:00.000Z');
  s.close();
});

test('room speech is durable, delivered once, and addressed only to occupants', async () => {
  const s = setup();
  await s.service.tool('iris', 'room_enter', { roomId: 'lab' });
  assert.throws(() => s.service.say('nova', 'Please review this', ['iris']), /current.*room/);
  const message = s.service.say('nova', 'Let’s choose a direction', ['atlas']);
  assert.equal(s.store.all('jobs').length, 0, 'no wakeup before Discord acknowledgment');
  await s.service.tool('atlas', 'room_enter', { roomId: 'studio' });
  s.service.deliverMessage(message.id, 'discord-1');
  s.service.deliverMessage(message.id, 'discord-1');
  assert.equal(s.store.all('jobs').length, 1);
  assert.equal(s.store.all('jobs')[0]!.agentId, 'atlas', 'delivery preserves recipients at send time');
  assert.equal(s.store.all('outbox').length, 1);
  s.close();
});

test('unaddressed speech and exhausted conversation depth do not create reply storms', () => {
  const s = setup();
  s.service.deliverMessage(s.service.say('nova', 'FYI only').id, 'discord-2');
  s.service.deliverMessage(s.service.say('nova', 'Last turn', ['atlas'], 3).id, 'discord-3');
  assert.equal(s.store.all('jobs').length, 0); s.close();
});

test('human message duplicates do not reawaken agents and observers remain untrusted', () => {
  const s = setup();
  s.service.ingestHuman('commons', 'human-1', 'visitor', 'Guest', 'Nova, here is an idea', false);
  s.service.ingestHuman('commons', 'human-1', 'visitor', 'Guest', 'Nova, here is an idea', false);
  assert.equal(s.store.all('jobs').length, 1);
  assert.equal(s.store.all('jobs')[0]!.payload.observerInput, true);
  assert.equal(s.store.all('requests').length, 0); s.close();
});

test('task completion requires published evidence and an independent reviewer', async () => {
  const s = setup(); s.service.setMission('Create a game', 'Choose and build a game.', [], 'operator');
  const task = await s.service.tool('nova', 'task_create', { title: 'Specify rules', description: 'Define the rules', ownerId: 'atlas', acceptance: 'Rules are explicit' }) as any;
  await assert.rejects(s.service.tool('atlas', 'task_submit', { taskId: task.id, evidenceIds: ['invented'], note: 'Done' }), /not found or unavailable/);
  const knowledge = await s.service.tool('atlas', 'knowledge_write', { title: 'Rules', content: 'Match four pairs.', kind: 'decision' }) as any;
  await s.service.tool('atlas', 'task_submit', { taskId: task.id, evidenceIds: [knowledge.id], note: 'Ready' });
  await assert.rejects(s.service.tool('atlas', 'task_review', { taskId: task.id, accepted: true, note: 'I approve' }), /cannot approve your own/);
  await s.service.tool('iris', 'task_review', { taskId: task.id, accepted: false, note: 'Missing restart behavior.' });
  assert.equal(s.store.require('tasks', task.id).status, 'todo');
  assert.equal(s.store.require('agents', 'atlas').completed, 0); s.close();
});

test('dependencies prevent premature work and acceptance wakes the next owner', async () => {
  const s = setup(); s.service.setMission('Game', 'Build it', [], 'operator');
  const first = await s.service.tool('nova', 'task_create', { title: 'Design', description: 'Rules', ownerId: 'atlas', acceptance: 'Rules exist' }) as any;
  const second = await s.service.tool('nova', 'task_create', { title: 'Build', description: 'Game', ownerId: 'ember', acceptance: 'Playable', dependencies: [first.id] }) as any;
  await assert.rejects(s.service.tool('ember', 'task_update', { taskId: second.id, status: 'doing' }), /Dependencies/);
  const knowledge = await s.service.tool('atlas', 'knowledge_write', { title: 'Rules', content: 'Match pairs', kind: 'decision' }) as any;
  await s.service.tool('atlas', 'task_submit', { taskId: first.id, evidenceIds: [knowledge.id], note: 'Ready' });
  await s.service.tool('iris', 'task_review', { taskId: first.id, accepted: true, note: 'Rules inspected' });
  assert.ok(s.store.all('jobs').some(j => j.agentId === 'ember' && j.payload.taskId === second.id)); s.close();
});

test('request deduplication, ownership, expiry, revocation, and one-time execution', async () => {
  const s = setup();
  const requestData = { title: 'Invite a designer', reason: 'Need design help', capability: 'team.add_agent' as const, scope: { name: 'Vale', role: 'Designer', bio: 'Makes interaction clearer' }, alternatives: 'Use the existing team', estimatedCost: 0 };
  const r = s.service.createRequest('nova', requestData);
  assert.equal(s.service.createRequest('nova', requestData).id, r.id);
  await assert.rejects(s.service.executeCapability('nova', r.id), /approved/);
  s.service.decideRequest(r.id, 'approved', 'One specialist', 'operator');
  await assert.rejects(s.service.executeCapability('atlas', r.id), /another agent/);
  const first = await s.service.executeCapability('nova', r.id); const second = await s.service.executeCapability('nova', r.id);
  assert.deepEqual(first, second); assert.equal(s.store.all('agents').length, 5);
  const other = s.service.createRequest('nova', { ...requestData, scope: { name: 'Wren', role: 'Writer', bio: 'Writes' } });
  s.service.decideRequest(other.id, 'approved', '', 'operator'); s.service.decideRequest(other.id, 'revoked', 'No longer needed', 'operator');
  await assert.rejects(s.service.executeCapability('nova', other.id), /approved/);
  assert.throws(() => s.service.decideRequest(other.id, 'approved', '', 'operator'), /already been decided/);
  s.close();
});

test('approved unsupported capabilities never pretend to have executed', async () => {
  const s = setup();
  const r = s.service.createRequest('ember', { title: 'External deployment', reason: 'Preview', capability: 'external.publish', scope: { destination: 'internet' }, alternatives: 'Local preview', estimatedCost: 0 });
  s.service.decideRequest(r.id, 'approved', '', 'operator');
  await assert.rejects(s.service.executeCapability('ember', r.id), /no configured executor/);
  assert.equal(s.store.require('requests', r.id).status, 'approved'); s.close();
});

test('artifacts are immutable snapshots and cannot escape via symlinks', async () => {
  const s = setup(); const workspace = s.service.workspace('ember');
  writeFileSync(join(workspace, 'game.html'), '<h1>original</h1>');
  const artifact = await s.service.tool('ember', 'artifact_publish', { title: 'Game', description: 'A game', path: 'game.html' }) as any;
  writeFileSync(join(workspace, 'game.html'), '<h1>changed</h1>');
  const read = await s.service.tool('iris', 'artifact_read', { artifactId: artifact.id }) as any;
  assert.equal(read.content, '<h1>original</h1>');
  writeFileSync(join(s.dir, 'secret.txt'), 'private'); symlinkSync(join(s.dir, 'secret.txt'), join(workspace, 'escape.txt'));
  await assert.rejects(s.service.tool('ember', 'artifact_publish', { title: 'Escape', description: 'Bad', path: 'escape.txt' }), /inside your workspace/); s.close();
});

test('job claiming serializes each agent and recovers interrupted sessions', () => {
  const s = setup();
  s.store.enqueue('nova', 'feedback', {}, 'a'); s.store.enqueue('nova', 'feedback', {}, 'a'); s.store.enqueue('nova', 'feedback', {}, 'b'); s.store.enqueue('atlas', 'feedback', {}, 'c');
  const first = s.store.claimJob()!; const second = s.store.claimJob()!;
  assert.equal(first.agentId, 'nova'); assert.equal(second.agentId, 'atlas'); assert.equal(s.store.claimJob(), undefined);
  s.store.patch('agents', 'nova', { sessionId: 'persistent-session', status: 'working' });
  s.store.put('runs', { id: 'run-test', jobId: first.id, agentId: 'nova', status: 'running', sessionId: 'persistent-session', inputTokens: 0, outputTokens: 0, estimatedCost: 0, turns: 0, startedAt: nowIso() });
  s.store.close();
  const reopened = new Store(join(s.dir, 'db.sqlite')); reopened.recover();
  assert.equal(reopened.require('jobs', first.id).status, 'pending'); assert.equal(reopened.require('runs', 'run-test').status, 'interrupted'); assert.equal(reopened.require('agents', 'nova').sessionId, 'persistent-session');
  reopened.close(); rmSync(s.dir, { recursive: true, force: true });
});

test('live launches fail closed on stale, incomplete, or exhausted quota', () => {
  const s = setup('live'); s.service.setMission('Game', 'Build', [], 'operator'); s.store.patch('settings', 'settings', { paused: false });
  s.scheduler.status.discord = 'connected'; s.scheduler.status.claude = 'available';
  const at = new Date('2026-09-23T14:00:00Z');
  assert.match(s.scheduler.blockReason(at)!, /missing or stale/);
  s.store.put('quotas', { id: 'quota', fiveHourUsed: 0, weeklyUsed: 0, observedAt: at.toISOString(), extraUsageEnabled: false, source: 'operator' });
  assert.equal(s.scheduler.blockReason(at), undefined, 'zero is valid data');
  s.store.patch('quotas', 'quota', { weeklyUsed: undefined }); assert.match(s.scheduler.blockReason(at)!, /Both/);
  s.store.patch('quotas', 'quota', { weeklyUsed: 21 }); assert.match(s.scheduler.blockReason(at)!, /stop threshold/);
  s.store.patch('quotas', 'quota', { weeklyUsed: 0 }); assert.match(s.scheduler.blockReason(new Date(at.getTime() + 11*60000))!, /stale/);
  s.close();
});

test('CLI execution cannot inherit paid API credentials or enable unrestricted tools', () => {
  const s = setup(); const args = claudeArgs(s.store.require('agents', 'nova'), '/safe/settings.json', '/safe/mcp.json', s.store.settings());
  assert.ok(args.includes('--restricted')); assert.ok(args.includes('--strict-mcp-config')); assert.ok(args.includes('--permission-prompts')); assert.ok(!args.includes('--dangerously-skip-permissions')); assert.ok(!args.includes('--bare'));
  process.env.ANTHROPIC_API_KEY = 'do-not-inherit'; process.env.DISCORD_BOT_TOKEN = 'do-not-inherit';
  const env = workerEnvironment(); assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.DISCORD_BOT_TOKEN, undefined);
  delete process.env.ANTHROPIC_API_KEY; delete process.env.DISCORD_BOT_TOKEN;
  const settings = claudeSettings(s.service.workspace('nova'), s.dir);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false); assert.equal(settings.sandbox.failIfUnavailable, true); assert.deepEqual(settings.sandbox.network.allowedDomains, []); assert.equal(settings.sandbox.network.strictAllowlist, true);
  s.close();
});

test('public web reader rejects private, link-local, IPv6 loopback, and unsafe protocols', async () => {
  for (const address of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.1.1','192.168.1.1','::1','fe80::1','::ffff:127.0.0.1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  await assert.rejects(readPublicPage('http://example.com'), /HTTPS/);
  await assert.rejects(readPublicPage('https://127.0.0.1'), /Private/);
  await assert.rejects(readPublicPage('https://user:password@example.com'), /HTTPS/);
});

test('calendar rejects overlapping invitations and keeps outcomes persistent', async () => {
  const s = setup(); const startsAt = new Date(Date.now()+60000).toISOString();
  const meeting = { title: 'Choose a game', agenda: 'Compare options', expectedOutcome: 'A chosen direction', roomId: 'studio', participants: ['nova','atlas'], startsAt, durationMinutes: 10 };
  await s.service.tool('nova','meeting_schedule',meeting);
  await assert.rejects(s.service.tool('nova','meeting_schedule',{...meeting,roomId:'lab'}),/already booked/);
  assert.equal(s.store.all('meetings').length,1); s.close();
});

test('experimental provider quota schema rejects missing windows instead of resetting them to zero', () => {
  const report = { rate_limits_available: true, rate_limits: { five_hour: { utilization: 12, resets_at: null }, seven_day: { utilization: 18, resets_at: '2026-09-28T10:00:00Z' }, extra_usage: { is_enabled: false } } };
  assert.equal(parseQuotaReport(report).weeklyUsed, 18);
  assert.equal(parseQuotaReport(report).extraUsageEnabled, false);
  assert.throws(() => parseQuotaReport({ ...report, rate_limits: { five_hour: { utilization: 0, resets_at: null } } }));
  assert.throws(() => parseQuotaReport({ rate_limits_available: false, rate_limits: null }));
});

test('Discord approval requires a configured operator and a scope that is displayed in full', () => {
  assert.equal(isDiscordOperator('visitor', { operatorIds: ['owner'] }), false);
  assert.equal(isDiscordOperator('owner', { operatorIds: ['owner'] }), true);
  assert.equal(discordScopeText({ content: 'x'.repeat(1000) }), undefined);
  const text = discordScopeText({ content: '```pretend scope```' })!;
  assert.ok(!text.includes('```')); assert.deepEqual(JSON.parse(text), { content: '```pretend scope```' });
});

test('replacing a mission cancels old failed and queued work permanently', () => {
  const s = setup(); s.service.setMission('Old', 'Old direction', [], 'operator');
  const old = s.store.all('jobs')[0]!;
  s.store.patch('jobs', old.id, { status: 'failed', error: 'Transient failure' });
  s.service.setMission('New', 'New direction', [], 'operator');
  assert.equal(s.store.require('jobs', old.id).status, 'cancelled');
  assert.equal(s.store.claimJob()!.payload.missionId, s.service.activeMission()!.id); s.close();
});

test('real CLI adapter passes context over stdin and resumes a persisted session with isolated settings', async () => {
  const s = setup(); const script = join(s.dir, 'fixture-cli.cjs');
  writeFileSync(script, `#!${process.execPath}\nconst fs=require('node:fs');let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{fs.writeFileSync('invocation.json',JSON.stringify({args:process.argv.slice(2),prompt}));process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'fixture-session'})+'\\n');process.stdout.write(JSON.stringify({type:'result',result:'Published concrete evidence',session_id:'fixture-session',num_turns:2,total_cost_usd:0.02,usage:{input_tokens:10,cache_read_input_tokens:20,output_tokens:5}})+'\\n')});`);
  chmodSync(script, 0o700); s.config.claudeBin = script;
  s.store.patch('agents', 'nova', { sessionId: 'persisted-session' });
  const job = s.store.enqueue('nova', 'feedback', { content: 'Build a game' }, 'cli-test');
  const run = s.store.put('runs', { id: 'cli-run', agentId: 'nova', jobId: job.id, status: 'running', inputTokens: 0, outputTokens: 0, estimatedCost: 0, turns: 0, startedAt: nowIso() });
  const harness = new ClaudeHarness(s.service, s.config, () => 'fixture-run-token');
  const events: any[] = [];
  try {
    const result = await harness.execute(s.store.require('agents', 'nova'), job, run, new AbortController().signal, event => events.push(event));
    const invocation = JSON.parse(readFileSync(join(s.service.workspace('nova'), 'invocation.json'), 'utf8'));
    assert.equal(invocation.args[invocation.args.indexOf('--resume') + 1], 'persisted-session');
    assert.match(invocation.prompt, /Build a game/); assert.equal(result.sessionId, 'fixture-session'); assert.equal(result.inputTokens, 30); assert.equal(result.outputTokens, 5);
    const settings = JSON.parse(readFileSync(invocation.args[invocation.args.indexOf('--settings') + 1], 'utf8'));
    assert.ok(settings.permissions.allow.every((rule: string) => rule.startsWith('mcp__') || rule.includes(s.service.workspace('nova'))));
    assert.equal(events.length, 2);
  } finally { s.close(); }
});

test('CLI timeouts fail an episode and aborts preserve resumability', async () => {
  const s = setup(); const script = join(s.dir, 'slow-cli.cjs');
  writeFileSync(script, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'kept-session'})+'\\n');process.stdin.resume();setInterval(()=>{},1000);`); chmodSync(script, 0o700); s.config.claudeBin = script;
  s.store.patch('settings', 'settings', { maxRunSeconds: 0.25 });
  const job = s.store.enqueue('nova', 'feedback', {}, 'timeout');
  const run = s.store.put('runs', { id: 'slow-run', agentId: 'nova', jobId: job.id, status: 'running', inputTokens: 0, outputTokens: 0, estimatedCost: 0, turns: 0, startedAt: nowIso() });
  const harness = new ClaudeHarness(s.service, s.config, () => 'fixture-token');
  try {
    await assert.rejects(harness.execute(s.store.require('agents', 'nova'), job, run, new AbortController().signal, () => {}), /time limit/);
    const controller = new AbortController();
    const result = await harness.execute(s.store.require('agents', 'nova'), job, run, controller.signal, () => controller.abort());
    assert.equal(result.interrupted, true); assert.equal(result.sessionId, 'kept-session');
  } finally { s.close(); }
});

test('MCP subprocess reaches domain tools through a live run token and loses authority on pause', async () => {
  const s = setup(); const server = createHttpServer(s.service, s.scheduler, s.bridge, s.config);
  await new Promise<void>(r => server.listen(s.config.port, '127.0.0.1', r));
  s.service.setMission('MCP fixture', 'Exercise the live tool transport', [], 'operator');
  s.store.patch('settings', 'settings', { paused: false });
  const job = s.store.claimJob()!;
  s.store.put('runs', { id: 'mcp-run', agentId: 'nova', jobId: job.id, attempt: job.attempts, status: 'running', inputTokens: 0, outputTokens: 0, estimatedCost: 0, turns: 0, startedAt: nowIso() });
  const controller = new AbortController(); s.scheduler.controllers.set('mcp-run', controller);
  const client = new Client({ name: 'collective-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('src/mcp-worker.ts')], env: { ...workerEnvironment() as Record<string, string>, COLLECTIVE_AGENT_ENDPOINT: `http://127.0.0.1:${s.config.port}/agent/tools`, COLLECTIVE_RUN_TOKEN: s.scheduler.grantRun('mcp-run') }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const listed = await client.listTools(); assert.ok(listed.tools.some(t => t.name === 'room_say'));
    const result = await client.callTool({ name: 'room_say', arguments: { content: 'MCP transport is connected', toAgentIds: ['atlas'] } });
    assert.equal(result.isError, false); assert.equal(s.store.all('messages')[0]!.delivery, 'pending');
    controller.abort(); const denied = await client.callTool({ name: 'profile_update', arguments: { bio: 'Unauthorized mutation' } });
    assert.equal(denied.isError, true); assert.notEqual(s.store.require('agents', 'nova').bio, 'Unauthorized mutation');
  } finally { await client.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); s.scheduler.controllers.clear(); s.close(); }
});

test('end-to-end rehearsal produces a playable artifact, accepted work, and a durable request', async () => {
  const s = setup(); s.service.setMission('Create a game', 'Choose and build a game.', ['Playable'], 'operator'); s.store.patch('settings','settings',{paused:false});
  for (let i=0;i<70;i++) { await s.bridge.flush(); await s.scheduler.tick(); await new Promise(r=>setTimeout(r,200)); if(s.store.all('tasks').length===2&&s.store.all('tasks').every(t=>t.status==='done')&&!s.scheduler.controllers.size)break; }
  await s.scheduler.stop(); await s.bridge.flush();
  assert.equal(s.store.all('tasks').length,2); assert.ok(s.store.all('tasks').every(t=>t.status==='done'));
  assert.equal(s.store.all('artifacts').length,1); assert.equal(s.store.all('requests')[0]?.status,'pending');
  assert.ok(s.store.all('messages').every(m=>m.delivery==='delivered')); assert.ok(s.store.all('runs').every(r=>r.estimatedCost===0));
  s.close();
});

test('HTTP operator boundary rejects cross-origin mutation and agent tokens on operator endpoints', async () => {
  const s=setup(); const server=createHttpServer(s.service,s.scheduler,s.bridge,s.config);
  await new Promise<void>(r=>server.listen(s.config.port,'127.0.0.1',r));
  try {
    const base=`http://127.0.0.1:${s.config.port}`;
    const root=await fetch(base); const cookie=root.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await fetch(base+'/api/state')).status,403);
    assert.equal((await fetch(base+'/api/state',{headers:{cookie}})).status,200);
    assert.equal((await fetch(base+'/api/control',{method:'POST',headers:{cookie,'Content-Type':'application/json','X-Collective-Local':'1',Origin:'https://evil.example'},body:JSON.stringify({action:'resume'})})).status,403);
    assert.equal((await fetch(base+'/api/control',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({action:'resume'})})).status,403);
    assert.equal((await fetch(base+'/agent/tools',{method:'POST',headers:{Authorization:'Bearer invented','Content-Type':'application/json'},body:'{}'})).status,401);
    assert.equal((await fetch(base+'/api/settings',{method:'POST',headers:{cookie,'X-Collective-Local':'1','Content-Type':'application/json'},body:JSON.stringify({paused:false})})).status,400,'settings cannot bypass control API');
  } finally { server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r()));s.close(); }
});
