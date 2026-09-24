export type EvidenceKind = 'artifact' | 'knowledge' | 'either';
export type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';
export type Criterion = { id: string; description: string; evidenceKind: EvidenceKind } & (
  { method: 'judgment' } | { method: 'json.fields.v1'; evidenceKind: 'artifact'; fields: { name: string; type: FieldType }[] }
);
export interface ExecutionRef { jobId?: string; attempt?: number }
export interface CriteriaSet {
  id: string; taskId: string; missionId: string; missionRevision: number; version: 1;
  authorId: string; authority: 'agent-proposed' | 'legacy'; criteria: Criterion[]; sha256: string; createdAt: string;
}
export type EvidenceRef = { id: string; sha256: string } & (
  { kind: 'artifact'; size: number; mime: string } | { kind: 'knowledge'; documentId: string }
);
export interface EvidenceBinding { criterionId: string; evidenceIds: string[] }
export interface CheckResult {
  criterionId: string; checkId: 'json.fields.v1'; policyHash: string; evaluator: 'platform';
  status: 'pass' | 'fail' | 'error'; results: { evidenceId: string; status: 'pass' | 'fail' | 'error'; message: string }[];
}
export interface Submission extends ExecutionRef {
  id: string; taskId: string; missionId: string; missionRevision: number; criteriaId: string; criteriaHash: string;
  authorId: string; round: number; bindings: EvidenceBinding[]; evidence: EvidenceRef[];
  checks: CheckResult[]; note: string; limitations: string[]; createdAt: string;
}
export interface Verdict { criterionId: string; verdict: 'pass' | 'fail' | 'uncertain'; evidenceIds: string[]; rationale: string }
export interface Evaluation extends ExecutionRef {
  id: string; taskId: string; submissionId: string; criteriaHash: string; reviewerId: string;
  accepted: boolean; verdicts: Verdict[]; inspectionIds: string[]; note: string; createdAt: string;
}
export interface Inspection extends ExecutionRef {
  id: string; submissionId: string; principalId: string; evidenceId: string; sha256: string;
  offset: number; returnedChars: number; totalChars?: number; mode: 'text' | 'binary-metadata'; createdAt: string;
}
