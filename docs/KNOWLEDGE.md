# Knowledge, memory, and evidence

Status: target architecture, partially implemented. The current
[knowledge increment](KNOWLEDGE-IMPLEMENTATION.md) adds immutable revisions, keyword
retrieval, protected Git-source import and access rules. Broader graphs, semantic
retrieval, durable context manifests and criterion-bound evaluation remain proposed.
See [assessment R3](ASSESSMENT.md) for the reproduced retrieval and revision gaps.

## One library, several kinds of memory

Knowledge management should be part of the next foundation pass. Agents must be
able to recover an earlier decision, explain its origin, challenge it, and hand
work to a fresh session. Adding a vector database alone would not provide these
properties.

| Layer | Purpose | Treatment |
| --- | --- | --- |
| Conversation and activity | What happened, who heard it, tool and delivery receipts | Append-only records; searchable with access checks; not automatically accepted knowledge |
| Working memory | Current approach, unfinished work, checkpoint and handoff | Mutable through revisions; short, scoped, replaceable; points to durable evidence |
| Curated knowledge | Claims, decisions, questions, procedures, lessons | Stable document identity; immutable revisions; provenance and review state |
| Evidence and artifacts | Source snapshots, code versions, test results, deliverables | Immutable content and hashes; links to the exact criterion evaluated |
| Platform and operator documents | Architecture, runbooks, approved boundaries, proposed changes | Registered sources with protected ownership; visible status and source revision |

The same search interface can discover all five. Searchability does not confer
trust, factual correctness, or authority to execute an instruction.

## Authority and visibility

| Namespace | Canonical writer | Agent behavior |
| --- | --- | --- |
| `platform` | Maintainer's registered source repository | Read approved source snapshots; propose changes through a separate candidate |
| `operator` | Operator | Read explicitly shared goals, feedback, and policies; request clarification or amendment |
| `collective/<id>` | Authorized collective members | Create and revise shared working knowledge under mission policy |
| `project/<id>` | Authorized project members | Record project decisions, experiments, code references and handoffs |
| `agent/<id>` | That agent and authorized operator | Maintain private working notes; explicitly publish useful shared conclusions |

Document kind, approval state, confidence, and security authority are distinct
fields. An accepted agent decision does not become platform policy. A maintainer
document can describe an unimplemented proposal. A web source is external content
even if it contains words such as “system instruction.”

Authorization comes from the authenticated principal and registered source
binding, never from text, front matter, directory names supplied by an agent, or
a copied catalog. Filter access before ranking, snippets, counts, or context
assembly so restricted document existence is not leaked through search metadata.
Room presence governs live attention; historical knowledge access follows its
own explicit policy.

## Identity, versions, and canonical sources

Use a stable `document_id` and separate immutable `revision_id`. A revision holds
its parent, body/blob hash, author principal, source, creation time, and change
summary. A document holds its namespace, kind, visibility, current revision,
lifecycle state, mission/project bindings, and optimistic-concurrency version.

Revising requires the expected current revision. Two concurrent edits cannot
silently become two equally current “revision 2” entries: the second gets a
conflict with the intervening revision. Save its proposal if useful, then merge
explicitly. Citation references retain the original revision; “latest” is a
separate convenience lookup. Superseded knowledge remains inspectable.

There must be one editable source for each document:

- Platform Markdown remains canonical in its registered repository. The importer
  creates read-only knowledge revisions and records the approved commit or
  source snapshot hash. Knowledge edits create proposals against that source.
- Collective-authored notes are canonical database revisions. Markdown exports
  are derived views, unless ownership is explicitly transferred to a repository.
- Artifacts and source captures are immutable blobs. Indexes and summaries can
  be rebuilt; they never replace the cited original.

The [documentation catalog](catalog.json) establishes stable identities now.
It is a manifest of sources consumed by the implemented Git-snapshot importer.
The importer reads the configured platform repository at its committed HEAD,
rejects escaping paths/symlinks, computes content hashes and preserves ownership.
Proposed design documents remain labelled proposed when imported. Catalog
metadata cannot install an execution policy.

## Storage and retrieval contract

Use typed SQLite records for our canonical contracts and a rebuildable search
adapter. The follow-up [research](RESEARCH.md) and [integration design](designs/02-knowledge.md)
compare QMD, a minimal FTS5 baseline and Basic Memory before selecting an engine.
Direct FTS5 is a baseline candidate, not a committed custom-search implementation. The installed
Node SQLite build was checked and supports FTS5. FTS5 supplies lexical full-text
search, ranking and snippets; its relevance to this design is an engineering
choice, not a claim that keyword search solves every retrieval task.
[SQLite FTS5 documentation](https://sqlite.org/fts5.html).

| Record | Important fields and relationships |
| --- | --- |
| `documents` | Stable identity, namespace, kind, owner, current revision, lifecycle, visibility, version |
| `document_revisions` | Document, parent, immutable body/hash, author, source reference, timestamps |
| `sources` | Source type, registered binding, repository/path/commit or URL capture, fetched time, trust classification |
| `document_links` | Typed links: supports, contradicts, supersedes, depends-on, derived-from; exact revisions where material |
| `document_bindings` | Mission revision, task, room pin, project, experiment or artifact association |
| `evaluations` | Criterion version, evidence revision/hash, evaluator identity/version, method, result, limitations |
| Search projection | Authorized searchable text and revision IDs; engine-specific, rebuildable from canonical records |

Access grants can be namespace/project-level initially. Do not implement complex
per-paragraph ACLs before a use case demands them. Relations can be ordinary SQL
edges; no separate graph database is needed for these lookups.

An episode's retrieval sequence is:

1. Authenticate its run, mission revision and project scope.
2. Include a small pinned packet: mission, constraints, current work, applicable
   platform contracts, and unresolved requests. Budget these explicitly.
3. Search authorized current knowledge by query, exact identifier, kind, project
   and mission, with bounded result limits. Include explicitly requested history.
4. Expand selected revisions and their evidence references within the remaining
   context budget. Return citations and visible truncation information.
5. Save the context manifest with the run: source revision IDs, selection reasons,
   omitted items and size. This permits debugging a missed or stale decision.

Relevance must not be a hard “newest 30” cutoff. Keep conversation excerpts
separate from curated decisions. When context fills, the agent can perform a
focused search or retrieve an exact revision. A fresh agent must be able to take
over without the original Claude transcript.

Proposed tools, with schemas and bounded results:

```text
knowledge.search(query, filters, limit, cursor)
knowledge.get(document_id, revision_id?)
knowledge.create(namespace, kind, body, source_refs, bindings)
knowledge.revise(document_id, expected_revision_id, body, change_summary)
knowledge.link(from_revision, relationship, to_revision)
knowledge.propose_change(protected_document_id, base_revision_id, proposal)
```

The registered-source importer is a maintainer operation, not an agent write
tool. Search and document tools do not execute code or change capabilities.
Add embeddings only if a retrieval evaluation shows material misses that lexical
search and metadata cannot fix. External embedding calls would also need an
approved data destination and budget.

## Knowledge lifecycle and proof of progress

Useful lifecycle states are `proposed`, `accepted`, `disputed`, `superseded`, and
`archived`. Imported descriptive records can use `recorded` without pretending to
be a normative decision. Transitions have an author and reason. Retain competing
claims and contradictions; do not silently overwrite the unsuccessful hypothesis.

A reviewer must bind their verdict to the criterion version and exact evidence
they evaluated. For executable claims, preserve a test receipt containing the
code commit/hash, check version, environment, exit status and output. Tests written
by an agent are useful evidence, but are not an independent guarantee: required
platform checks and acceptance rubrics cannot be weakened by the candidate under
review. Subjective criteria stay explicitly subjective and can require operator
acceptance. Agent consensus is not a substitute for observation.

Illustrative game chain (a proposed record structure, not an additional completed
experiment):

```text
Mission revision: create a playable game
  Criterion: a fresh session can finish one round without an exception
    Experiment: run the specified browser interaction against candidate commit
      Evidence: immutable HTML/build + interaction log + observed outcome
        Evaluation: pass/fail, check revision, limitations
          Decision: accept candidate, fix failure, or revise approach
```

Record output quality, criterion coverage, failed experiments, unresolved
assumptions, consumed allowance and human intervention alongside accepted work.
For broad missions, agents can propose an operational definition and initial
experiments while keeping the original mission and its ambiguity visible. A
revised proxy cannot silently redefine what the operator asked them to achieve.

## First implementation acceptance gates

- An older relevant decision remains retrievable after thousands of newer notes.
- Concurrent revisions produce a conflict or explicit merge, never two implicit
  current versions. Citations remain stable after revision and supersession.
- Search, snippets and context respect namespace/project permissions, including
  adversarial metadata pretending to be platform policy.
- Registered core Markdown imports reproducibly and remains read-only to agents;
  a copied manifest cannot acquire its authority.
- A fresh session can locate a task's constraints, evidence and unfinished work.
- An incorrect claim can be traced to its source and disputed without erasing
  history. A test result identifies exactly which candidate it evaluated.
- Rebuilding the search index does not lose documents, permissions or citations.

Implement these with the transaction and migration foundation in the
[plan](PLAN.md); avoid adding an unrelated memory service beside the current store.
