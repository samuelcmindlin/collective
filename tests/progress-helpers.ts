import type { CollectiveService } from '../src/service.js';

/** Supply explicit criterion bindings for tests whose subject is another boundary. */
export function reviewFields(service: CollectiveService, taskId: string, accepted = true) {
  const { submission } = service.progress.get({ taskId });
  if (!submission) throw new Error('Fixture must submit before review.');
  return { submissionId: submission.id, verdicts: submission.bindings.map(binding => ({ ...binding,
    verdict: accepted ? 'pass' as const : 'fail' as const, rationale: 'Deterministic test fixture judgment.' })) };
}
export async function inspectSubmission(service: CollectiveService, agentId: string, taskId: string) {
  const { submission } = service.progress.get({ taskId });
  if (!submission) throw new Error('Fixture must submit before inspection.');
  for (const evidence of submission.evidence) await service.tool(agentId, 'task_evidence_read', { submissionId: submission.id, evidenceId: evidence.id });
}
