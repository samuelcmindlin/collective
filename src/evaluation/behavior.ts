import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { hashRecord } from '../progress/checks.js';
import { readArtifactSnapshot } from '../storage/artifacts.js';
import type { Artifact } from '../types.js';
import type { Submission } from '../progress/types.js';
import type { DockerSandbox, SandboxResult } from './docker.js';

export interface BehaviorCase { id: string; input: unknown; expected: unknown }
export interface BehaviorPolicy { id: string; criterionId: string; cases: BehaviorCase[]; limitations: string[] }

export function judgeOutput(run: SandboxResult, expected: unknown): { status: 'pass' | 'fail' | 'error'; reason: string } {
  if (run.error || run.stopped || !run.cleanupVerified || !run.state || run.state.oomKilled) {
    return { status: 'error', reason: run.error ?? run.stopped ?? 'Unverified execution or cleanup.' };
  }
  if (run.code !== 0 || run.state.exitCode !== 0) return { status: 'fail', reason: 'Candidate exited unsuccessfully.' };
  try {
    return isDeepStrictEqual(JSON.parse(run.stdout), expected)
      ? { status: 'pass', reason: 'Output matched the protected example.' }
      : { status: 'fail', reason: 'Output differs from the protected example.' };
  } catch { return { status: 'fail', reason: 'Candidate output was not one JSON value.' }; }
}

/** Frozen ledger evidence is the only code source. This never imports candidate code. */
export async function evaluateCandidate(dataDir: string, artifact: Artifact, submission: Submission,
  policy: BehaviorPolicy, sandbox: Pick<DockerSandbox, 'run' | 'image' | 'policyHash'>) {
  const ref = submission.evidence.find(e => e.id === artifact.id);
  const binding = submission.bindings.find(b => b.criterionId === policy.criterionId);
  if (ref?.kind !== 'artifact' || ref.sha256 !== artifact.sha256 || ref.size !== artifact.size ||
      ref.mime !== artifact.mime || !binding?.evidenceIds.includes(artifact.id)) throw new Error('Candidate must match exact submitted artifact evidence and criterion.');
  if (!policy.cases.length || policy.cases.length > 12 || new Set(policy.cases.map(c => c.id)).size !== policy.cases.length ||
      Buffer.byteLength(JSON.stringify(policy)) > 32_000) throw new Error('Invalid or oversized behavior policy.');
  // Copy mutable caller inputs before the first await; later changes cannot rebind this experiment.
  const frozen = structuredClone({ policy, taskId: submission.taskId, submissionId: submission.id,
    criteriaHash: submission.criteriaHash, artifact: ref });
  const bytes = readArtifactSnapshot(dataDir, artifact);
  const results = [];
  for (const example of frozen.policy.cases) {
    const run = await sandbox.run(Buffer.from(bytes), JSON.stringify(example.input));
    results.push({ caseId: example.id, inputHash: hashRecord(example.input), expectedHash: hashRecord(example.expected),
      ...judgeOutput(run, example.expected), execution: { container: run.container, code: run.code, state: run.state,
        stopped: run.stopped, cleanupVerified: run.cleanupVerified, error: run.error,
        stdoutHash: createHash('sha256').update(run.stdout).digest('hex'),
        stderrHash: createHash('sha256').update(run.stderr).digest('hex') } });
    if (!run.cleanupVerified) break; // Unknown live work is a stop condition, not a reason to dispatch more.
  }
  const record = { version: 1, authority: 'maintainer-rehearsal' as const, createdAt: new Date().toISOString(),
    taskId: frozen.taskId, submissionId: frozen.submissionId, criteriaHash: frozen.criteriaHash,
    artifact: frozen.artifact, checkId: frozen.policy.id, criterionId: frozen.policy.criterionId,
    policyHash: hashRecord(frozen.policy), image: sandbox.image, containerPolicyHash: sandbox.policyHash,
    status: results.length !== frozen.policy.cases.length || results.some(r => r.status === 'error') ? 'error' :
      results.some(r => r.status === 'fail') ? 'fail' : 'pass', results, limitations: frozen.policy.limitations };
  return { ...record, sha256: hashRecord(record) };
}
