export interface KnowledgeDocument {
  id: string;
  namespace: 'collective' | 'agent' | 'platform' | 'operator';
  ownerId: string;
  readableByAgents: boolean;
  missionId?: string;
  currentRevisionId?: string;
  heads: string[];
  status: 'current' | 'conflicted' | 'withdrawn';
  version: number;
  createdAt: string;
}
export interface KnowledgeRevision {
  /** Revision IDs remain valid evidence IDs, including migrated legacy note IDs. */
  id: string;
  documentId: string;
  title: string;
  content: string;
  kind: string;
  status: 'recorded' | 'proposed' | 'accepted' | 'superseded' | 'archived';
  sources: string[];
  authorId: string;
  revision: number;
  parentIds: string[];
  sha256: string;
  changeSummary: string;
  source: { type: 'note' | 'legacy' | 'git'; commit?: string; path?: string; registrationHash?: string };
  createdAt: string;
}
export interface Citation { documentId: string; revisionId: string; sha256: string }
export interface KnowledgeView extends KnowledgeRevision {
  namespace: KnowledgeDocument['namespace'];
  documentStatus: KnowledgeDocument['status'];
  currentRevisionId?: string;
  missionId?: string;
  citation: Citation;
  readOnly: boolean;
}
export type KnowledgePrincipal = { kind: 'agent'; id: string } | { kind: 'operator' };
