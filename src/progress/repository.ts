import { Store, id, nowIso } from '../store.js';
import type { Artifact, Task } from '../types.js';
import type { KnowledgeRepository } from '../knowledge/repository.js';
import type { CriteriaSet, Criterion, EvidenceRef, Submission, Inspection, Evaluation, EvidenceBinding, Verdict, ExecutionRef } from './types.js';
import { checkJsonFields, hashRecord } from './checks.js';
import { progressSchemas } from './schemas.js';

function distinct(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}.`);
}
function sameIds(a: string[], b: string[]) {
  const sorted = [...b].sort();
  return a.length === b.length && [...a].sort().every((id, i) => id === sorted[i]);
}

export class ProgressRepository {
  constructor(private store: Store, private knowledge: KnowledgeRepository, private readArtifact: (artifact: Artifact) => Buffer) {}

  private atomic() { if (!this.store.inTransaction) throw new Error('Progress writes require an application transaction.'); }
  criteria(taskId: string): CriteriaSet | undefined {
    const row = this.store.db.prepare('SELECT data FROM progress_criteria WHERE task_id=?').get(taskId) as { data: string } | undefined;
    if (!row) return;
    const result = JSON.parse(row.data) as CriteriaSet;
    const { sha256, ...payload } = result;
    if (hashRecord(payload) !== sha256) throw new Error('Criterion integrity check failed.');
    return result;
  }
  freeze(task: Task, authorId: string, criteria?: Criterion[], authority: CriteriaSet['authority'] = 'agent-proposed') {
    this.atomic();
    const rows = criteria ?? [{ id: 'acceptance', description: task.acceptance, method: 'judgment', evidenceKind: 'either' }];
    distinct(rows.map(c => c.id), 'criterion IDs');
    for (const c of rows) if (c.method === 'json.fields.v1') distinct(c.fields.map(f => f.name), 'JSON field names');
    const mission = this.store.require('missions', task.missionId);
    const payload = { id: id('criteria'), taskId: task.id, missionId: mission.id, missionRevision: mission.revision,
      version: 1 as const, authorId, authority, criteria: rows, createdAt: nowIso() };
    const result: CriteriaSet = { ...payload, sha256: hashRecord(payload) };
    this.store.db.prepare('INSERT INTO progress_criteria VALUES(?,?,?)').run(result.id, task.id, JSON.stringify(result));
    return result;
  }
  submission(submissionId: string): Submission {
    const row = this.store.db.prepare('SELECT data FROM progress_submissions WHERE id=?').get(submissionId) as { data: string } | undefined;
    if (!row) throw new Error('Submission not found.');
    return JSON.parse(row.data);
  }
  private evidence(agentId: string, evidenceId: string): { ref: EvidenceRef; bytes: Buffer; text?: string } {
    const artifact = this.store.get('artifacts', evidenceId);
    if (artifact) {
      const bytes = this.readArtifact(artifact);
      return { ref: { kind: 'artifact', id: artifact.id, sha256: artifact.sha256, size: artifact.size, mime: artifact.mime }, bytes,
        text: /^(text\/|application\/json|image\/svg)/.test(artifact.mime) ? bytes.toString('utf8') : undefined };
    }
    const entry = this.knowledge.get({ kind: 'agent', id: agentId }, { revisionId: evidenceId });
    if (entry.namespace === 'agent') throw new Error('Task evidence must be shared knowledge, not a private note.');
    return { ref: { kind: 'knowledge', id: entry.id, documentId: entry.documentId, sha256: entry.sha256 }, bytes: Buffer.from(entry.content), text: entry.content };
  }
  private verified(agentId: string, ref: EvidenceRef) {
    const current = this.evidence(agentId, ref.id);
    if (hashRecord(current.ref) !== hashRecord(ref)) throw new Error('Submitted evidence integrity check failed: its identity or metadata changed.');
    return current;
  }
  submit(task: Task, agentId: string, args: { bindings?: EvidenceBinding[]; evidenceIds?: string[]; note: string; limitations: string[] }, execution: ExecutionRef): Submission {
    this.atomic();
    const criteria = this.criteria(task.id) ?? this.freeze(task, 'legacy', undefined, 'legacy');
    if (args.bindings && args.evidenceIds) throw new Error('Supply bindings or the single-criterion evidenceIds shorthand, not both.');
    const bindings = args.bindings ?? (args.evidenceIds && criteria.criteria.length === 1 ? [{ criterionId: criteria.criteria[0]!.id, evidenceIds: args.evidenceIds }] : undefined);
    if (!bindings || !sameIds(bindings.map(b => b.criterionId), criteria.criteria.map(c => c.id))) throw new Error('Submission must bind evidence to every frozen criterion exactly once.');
    distinct(bindings.map(b => b.criterionId), 'criterion bindings');
    for (const binding of bindings) distinct(binding.evidenceIds, 'evidence IDs');
    const evidenceIds = [...new Set(bindings.flatMap(b => b.evidenceIds))];
    if (evidenceIds.length > 20) throw new Error('A submission may contain at most 20 distinct evidence items.');
    const resolved = new Map(evidenceIds.map(key => [key, this.evidence(agentId, key)]));
    for (const criterion of criteria.criteria) {
      const binding = bindings.find(b => b.criterionId === criterion.id)!;
      if (criterion.evidenceKind !== 'either' && binding.evidenceIds.some(key => resolved.get(key)!.ref.kind !== criterion.evidenceKind)) throw new Error(`Criterion ${criterion.id} requires ${criterion.evidenceKind} evidence.`);
    }
    const checks: Submission['checks'] = criteria.criteria.flatMap(criterion => {
      if (criterion.method === 'judgment') return [];
      const results = bindings.find(b => b.criterionId === criterion.id)!.evidenceIds.map(key => ({ evidenceId: key, ...checkJsonFields(resolved.get(key)!.bytes, criterion) }));
      return [{ criterionId: criterion.id, checkId: criterion.method, policyHash: hashRecord(criterion), evaluator: 'platform' as const,
        status: results.some(r => r.status === 'error') ? 'error' as const : results.some(r => r.status === 'fail') ? 'fail' as const : 'pass' as const, results }];
    });
    const submission: Submission = { ...execution, id: id('submission'), taskId: task.id, missionId: criteria.missionId, missionRevision: criteria.missionRevision,
      criteriaId: criteria.id, criteriaHash: criteria.sha256, authorId: agentId, round: (task.reviewRound ?? 0) + 1,
      bindings, evidence: [...resolved.values()].map(value => value.ref), checks, note: args.note, limitations: args.limitations, createdAt: nowIso() };
    this.store.db.prepare('INSERT INTO progress_submissions VALUES(?,?,?)').run(submission.id, task.id, JSON.stringify(submission));
    return submission;
  }
  inspect(agentId: string, raw: unknown, execution: ExecutionRef = {}) {
    const args = progressSchemas.task_evidence_read.parse(raw);
    return this.store.transaction(() => {
      this.store.require('agents', agentId);
      const submission = this.submission(args.submissionId);
      const ref = submission.evidence.find(e => e.id === args.evidenceId);
      if (!ref) throw new Error('Evidence does not belong to this submission.');
      const { text } = this.verified(agentId, ref);
      const content = text?.slice(args.offset, args.offset + args.maxChars);
      if (text !== undefined && args.offset > 0 && !content?.length) throw new Error('Evidence offset is beyond the content.');
      const receipt: Inspection = { ...execution, id: id('inspection'), submissionId: submission.id, principalId: agentId,
        evidenceId: ref.id, sha256: ref.sha256, offset: args.offset, returnedChars: content?.length ?? 0,
        totalChars: text?.length, mode: text === undefined ? 'binary-metadata' : 'text', createdAt: nowIso() };
      this.store.db.prepare('INSERT INTO progress_inspections VALUES(?,?,?,?,?)').run(receipt.id, submission.id, agentId, ref.id, JSON.stringify(receipt));
      this.store.event('task.evidence_inspected', agentId, submission.taskId, receipt);
      const nextOffset = text !== undefined && args.offset + args.maxChars < text.length ? args.offset + args.maxChars : null;
      return { evidence: ref, content, receipt, nextOffset, truncated: text !== undefined && (args.offset > 0 || nextOffset !== null), untrusted: true };
    });
  }
  review(task: Task, agentId: string, args: { submissionId: string; accepted: boolean; verdicts: Verdict[]; note: string }, execution: ExecutionRef): Evaluation {
    this.atomic();
    if (task.submissionId !== args.submissionId) throw new Error('Stale submission: read the current task and review its exact submission. Legacy reviews must be resubmitted.');
    const submission = this.submission(args.submissionId), criteria = this.criteria(task.id)!;
    if (submission.taskId !== task.id || submission.criteriaHash !== criteria.sha256 || task.criteriaId !== criteria.id) throw new Error('Submission criteria binding is invalid.');
    distinct(args.verdicts.map(v => v.criterionId), 'criterion verdicts');
    if (!sameIds(args.verdicts.map(v => v.criterionId), criteria.criteria.map(c => c.id))) throw new Error('Review must include a verdict for every frozen criterion exactly once.');
    for (const verdict of args.verdicts) {
      distinct(verdict.evidenceIds, 'review evidence IDs');
      if (!sameIds(verdict.evidenceIds, submission.bindings.find(b => b.criterionId === verdict.criterionId)!.evidenceIds)) throw new Error('Review evidence must match the criterion submission binding.');
    }
    const inspectionIds: string[] = [];
    if (args.accepted) {
      if (args.verdicts.some(v => v.verdict !== 'pass')) throw new Error('Acceptance requires every criterion verdict to pass.');
      if (submission.checks.some(check => check.status !== 'pass')) throw new Error('A required protected check failed or errored. Reject, revise and resubmit.');
    }
    for (const ref of submission.evidence) {
      if (args.accepted) this.verified(agentId, ref);
      const row = this.store.db.prepare('SELECT data FROM progress_inspections WHERE submission_id=? AND principal_id=? AND evidence_id=? ORDER BY rowid DESC LIMIT 1').get(submission.id, agentId, ref.id) as { data: string } | undefined;
      const receipt = row ? JSON.parse(row.data) as Inspection : undefined;
      if (args.accepted && (!receipt || receipt.sha256 !== ref.sha256)) throw new Error('Inspect every submitted evidence item with task_evidence_read before accepting.');
      if (receipt?.sha256 === ref.sha256) inspectionIds.push(receipt.id);
    }
    const evaluation: Evaluation = { ...execution, id: id('evaluation'), taskId: task.id, submissionId: submission.id, criteriaHash: criteria.sha256,
      reviewerId: agentId, accepted: args.accepted, verdicts: args.verdicts, inspectionIds, note: args.note, createdAt: nowIso() };
    this.store.db.prepare('INSERT INTO progress_evaluations VALUES(?,?,?)').run(evaluation.id, submission.id, JSON.stringify(evaluation));
    return evaluation;
  }
  get(raw: unknown) {
    const args = progressSchemas.task_get.parse(raw), task = this.store.require('tasks', args.taskId);
    const submissionId = args.submissionId ?? task.submissionId;
    const submission = submissionId ? this.submission(submissionId) : undefined;
    if (submission && submission.taskId !== task.id) throw new Error('Submission belongs to another task.');
    const row = submission ? this.store.db.prepare('SELECT data FROM progress_evaluations WHERE submission_id=?').get(submission.id) as { data: string } | undefined : undefined;
    const evaluation = row ? JSON.parse(row.data) as Evaluation : null;
    const inspections = evaluation?.inspectionIds.map(key => {
      const row = this.store.db.prepare('SELECT data FROM progress_inspections WHERE id=?').get(key) as { data: string };
      return JSON.parse(row.data) as Inspection;
    }) ?? [];
    const legacy = this.store.db.prepare('SELECT data FROM progress_legacy_tasks WHERE id=?').get(task.id) as { data: string } | undefined;
    const history = this.store.db.prepare(`SELECT s.id,s.data,e.data AS evaluation FROM progress_submissions s
      LEFT JOIN progress_evaluations e ON e.submission_id=s.id WHERE s.task_id=? ORDER BY s.rowid DESC LIMIT 6 OFFSET ?`).all(task.id, args.offset) as { id: string; data: string; evaluation?: string }[];
    return { task, criteria: this.criteria(task.id) ?? null, submission: submission ?? null, evaluation, inspections,
      legacy: !task.criteriaId, legacyRecord: legacy ? JSON.parse(legacy.data) as Task : null,
      attempts: history.slice(0, 5).map(row => { const s = JSON.parse(row.data) as Submission; return { id: s.id, round: s.round, createdAt: s.createdAt,
        checks: s.checks.map(c => ({ criterionId: c.criterionId, status: c.status })), accepted: row.evaluation ? (JSON.parse(row.evaluation) as Evaluation).accepted : null }; }),
      nextOffset: history.length > 5 ? args.offset + 5 : null };
  }
}
