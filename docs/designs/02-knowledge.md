# Design 2: Knowledge contracts and reusable retrieval

Status: proposed implementation design. Refines [knowledge architecture](../KNOWLEDGE.md)
and plan slices 2–3. No external knowledge engine has been installed. The prior
direct-FTS implementation choice becomes a baseline candidate pending the spike.

## Decision to test

Compare QMD as a search component with a minimal FTS5 baseline. Basic Memory is
the alternative if adopting a fuller Markdown workflow removes substantial work.
The capability and license comparison is in [research](../RESEARCH.md); this
document specifies Collective's integration requirements independently of a vendor.

We own mission/evidence relationships, protected source registration, immutable
revision identity and authorization. Reuse parsing, indexing, search and optional
ranking. Avoid rebuilding an editor, wiki or general-purpose knowledge graph.

## Canonical write and indexing protocol

```text
registered Markdown source OR authorized knowledge command
  -> immutable revision + current pointer + indexing intent (one transaction)
  -> approved revision export into isolated index staging
  -> search adapter indexes content and acknowledges generation
  -> search hit maps back to exact canonical revision
```

Platform Markdown has one canonical source: a maintainer-approved snapshot.
Collective notes initially use the revision ledger as canonical storage with
Markdown exports. If we adopt Basic Memory as the editable note store instead,
all writes must pass through one revision-aware adapter with a documented commit
and conflict protocol. Do not enable bidirectional editing and merely hope the
database and file watcher agree. A failed CAS or two-master recovery experiment
rejects that adoption path for the first milestone.

An indexing failure never rolls back accepted knowledge. It creates a retryable
indexing intent and a visible freshness state. Exact authorized revision lookup
still works while search is unavailable. Deletion/revocation is enforced by the
canonical access layer immediately, even if the index is stale.

## Adapter contract

```ts
interface SearchRequest {
  query: string;
  indexGeneration: string;
  allowedPartitions: string[]; // Derived by platform authorization
  limit: number;             // Enforced maximum, e.g. 20
}
interface SearchHit {
  documentId: string;
  revisionId: string;
  sourceHash: string;
  score: number;
  matchingRanges: Array<{ start: number; end: number }>;
}
interface KnowledgeSearchAdapter {
  index(snapshot: ApprovedIndexSnapshot): Promise<IndexReceipt>;
  search(request: SearchRequest): Promise<SearchHit[]>;
  health(): Promise<IndexHealth>;
}
// Snapshot/receipt/health are platform contracts to implement, not upstream APIs.
```

The adapter uses an explicit data directory and fixed configuration. Disable
automatic discovery of agent-authored project settings and plugins. A pinned
package cannot auto-upgrade during a run. No worker receives a raw privileged
search or note-editing endpoint.

For protected projects, use separate indexes/partitions and select them before
search. Filtering top-k hits from a mixed privileged index is insufficient:
restricted content can affect ranking, counts and generated query expansions.
Reauthorize returned document IDs and obtain content from canonical revisions;
never trust a search snippet's metadata to establish identity or policy.

## Context, citations and freshness

Include mission/constraints and pinned contracts first, then assignment-specific
search results under a fixed context budget. Record the exact source manifest
for each run. A citation resolves document + revision + hash, even after renames.
Maintain visible distinction between proposed designs, accepted decisions and
unverified observations. Neither a search score nor a graph edge is confidence
that the claim is true.

When the adapter lags, return its generation/freshness and permit exact lookup of
new revisions. Never silently substitute an obsolete platform contract. Keep
source hashes and revision IDs outside generated summaries.

## Reuse experiment and decision rule

Use the same frozen export, queries, labels and access partitions for every
candidate. The fixture should include core docs, synthetic project notes, older
constraints, conflicting/superseded claims, lexical paraphrases and a restricted
project. Add an intentionally unanswered question to measure false confidence.

Measure recall@5, reciprocal rank, citation correctness, forbidden-result leakage,
index/update time, cold/warm query latency, disk/RAM, model downloads and external
requests. Retrieval quality is not a document-count benchmark. Record exact
package/model versions and hashes alongside the fixture.

Mandatory gates: zero unauthorized content, stable exact citations, reproducible
rebuild, stale-index detection and a successful fresh-session handoff. Compare
query quality and integration effort only after those gates pass. A first target
is recall@5 of at least 0.9 on the small labelled fixture; it is a gate to refine
on realistic tasks, not a general accuracy claim.

Start with no inference in the index. Enable a candidate's semantic path only if
it fixes observed paraphrase misses at acceptable local resource cost. A separate
model endpoint cannot consume subscription/API allowance invisibly.

Adopt QMD if it meets the contract and reduces implementation/maintenance work.
Adopt Basic Memory's fuller workflow only if its canonical-write and permission
integration also pass. Keep the minimal baseline if neither earns its operational
cost. No dependency has been selected simply because its README advertises MCP.

## First deliverable and migration

Ship searchable registered core docs, exact revision reads, versioned agent notes
and visible source status in the existing Library. Retain the existing tool names
as adapters during migration; add search/read/conflict responses explicitly.
Migrate existing note chains without discarding competing children: mark conflicts
for review rather than inventing one current truth. Indexes remain disposable.

Then connect task evidence and experiment records from [design 4](04-progress.md).
Do not add automatic conversation-to-fact extraction until a measured task needs
it and the extraction's uncertainty, provenance and inference cost are recorded.
