import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Harness, RunResult } from './claude.js';
import type { Agent, Job, Run } from './types.js';
import type { CollectiveService } from './service.js';
import { isTaskTool } from './application/tasks.js';
import { isKnowledgeWrite } from './knowledge/repository.js';

const game = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orbit — a Collective rehearsal</title><style>*{box-sizing:border-box}body{margin:0;background:#121916;color:#eef0dd;font:18px system-ui;display:grid;place-items:center;min-height:100vh}main{text-align:center;max-width:540px;padding:32px}h1{font-size:64px;letter-spacing:-4px;margin:0}p{color:#a6b4a4}#board{display:grid;grid-template-columns:repeat(4,70px);gap:10px;justify-content:center;margin:30px 0}button{height:70px;background:#25332c;border:1px solid #485c4b;border-radius:16px;color:#d4e6b0;font-size:28px;cursor:pointer}button:disabled{opacity:.4}#reset{font-size:15px;padding:0 22px;height:45px}small{display:block;margin-top:26px;color:#7c8b80}</style></head><body><main><p>COLLECTIVE · REHEARSAL ARTIFACT</p><h1>Orbit</h1><p>Find all four pairs. Every flip counts.</p><div id="board"></div><p id="status" aria-live="polite">0 moves · 0 of 4 pairs</p><button id="reset">New constellation</button><small>This game is produced by the deterministic simulation, not live agents.</small></main><script>let cards=[],first=null,busy=false,moves=0,pairs=0,generation=0;function setup(){generation++;cards=['☀','☀','☾','☾','✦','✦','◈','◈'].map(v=>({v,k:Math.random()})).sort((a,b)=>a.k-b.k);first=null;busy=false;moves=0;pairs=0;document.querySelector('#board').innerHTML='';cards.forEach((c,i)=>{let b=document.createElement('button');b.textContent='·';b.setAttribute('aria-label','Reveal card '+(i+1));b.onclick=()=>flip(b,i);document.querySelector('#board').append(b)});status()}function status(){document.querySelector('#status').textContent=pairs===4?'Constellation complete in '+moves+' moves!':moves+' moves · '+pairs+' of 4 pairs'}function flip(b,i){if(busy||b.disabled||first?.i===i)return;b.textContent=cards[i].v;if(!first){first={b,i};return}moves++;let prev=first;first=null;if(cards[prev.i].v===cards[i].v){prev.b.disabled=b.disabled=true;pairs++;status()}else{busy=true;let g=generation;setTimeout(()=>{if(g!==generation)return;prev.b.textContent=b.textContent='·';busy=false},700);status()}}document.querySelector('#reset').onclick=setup;setup();</script></body></html>`;

export class SimulationHarness implements Harness {
  constructor(private service: CollectiveService) {}
  async execute(agent: Agent, job: Job, _run: Run, signal: AbortSignal, onEvent: (event: any) => void): Promise<RunResult> {
    await new Promise(r => setTimeout(r, 1100));
    if (signal.aborted) return { summary: 'Rehearsal paused.', inputTokens: 0, outputTokens: 0, estimatedCost: 0, turns: 0, interrupted: true };
    const commandCounts = new Map<string, number>();
    const tool = (name: Parameters<CollectiveService['tool']>[1], args: unknown) => {
      onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name }] } });
      const count = commandCounts.get(name) ?? 0;
      commandCounts.set(name, count + 1);
      return this.service.tool(agent.id, name, args, job, (isTaskTool(name) || isKnowledgeWrite(name)) ? `simulation:${job.id}:${name}:${count}` : undefined) as Promise<any>;
    };
    const store = this.service.store;
    if (job.kind === 'mission') {
      await tool('room_say', { content: 'For this rehearsal, let’s make a small memory game called Orbit. Atlas will define the rules, Ember will build it, and Iris will review the result.' });
      const research = await tool('task_create', { title: 'Define Orbit’s rules', description: 'Choose a compact game loop and write acceptance criteria.', ownerId: 'atlas', acceptance: 'A design note specifies pair matching, move counting, and restart behavior.', dependencies: [] });
      await tool('task_create', { title: 'Build a playable Orbit prototype', description: 'Create a self-contained browser game from the design note.', ownerId: 'ember', acceptance: 'Eight cards form four pairs. Matched cards stay revealed. Restart resets all state.', dependencies: [research.id] });
      await tool('knowledge_write', { title: 'Rehearsal direction: Orbit', content: 'A compact memory game gives the collective a bounded build-and-review cycle. This direction is seeded by the simulation; it is not an autonomous model decision.', kind: 'decision', sources: [] });
    } else if (job.payload.review) {
      const task = store.require('tasks', String(job.payload.taskId));
      await tool('room_enter', { roomId: 'lab' });
      await tool('task_review', { taskId: task.id, accepted: true, note: 'Simulation verdict: evidence is attached and the demonstration fixture meets the seeded acceptance criteria. A live agent review has not run.' });
      await tool('room_say', { content: `Rehearsal review complete: “${task.title}”. The evidence and review note are now on the work board.` });
    } else if ((job.kind === 'task' || job.kind === 'continue') && job.payload.taskId) {
      const task = store.require('tasks', String(job.payload.taskId));
      if (task.ownerId !== agent.id || task.status === 'done' || task.status === 'review') return this.result('No additional work is needed for this rehearsal event.');
      await tool('task_update', { taskId: task.id, status: 'doing' });
      if (agent.id === 'atlas') {
        await tool('room_enter', { roomId: 'studio' });
        const knowledge = await tool('knowledge_write', { title: 'Orbit: rules and acceptance criteria', content: 'Eight cards contain four pairs. Reveal two cards per move. Matching cards stay revealed; mismatches flip back after a short delay. Win when all four pairs are found. Restart must clear moves, matches, pending timers, and revealed cards.', kind: 'decision', sources: [] });
        await tool('task_submit', { taskId: task.id, evidenceIds: [knowledge.id], note: 'The game loop and edge cases are specified.' });
      } else {
        await tool('room_enter', { roomId: 'workshop' });
        writeFileSync(join(this.service.workspace(agent.id), 'orbit.html'), game);
        const artifact = await tool('artifact_publish', { title: 'Orbit — playable rehearsal', description: 'A self-contained memory game. Built by the simulation fixture for testing this workflow.', path: 'orbit.html', taskId: task.id });
        await tool('task_submit', { taskId: task.id, evidenceIds: [artifact.id], note: 'The playable HTML file is ready for independent review.' });
        await tool('permission_request', { title: 'Deploy Orbit to an external preview host', reason: 'An external preview would let invited testers try the game without this computer.', capability: 'resource.other', scope: { resource: 'preview-host', artifactId: artifact.id, visibility: 'invited-testers' }, alternatives: 'Use the local artifact preview until a hosting destination is configured.', estimatedCost: 0 });
      }
    } else if (job.kind === 'feedback' && job.payload.accepted) {
      await tool('room_enter', { roomId: 'commons' });
      await tool('room_say', { content: 'A reviewed milestone is complete. The board links the evidence, and we can continue any work whose dependencies are now satisfied.' });
    } else if (job.kind === 'message') {
      await tool('room_say', { content: `Rehearsal acknowledgment from ${agent.name}. In live mode this response comes from the agent’s persistent Claude Code session.` });
    } else if (job.kind === 'permission') {
      await tool('room_say', { content: 'The operator’s decision is recorded in the request inbox. This rehearsal performs no external actions.' });
    }
    return this.result(`${agent.name} completed a deterministic rehearsal episode. No model or external service was used.`);
  }
  private result(summary: string): RunResult { return { summary, inputTokens: 0, outputTokens: 0, estimatedCost: 0, turns: 0 }; }
}
