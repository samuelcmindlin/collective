import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { z } from 'zod/v3';
import { id, nowIso } from '../store.js';
import { stable } from '../application/commands.js';
import { KnowledgeRepository, hashContent, citation } from './repository.js';
import type { KnowledgeDocument, KnowledgeRevision } from './types.js';

const registrationSchema = z.object({
  id: z.string().regex(/^(platform|operator)\.[a-z0-9-]+$/), path: z.string().min(1).max(500),
  namespace: z.enum(['platform', 'operator']), owner: z.literal('maintainer'), importMode: z.literal('read-only'),
  kind: z.enum(['index', 'assessment', 'research', 'design', 'plan', 'description', 'runbook', 'decision-record']),
  status: z.enum(['recorded', 'proposed', 'accepted', 'superseded', 'archived']),
  audience: z.array(z.enum(['operator', 'developer', 'agent'])).min(1), tags: z.array(z.string().max(100)).max(30),
}).strict();
export interface RegisteredSnapshot { commit: string; documents: { registration: z.infer<typeof registrationSchema>; content: string }[] }

/** Maintainer entry point only. Reads immutable Git blobs, never working-tree files or agent catalogs. */
export function readRegisteredSnapshot(root: string, commitRef = 'HEAD'): RegisteredSnapshot {
  const cwd = realpathSync(root);
  const git = (...args: string[]) => execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 2_000_000 });
  if (realpathSync(git('rev-parse', '--show-toplevel').trim()) !== cwd) throw new Error('Documentation must come from the configured platform repository root.');
  const commit = git('rev-parse', '--verify', '--end-of-options', `${commitRef}^{commit}`).trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Expected an immutable Git commit.');
  const readBlob = (path: string) => {
    if (!/^(README\.md|docs\/[A-Za-z0-9_./-]+\.(md|json))$/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Source path must be normalized inside the documentation root.');
    const tree = git('ls-tree', commit, '--', path).trim();
    if (!/^100644 blob [a-f0-9]+\t/.test(tree)) throw new Error('Registered source must be a regular non-executable Git blob; symlinks are rejected.');
    const body = git('show', `${commit}:${path}`);
    if (Buffer.byteLength(body) > 500000) throw new Error('Registered document exceeds 500 KB.');
    return body;
  };
  const catalog = z.object({ version: z.literal(1), documents: z.array(registrationSchema).min(1).max(200) }).strict().parse(JSON.parse(readBlob('docs/catalog.json')));
  const ids = new Set<string>(), paths = new Set<string>();
  const documents = catalog.documents.map(registration => {
    if (!registration.id.startsWith(`${registration.namespace}.`) || ids.has(registration.id) || paths.has(registration.path)) throw new Error('Duplicate or mismatched source registration.');
    ids.add(registration.id); paths.add(registration.path);
    return { registration, content: readBlob(registration.path) };
  });
  return { commit, documents };
}

export function importRegisteredSnapshot(repository: KnowledgeRepository, snapshot: RegisteredSnapshot) {
  return repository.store.transaction(() => {
    let created = 0, unchanged = 0, withdrawn = 0;
    const currentIds = new Set(snapshot.documents.map(d => d.registration.id));
    for (const { registration: meta, content } of snapshot.documents) {
      let doc = repository.document(meta.id);
      if (doc && (doc.namespace !== meta.namespace || doc.ownerId !== 'maintainer')) throw new Error('Source registration collides with another owner.');
      const existing = doc?.currentRevisionId ? repository.revision(doc.currentRevisionId) : undefined;
      const registrationHash = hashContent(stable(meta));
      if (doc?.status === 'current' && existing?.sha256 === hashContent(content) && existing.source.registrationHash === registrationHash) { unchanged++; continue; }
      const r: KnowledgeRevision = {
        id: id('know'), documentId: meta.id, title: content.match(/^# (.+)$/m)?.[1] ?? meta.id,
        content, kind: meta.kind, status: meta.status, sources: [`git:${snapshot.commit}:${meta.path}`], authorId: 'maintainer',
        revision: (doc?.version ?? 0) + 1, parentIds: doc?.currentRevisionId ? [doc.currentRevisionId] : [],
        sha256: hashContent(content), changeSummary: 'Imported registered maintainer snapshot.',
        source: { type: 'git', commit: snapshot.commit, path: meta.path, registrationHash }, createdAt: nowIso(),
      };
      repository.insertRevision(r);
      doc = { id: meta.id, namespace: meta.namespace, ownerId: 'maintainer', readableByAgents: meta.audience.includes('agent'),
        currentRevisionId: r.id, heads: [r.id], status: 'current', version: r.revision, createdAt: doc?.createdAt ?? r.createdAt };
      repository.saveDocument(doc);
      repository.store.event('knowledge.imported', 'maintainer', r.id, { citation: citation(r), source: r.source }); created++;
    }
    const rows = repository.store.db.prepare("SELECT data FROM knowledge_documents WHERE namespace IN ('platform','operator') AND owner_id='maintainer' AND status!='withdrawn'").all() as { data: string }[];
    for (const row of rows) {
      const doc = JSON.parse(row.data) as KnowledgeDocument;
      if (!currentIds.has(doc.id)) {
        repository.saveDocument({ ...doc, readableByAgents: false, status: 'withdrawn', version: doc.version + 1 });
        repository.store.event('knowledge.withdrawn', 'maintainer', doc.id, { commit: snapshot.commit }); withdrawn++;
      }
    }
    if (created || withdrawn) repository.changed();
    return { commit: snapshot.commit, created, unchanged, withdrawn };
  });
}
