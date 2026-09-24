import { DatabaseSync } from 'node:sqlite';
import type { KnowledgeRevision } from './types.js';

export interface SearchHit { revisionId: string; score: number; snippet: string }
/** Receives only already-authorized current revisions. Indexes never establish authority. */
export interface KnowledgeSearchAdapter {
  readonly name: string;
  replace(revisions: KnowledgeRevision[]): void;
  search(query: string, limit: number): SearchHit[];
  close(): void;
}

export class KeywordSearch implements KnowledgeSearchAdapter {
  readonly name = 'sqlite-fts5-keyword';
  private db = new DatabaseSync(':memory:');
  constructor() { this.db.exec('CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED,title,body,tokenize="unicode61");'); }
  replace(revisions: KnowledgeRevision[]) {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM search');
      const insert = this.db.prepare('INSERT INTO search VALUES(?,?,?)');
      for (const r of revisions) insert.run(r.id, r.title, r.content);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  search(query: string, limit: number): SearchHit[] {
    // Literal tokens only: caller text cannot become FTS syntax or a SQL expression.
    const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!tokens.length) return [];
    if (tokens.length > 24) throw new Error('Use at most 24 search keywords.');
    const expression = tokens.map(word => `"${word}"`).join(' AND ');
    return this.db.prepare(`SELECT id AS revisionId, bm25(search) AS score,
      snippet(search,2,'','',' … ',40) AS snippet FROM search WHERE search MATCH ?
      ORDER BY score,id LIMIT ?`).all(expression, limit) as unknown as SearchHit[];
  }
  close() { this.db.close(); }
}
