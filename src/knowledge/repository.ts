import { z } from 'zod/v3';
import { createHash } from 'node:crypto';
import { Store, id, nowIso } from '../store.js';
import { executeCommand } from '../application/commands.js';
import { KeywordSearch, type KnowledgeSearchAdapter } from './search.js';
import type { KnowledgeDocument, KnowledgeRevision, KnowledgePrincipal, KnowledgeView } from './types.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const pageOffset = z.number().int().min(0).max(100000).default(0);
const pageLimit = z.number().int().min(1).max(20).default(10);
export const knowledgeSchemas = {
  knowledge_write: z.object({
    commandId: text(128).optional(), title: text(200), content: text(12000),
    kind: z.enum(['fact', 'hypothesis', 'decision', 'question']),
    sources: z.array(text(2000)).max(30).default([]),
    namespace: z.enum(['collective', 'agent']).optional(),
    documentId: text(150).optional(), previousId: text(150).optional(),
    resolveHeads: z.array(text(150)).min(1).max(100).optional(),
    changeSummary: text(1000).default('Recorded shared knowledge.'),
  }).strict(),
  knowledge_get: z.object({ documentId: text(150).optional(), revisionId: text(150).optional(), offset: z.number().int().min(0).max(500000).default(0), maxChars: z.number().int().min(1).max(12000).default(8000) }).strict(),
  knowledge_search: z.object({ query: z.string().trim().max(500).default(''), limit: pageLimit, offset: pageOffset }).strict(),
  knowledge_history: z.object({ documentId: text(150), offset: pageOffset, limit: pageLimit, headOffset: pageOffset }).strict(),
};
export const isKnowledgeWrite = (name: string) => name === 'knowledge_write';
export const hashContent = (content: string) => createHash('sha256').update(content).digest('hex');
export const citation = (r: KnowledgeRevision) => ({ documentId: r.documentId, revisionId: r.id, sha256: r.sha256 });

export class KnowledgeRepository {
  private indexes = new Map<string, { generation: number; adapter: KnowledgeSearchAdapter }>();
  constructor(readonly store: Store, private makeSearch: () => KnowledgeSearchAdapter = () => new KeywordSearch()) {}
  close() { for (const index of this.indexes.values()) index.adapter.close(); this.indexes.clear(); }
  generation() { return Number(this.store.db.prepare('SELECT generation FROM knowledge_generation WHERE id=1').get()!.generation); }
  changed() { this.store.db.exec('UPDATE knowledge_generation SET generation=generation+1 WHERE id=1'); }
  document(key: string): KnowledgeDocument | undefined {
    const row = this.store.db.prepare('SELECT data FROM knowledge_documents WHERE id=?').get(key) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  revision(key: string): KnowledgeRevision | undefined {
    const row = this.store.db.prepare('SELECT data FROM knowledge_revisions WHERE id=?').get(key) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  private authorized(p: KnowledgePrincipal, doc: KnowledgeDocument | undefined): doc is KnowledgeDocument {
    if (!doc) return false;
    if (p.kind === 'operator') return true;
    this.store.require('agents', p.id);
    return doc.status !== 'withdrawn' && doc.readableByAgents && (doc.namespace !== 'agent' || doc.ownerId === p.id);
  }
  requireDocument(p: KnowledgePrincipal, key: string) {
    const doc = this.document(key);
    if (!this.authorized(p, doc)) throw new Error('Knowledge not found or unavailable.');
    return doc;
  }
  saveDocument(doc: KnowledgeDocument) {
    this.store.db.prepare(`INSERT INTO knowledge_documents VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      namespace=excluded.namespace,owner_id=excluded.owner_id,readable_by_agents=excluded.readable_by_agents,
      current_revision_id=excluded.current_revision_id,status=excluded.status,data=excluded.data`).run(
      doc.id, doc.namespace, doc.ownerId, Number(doc.readableByAgents), doc.currentRevisionId ?? null, doc.status, JSON.stringify(doc));
  }
  insertRevision(revision: KnowledgeRevision) {
    this.store.db.prepare('INSERT INTO knowledge_revisions VALUES(?,?,?)').run(revision.id, revision.documentId, JSON.stringify(revision));
  }
  private view(p: KnowledgePrincipal, doc: KnowledgeDocument, r: KnowledgeRevision): KnowledgeView {
    return { ...r, namespace: doc.namespace, documentStatus: doc.status, currentRevisionId: doc.currentRevisionId, missionId: doc.missionId,
      citation: citation(r), readOnly: p.kind !== 'agent' || ['platform', 'operator'].includes(doc.namespace) || (!!doc.missionId && doc.missionId !== this.store.missionScope().missionId) };
  }
  get(p: KnowledgePrincipal, raw: unknown): KnowledgeView {
    const args = knowledgeSchemas.knowledge_get.parse(raw);
    if (!args.documentId && !args.revisionId) throw new Error('Provide documentId or revisionId.');
    const revision = args.revisionId ? this.revision(args.revisionId) : undefined;
    const doc = this.requireDocument(p, args.documentId ?? revision?.documentId ?? '');
    if (args.revisionId && (!revision || revision.documentId !== doc.id)) throw new Error('Knowledge not found or unavailable.');
    if (!revision && !doc.currentRevisionId) throw new Error(`Knowledge conflict: choose an exact revision from knowledge_history for ${doc.id}.`);
    const selected = revision ?? this.revision(doc.currentRevisionId!)!;
    if (!selected || hashContent(selected.content) !== selected.sha256) throw new Error('Knowledge revision integrity check failed.');
    return this.view(p, doc, selected);
  }
  inspect(agentId: string, raw: unknown) {
    return this.store.transaction(() => {
      const { offset, maxChars } = knowledgeSchemas.knowledge_get.parse(raw);
      const entry = this.get({ kind: 'agent', id: agentId }, raw);
      const nextOffset = offset + maxChars < entry.content.length ? offset + maxChars : null;
      this.store.event('knowledge.inspected', agentId, entry.id, { citation: entry.citation, offset, maxChars });
      return { ...entry, content: entry.content.slice(offset, offset + maxChars), totalChars: entry.content.length, nextOffset, truncated: offset > 0 || nextOffset !== null };
    });
  }
  history(p: KnowledgePrincipal, raw: unknown) {
    const args = knowledgeSchemas.knowledge_history.parse(raw);
    const doc = this.requireDocument(p, args.documentId);
    const rows = this.store.db.prepare('SELECT data FROM knowledge_revisions WHERE document_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?')
      .all(doc.id, args.limit + 1, args.offset) as { data: string }[];
    const heads = new Set(doc.heads);
    return {
      document: { ...doc, heads: doc.heads.slice(args.headOffset, args.headOffset + 20), headCount: doc.heads.length },
      revisions: rows.slice(0, args.limit).map(row => {
        const revision = JSON.parse(row.data) as KnowledgeRevision;
        return { ...this.summary(this.view(p, doc, revision)), isHead: heads.has(revision.id) };
      }),
      nextOffset: rows.length > args.limit ? args.offset + args.limit : null,
      nextHeadOffset: args.headOffset + 20 < doc.heads.length ? args.headOffset + 20 : null,
    };
  }
  private access(p: KnowledgePrincipal) {
    if (p.kind === 'operator') return { sql: '1', args: [] as string[] };
    this.store.require('agents', p.id);
    return { sql: "d.status!='withdrawn' AND d.readable_by_agents=1 AND (d.namespace!='agent' OR d.owner_id=?)", args: [p.id] };
  }
  private summary(entry: KnowledgeView) { const { content, sources: _sources, ...metadata } = entry; return { ...metadata, snippet: content.slice(0, 240) }; }
  list(p: KnowledgePrincipal, limit = 20, offset = 0) {
    pageLimit.parse(limit); pageOffset.parse(offset);
    const access = this.access(p);
    const rows = this.store.db.prepare(`SELECT d.data AS document,r.data AS revision FROM knowledge_documents d
      LEFT JOIN knowledge_revisions r ON r.id=d.current_revision_id WHERE ${access.sql}
      ORDER BY (SELECT MAX(rowid) FROM knowledge_revisions WHERE document_id=d.id) DESC, d.id
      LIMIT ? OFFSET ?`).all(...access.args, limit + 1, offset) as { document: string; revision?: string }[];
    const entries = rows.slice(0, limit).map(row => {
      const doc = JSON.parse(row.document) as KnowledgeDocument;
      if (row.revision) return this.summary(this.view(p, doc, JSON.parse(row.revision)));
      return { id: doc.id, documentId: doc.id, title: 'Conflicting legacy knowledge', namespace: doc.namespace,
        documentStatus: doc.status, headCount: doc.heads.length, snippet: 'Choose a revision from history and explicitly reconcile the competing heads.', createdAt: doc.createdAt };
    });
    return { entries, nextOffset: rows.length > limit ? offset + limit : null };
  }
  search(p: KnowledgePrincipal, raw: unknown) {
    const { query, limit, offset } = knowledgeSchemas.knowledge_search.parse(raw);
    if (!query) return { ...this.list(p, limit, offset), engine: 'catalog', freshness: 'current' as const };
    if (offset !== 0) throw new Error('Offset is supported only for an empty catalog query. Refine keywords to narrow search results.');
    const key = p.kind === 'agent' ? `agent:${p.id}` : 'operator';
    const access = this.access(p), generation = this.generation();
    // Never retain a projection of uncommitted records across rollback.
    let index = this.store.inTransaction ? undefined : this.indexes.get(key);
    const transient = this.store.inTransaction;
    try {
      if (!index || index.generation !== generation) {
        const adapter = this.makeSearch();
        try {
          const rows = this.store.db.prepare(`SELECT r.data FROM knowledge_documents d JOIN knowledge_revisions r ON r.id=d.current_revision_id
            WHERE ${access.sql} AND d.status='current'`).all(...access.args) as { data: string }[];
          adapter.replace(rows.map(row => JSON.parse(row.data)));
        } catch (error) { adapter.close(); throw error; }
        index?.adapter.close();
        index = { generation, adapter };
        if (!transient) {
          // At most one projection per configured agent plus the operator, capped for deleted identities.
          if (this.indexes.size >= 13 && !this.indexes.has(key)) { const first = this.indexes.keys().next().value!; this.indexes.get(first)!.adapter.close(); this.indexes.delete(first); }
          this.indexes.set(key, index);
        }
      }
      const hits = index.adapter.search(query, limit);
      const entries = hits.map(hit => {
        const entry = this.get(p, { revisionId: hit.revisionId });
        if (entry.id !== entry.currentRevisionId || entry.documentStatus !== 'current') throw new Error('Stale search projection.');
        return { ...this.summary(entry), snippet: hit.snippet.slice(0, 400), score: hit.score };
      });
      return { entries, nextOffset: null, engine: index.adapter.name, freshness: 'current' as const, keywordOnly: true };
    } catch (error) {
      return { entries: [], nextOffset: null, engine: 'sqlite-fts5-keyword', freshness: 'unavailable' as const,
        error: error instanceof Error ? error.message : 'Search unavailable. Use exact reads.', keywordOnly: true };
    } finally { if (transient) index?.adapter.close(); }
  }
  packet(agentId: string) {
    const result = this.list({ kind: 'agent', id: agentId }, 10);
    return { entries: result.entries, moreAvailable: result.nextOffset !== null, retrieval: 'Use knowledge_search for older relevant records; knowledge_get returns exact cited revisions. Summaries are not complete documents.',
      manifest: result.entries.flatMap(entry => 'citation' in entry ? [{ ...entry.citation, selection: 'recent', truncated: true }] : []) };
  }
  write(agentId: string, raw: unknown, invocationId?: string): KnowledgeView {
    const args = knowledgeSchemas.knowledge_write.parse(raw);
    if (args.commandId && invocationId && args.commandId !== invocationId) throw new Error('Command ID differs between tool and envelope.');
    const { commandId: supplied, ...payload } = args;
    const commandId = supplied ?? invocationId ?? id('cmd');
    return this.store.transaction(() => {
      this.store.require('agents', agentId);
      const scope = this.store.missionScope();
      if (!scope.missionId) throw new Error('No active mission.');
      return executeCommand(this.store, { principalId: agentId, commandId, name: 'knowledge_write', missionId: scope.missionId }, { ...scope, ...payload }, () => {
        const p: KnowledgePrincipal = { kind: 'agent', id: agentId };
        const previous = args.previousId ? this.get(p, { revisionId: args.previousId }) : undefined;
        let doc = args.documentId || previous ? this.requireDocument(p, args.documentId ?? previous!.documentId) : undefined;
        if (previous && previous.documentId !== doc?.id) throw new Error('Previous revision belongs to another document.');
        if (doc) {
          if (['platform', 'operator'].includes(doc.namespace)) throw new Error('Protected documents are read-only. Propose a maintainer change separately.');
          if (doc.missionId && doc.missionId !== scope.missionId) throw new Error('Historical mission knowledge is read-only. Create a new sourced note.');
          if (args.namespace && args.namespace !== doc.namespace) throw new Error('A revision cannot change document visibility.');
          if (doc.status === 'conflicted') {
            if (!args.resolveHeads || new Set(args.resolveHeads).size !== args.resolveHeads.length || [...args.resolveHeads].sort().join('\n') !== [...doc.heads].sort().join('\n')) throw new Error('Knowledge conflict: explicitly supply every current resolveHeads revision.');
          } else if (args.resolveHeads || !previous || previous.id !== doc.currentRevisionId) {
            throw new Error(`Knowledge revision conflict: expected previousId ${doc.currentRevisionId}. Read the current document before editing.`);
          }
        } else {
          if (args.resolveHeads) throw new Error('Conflict resolution requires an existing document.');
          doc = { id: id('doc'), namespace: args.namespace ?? 'collective', ownerId: agentId, readableByAgents: true,
            ...scope, heads: [], status: 'current', version: 0, createdAt: nowIso() };
        }
        const parents = args.resolveHeads ?? (previous ? [previous.id] : []);
        const r: KnowledgeRevision = { id: id('know'), documentId: doc.id, title: args.title, content: args.content,
          kind: args.kind, status: 'recorded', sources: args.sources, authorId: agentId, revision: doc.version + 1,
          parentIds: parents, sha256: hashContent(args.content), changeSummary: args.changeSummary, source: { type: 'note' }, createdAt: nowIso() };
        this.insertRevision(r);
        doc = { ...doc, status: 'current', currentRevisionId: r.id, heads: [r.id], version: doc.version + 1 };
        this.saveDocument(doc); this.changed();
        this.store.event('knowledge.published', agentId, r.id, { title: r.title, citation: citation(r), parentIds: r.parentIds });
        return this.view(p, doc, r);
      });
    });
  }
}
