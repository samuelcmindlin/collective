import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Knowledge } from '../types.js';
import type { KnowledgeDocument, KnowledgeRevision } from '../knowledge/types.js';

export const knowledgeSchema = `
CREATE TABLE knowledge_documents(id TEXT PRIMARY KEY, namespace TEXT NOT NULL, owner_id TEXT NOT NULL, readable_by_agents INTEGER NOT NULL, current_revision_id TEXT, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE knowledge_revisions(id TEXT PRIMARY KEY, document_id TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX knowledge_revisions_document ON knowledge_revisions(document_id);
CREATE INDEX knowledge_documents_access ON knowledge_documents(namespace,owner_id,readable_by_agents,status);
CREATE TABLE knowledge_generation(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL);
INSERT INTO knowledge_generation VALUES(1,0);
CREATE TRIGGER knowledge_revision_no_update BEFORE UPDATE ON knowledge_revisions BEGIN SELECT RAISE(ABORT,'Knowledge revisions are immutable'); END;
CREATE TRIGGER knowledge_revision_no_delete BEFORE DELETE ON knowledge_revisions BEGIN SELECT RAISE(ABORT,'Knowledge revisions are immutable'); END;
`;

/** Keep original entity bytes and IDs for history; the revision ledger is canonical after migration. */
export function migrateLegacyKnowledge(db: DatabaseSync) {
  const notes = (db.prepare("SELECT data FROM entities WHERE collection='knowledge'").all() as { data: string }[]).map(r => JSON.parse(r.data) as Knowledge);
  const byId = new Map(notes.map(n => [n.id, n]));
  const neighbors = new Map(notes.map(n => [n.id, new Set<string>()]));
  for (const n of notes) if (n.previousId && byId.has(n.previousId)) {
    neighbors.get(n.id)!.add(n.previousId); neighbors.get(n.previousId)!.add(n.id);
  }
  const visited = new Set<string>();
  for (const note of notes) {
    if (visited.has(note.id)) continue;
    const component: Knowledge[] = [], pending = [note.id];
    while (pending.length) {
      const key = pending.pop()!; if (visited.has(key)) continue;
      visited.add(key); component.push(byId.get(key)!); pending.push(...neighbors.get(key)!);
    }
    component.sort((a, b) => a.id.localeCompare(b.id));
    const roots = component.filter(n => !n.previousId || !byId.has(n.previousId));
    const root = roots[0] ?? component[0]!;
    const documentId = `legacy:${root.id}`;
    const parentIds = new Set(component.map(n => n.previousId));
    const heads = component.filter(n => !parentIds.has(n.id)).map(n => n.id);
    const missingParent = component.some(n => n.previousId && !byId.has(n.previousId));
    const conflict = heads.length !== 1 || roots.length !== 1 || missingParent;
    const document: KnowledgeDocument = {
      id: documentId, namespace: 'collective', ownerId: root.authorId, readableByAgents: true,
      currentRevisionId: conflict ? undefined : heads[0], heads: heads.length ? heads : component.map(n => n.id),
      status: conflict ? 'conflicted' : 'current', version: component.length, createdAt: root.createdAt,
    };
    db.prepare('INSERT INTO knowledge_documents VALUES(?,?,?,?,?,?,?)').run(document.id, document.namespace, document.ownerId, 1, document.currentRevisionId ?? null, document.status, JSON.stringify(document));
    for (const n of component) {
      const revision: KnowledgeRevision = {
        id: n.id, documentId, title: n.title, content: n.content, kind: n.kind, status: 'recorded',
        sources: n.sources, authorId: n.authorId, revision: n.revision, parentIds: n.previousId ? [n.previousId] : [],
        sha256: createHash('sha256').update(n.content).digest('hex'), changeSummary: 'Imported legacy note; original provenance retained.',
        source: { type: 'legacy' }, createdAt: n.createdAt,
      };
      db.prepare('INSERT INTO knowledge_revisions VALUES(?,?,?)').run(revision.id, documentId, JSON.stringify(revision));
    }
  }
  db.exec("UPDATE knowledge_generation SET generation=1; UPDATE entities SET data=json_set(data,'$.paused',json('true')) WHERE collection='settings' AND id='settings';");
}
