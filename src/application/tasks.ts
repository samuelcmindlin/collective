import { z } from 'zod/v3';
import { Store, id, nowIso } from '../store.js';
import type { Job, Mission, Task } from '../types.js';
import { executeCommand } from './commands.js';
import type { ProgressRepository } from '../progress/repository.js';
import { criterionSchema, bindingSchema, verdictSchema } from '../progress/schemas.js';

const text = (max = 4000) => z.string().trim().min(1).max(max);
const ids = z.array(text(100)).max(20);
const commandId = text(128).optional().describe('Stable ID for this logical action. Reuse it for an identical retry, including after a session restart.');
const expectedVersion = z.number().int().min(1).optional().describe('Task version read from context. A stale version rejects the change.');

export const taskSchemas = {
  task_create: z.object({ commandId, title: text(200), description: text(), ownerId: text(100), acceptance: text(), criteria: z.array(criterionSchema).min(1).max(12).optional(), dependencies: ids.default([]) }).strict(),
  task_update: z.object({ commandId, expectedVersion, taskId: text(100), status: z.enum(['doing', 'blocked']), note: text().optional() }).strict(),
  task_submit: z.object({ commandId, expectedVersion, taskId: text(100), evidenceIds: ids.min(1).optional(), bindings: z.array(bindingSchema).min(1).max(12).optional(), note: text(), limitations: z.array(text(1000)).max(12).default([]) }).strict(),
  task_review: z.object({ commandId, expectedVersion, taskId: text(100), submissionId: text(100), accepted: z.boolean(), verdicts: z.array(verdictSchema).min(1).max(12), note: text() }).strict(),
};
export type TaskToolName = keyof typeof taskSchemas;
export const isTaskTool = (name: string): name is TaskToolName => Object.hasOwn(taskSchemas, name);

function parseCommand(name: TaskToolName, raw: unknown) {
  switch (name) {
    case 'task_create': return { name, args: taskSchemas.task_create.parse(raw) };
    case 'task_update': return { name, args: taskSchemas.task_update.parse(raw) };
    case 'task_submit': return { name, args: taskSchemas.task_submit.parse(raw) };
    case 'task_review': return { name, args: taskSchemas.task_review.parse(raw) };
  }
}

/** Task transitions own their transaction, including jobs, counters and receipts. */
export class TaskCommands {
  constructor(private store: Store, private progress: ProgressRepository) {}

  execute(agentId: string, name: TaskToolName, raw: unknown, invocationId?: string, job?: Job): Task {
    const command = parseCommand(name, raw);
    const { commandId: suppliedId, ...payload } = command.args;
    if (suppliedId && invocationId && suppliedId !== invocationId) throw new Error('Command ID differs between the tool and its envelope.');
    const commandId = suppliedId ?? invocationId ?? id('cmd');
    return this.store.transaction(() => {
      this.store.require('agents', agentId);
      const mission = this.store.all('missions').find(m => m.status === 'active');
      if (!mission) throw new Error('No active mission.');
      return executeCommand(this.store, { principalId: agentId, commandId, name, missionId: mission.id }, { missionRevision: mission.revision, ...payload }, () => {
        switch (command.name) {
          case 'task_create': return this.create(agentId, mission, command.args);
          case 'task_update': return this.update(agentId, mission, command.args);
          case 'task_submit': return this.submit(agentId, mission, command.args, job);
          case 'task_review': return this.review(agentId, mission, command.args, job);
        }
      });
    });
  }

  private currentTask(taskId: string, mission: Mission, expectedVersion?: number): Task {
    const task = this.store.require('tasks', taskId);
    if (task.missionId !== mission.id) throw new Error('Task belongs to an inactive mission. Historical work is read-only.');
    if (expectedVersion !== undefined && expectedVersion !== (task.version ?? 1)) {
      throw new Error('Task version conflict: read current work before submitting a new command.');
    }
    return task;
  }

  private dependenciesComplete(task: Task): boolean {
    return task.dependencies.every(dep => {
      const dependency = this.store.require('tasks', dep);
      if (dependency.missionId !== task.missionId) throw new Error('Dependency belongs to another mission.');
      return dependency.status === 'done';
    });
  }

  private patch(task: Task, changes: Partial<Task>): Task {
    return this.store.patch('tasks', task.id, { ...changes, version: (task.version ?? 1) + 1 });
  }

  private create(agentId: string, mission: Mission, args: z.infer<typeof taskSchemas.task_create>): Task {
    this.store.require('agents', args.ownerId);
    if (new Set(args.dependencies).size !== args.dependencies.length) throw new Error('Duplicate task dependencies.');
    for (const dependency of args.dependencies) this.currentTask(dependency, mission);
    const { commandId: _commandId, criteria, ...fields } = args;
    const task: Task = {
      id: id('task'), missionId: mission.id, ...fields, version: 1, reviewRound: 0,
      status: 'todo', evidence: [], createdAt: nowIso(),
    };
    const contract = this.progress.freeze(task, agentId, criteria);
    task.criteriaId = contract.id;
    this.store.put('tasks', task);
    if (this.dependenciesComplete(task)) {
      this.store.enqueue(task.ownerId, 'task', { taskId: task.id }, `task:${task.id}:start`);
    }
    this.store.event('task.created', agentId, task.id, { title: task.title, ownerId: task.ownerId });
    return task;
  }

  private update(agentId: string, mission: Mission, args: z.infer<typeof taskSchemas.task_update>): Task {
    const task = this.currentTask(args.taskId, mission, args.expectedVersion);
    if (task.ownerId !== agentId) throw new Error('Only the task owner can update its work status.');
    if (task.status === 'done' || task.status === 'review') throw new Error('Task is already submitted.');
    if (args.status === 'doing' && !this.dependenciesComplete(task)) throw new Error('Dependencies are not complete.');
    const updated = this.patch(task, { status: args.status });
    this.store.event('task.updated', agentId, task.id, { status: args.status, note: args.note });
    return updated;
  }

  private submit(agentId: string, mission: Mission, args: z.infer<typeof taskSchemas.task_submit>, job?: Job): Task {
    const task = this.currentTask(args.taskId, mission, args.expectedVersion);
    if (task.ownerId !== agentId) throw new Error('Only the owner can submit this task.');
    if (task.status === 'done' || (task.status === 'review' && task.submissionId)) throw new Error('Task already submitted.');
    if (!this.dependenciesComplete(task)) throw new Error('Dependencies are not complete.');
    const submission = this.progress.submit(task, agentId, args, { jobId: job?.id, attempt: job?.attempts });
    const agents = this.store.all('agents');
    const reviewer = agents.find(a => a.role === 'Reviewer' && a.id !== agentId)
      ?? agents.find(a => a.id !== agentId);
    if (!reviewer) throw new Error('No independent reviewer is available.');
    const reviewRound = submission.round;
    const updated = this.patch(task, { status: 'review', criteriaId: submission.criteriaId, submissionId: submission.id, evidence: submission.evidence.map(e => e.id), review: undefined, reviewRound });
    this.store.enqueue(reviewer.id, 'task', { taskId: task.id, submissionId: submission.id, review: true, reviewRound }, `task:${task.id}:review:${reviewRound}`);
    this.store.event('task.submitted', agentId, task.id, { note: args.note, reviewRound, submissionId: submission.id, checks: submission.checks });
    return updated;
  }

  private review(agentId: string, mission: Mission, args: z.infer<typeof taskSchemas.task_review>, job?: Job): Task {
    const task = this.currentTask(args.taskId, mission, args.expectedVersion);
    if (task.ownerId === agentId) throw new Error('Independent review required: you cannot approve your own task.');
    if (task.status !== 'review' || !task.evidence.length) throw new Error('Task must be submitted with evidence first.');
    const evaluation = this.progress.review(task, agentId, args, { jobId: job?.id, attempt: job?.attempts });
    const updated = this.patch(task, {
      status: args.accepted ? 'done' : 'todo',
      review: { reviewerId: agentId, accepted: args.accepted, note: args.note, at: evaluation.createdAt, evaluationId: evaluation.id },
    });
    if (args.accepted) {
      const owner = this.store.require('agents', task.ownerId);
      this.store.patch('agents', owner.id, { completed: owner.completed + 1 });
      for (const dependent of this.store.all('tasks').filter(t => t.missionId === mission.id && t.status === 'todo' && t.dependencies.includes(task.id))) {
        if (this.dependenciesComplete(dependent)) this.store.enqueue(dependent.ownerId, 'task', { taskId: dependent.id }, `task:${dependent.id}:start`);
      }
      const coordinator = this.store.all('agents').find(a => a.role === 'Coordinator');
      if (coordinator) this.store.enqueue(coordinator.id, 'feedback', { taskId: task.id, accepted: true, note: args.note }, `accepted:${task.id}`);
    } else {
      this.store.enqueue(task.ownerId, 'task', { taskId: task.id, reviewFeedback: args.note }, `revision:${task.id}:${task.reviewRound ?? task.version ?? 1}`);
    }
    this.store.event(args.accepted ? 'task.accepted' : 'task.rejected', agentId, task.id, { note: args.note, evaluationId: evaluation.id, submissionId: evaluation.submissionId });
    return updated;
  }
}
