# Collective engineering library

The first implementation is a vertical slice. The documents below distinguish
observed behavior from the architecture proposed for the next iteration. A design
document is not a claim that its interfaces or safeguards already exist.

## Start here

| Document | Purpose | Status |
| --- | --- | --- |
| [Fixed MCP scope](MCP-SCOPE.md) | Real gateway tool-scope checks before/after VM restart and the remaining bridge requirements | Synthetic integration passed |
| [Worker review](REVIEW-2026-09-24.md) | Rehearsal defects, fixes and stricter containment evidence | 123 tests and 67 VM checks passed |
| [Isolation architecture](ISOLATION.md) | Trust boundaries, containers versus microVMs, threat model and explicit limits | Architecture and acceptance contract |
| [Worker VM rehearsal](WORKER-REHEARSAL.md) | Initial evidence, remaining host integrations and bounded episode design | Initial report superseded by worker review; live gate closed |
| [Isolation and behavioral rehearsal](ISOLATION-REHEARSAL.md) | Candidate containment evidence, lifecycle fixes and the remaining whole-worker gate | Controlled fixture rehearsal |
| [Criterion-bound evaluation](PROGRESS-IMPLEMENTATION.md) | Frozen criteria, immutable attempts, protected data checks and independent judgments | Implemented first increment |
| [Knowledge and evidence review](REVIEW-2026-09-23.md) | Reproduced defects, corrections, verification and remaining boundaries | Completed review |
| [Shared knowledge implementation](KNOWLEDGE-IMPLEMENTATION.md) | Versioned records, source import, keyword retrieval and remaining gates | Implemented bounded increment |
| [Core foundation implementation](FOUNDATION.md) | Shipped guarantees, retry limits, migration and verification | Implemented first increment |
| [Architecture assessment](ASSESSMENT.md) | What is sound, reproduced gaps, and limits of the tests | Recorded baseline |
| [High-level architecture](HLA.md) | Components, ownership, execution flows, and scaling boundaries | Proposed |
| [Knowledge system](KNOWLEDGE.md) | Durable memory, core documentation, retrieval, provenance, and evaluation | Proposed |
| [Safe evolution](EVOLUTION.md) | Agent projects, world extensions, and platform change proposals | Proposed |
| [Implementation plan](PLAN.md) | Ordered changes with acceptance gates | Proposed |
| [Prototype decisions](ARCHITECTURE.md) | The original implementation and reuse rationale | Descriptive |
| [Operator setup](../README.md) | Running the current app and connecting accounts | Descriptive |

## Research and implementation designs

The [research memo](RESEARCH.md) compares reusable knowledge systems, workflow
engines, sandbox options and evaluation tools. It updates the initial proposal:
the [lexical screening](KNOWLEDGE-IMPLEMENTATION.md#retrieval-experiment-and-provisional-choice) now records a provisional keyword baseline and the semantic retrieval gap.

| Design | Concrete decisions and acceptance experiments |
| --- | --- |
| [1. Reliable execution](designs/01-execution.md) | Command receipts, transactions, leases, external effects and Discord recovery |
| [2. Knowledge integration](designs/02-knowledge.md) | Canonical writes, replaceable search, source authority and reuse evaluation |
| [3. Isolated workspaces and PRs](designs/03-workspaces-prs.md) | When isolation is needed, worker compatibility, immutable candidates and publication |
| [4. Progress and live validation](designs/04-progress.md) | Criteria, protected checks, independent review, comparison trials and stopping rules |

The four designs are targets with implementation tracked in the
[foundation record](FOUNDATION.md) and [knowledge record](KNOWLEDGE-IMPLEMENTATION.md).
The suite covers fault injection, knowledge boundaries and six offline GitHub
protocol tests. The maintainer repository is connected to GitHub; the agent GitHub
broker and Discord remain unconfigured. QMD was tested in a
temporary directory; the application has no new knowledge dependency.

## Decision records

- [ADR-001: One application with explicit module boundaries](decisions/001-modular-application.md)
- [ADR-002: Shared discovery with separate authority](decisions/002-knowledge-authority.md)
- [ADR-003: Develop freely; activate through a controlled release path](decisions/003-controlled-evolution.md)

These ADRs are recommendations for review, not a record of user approval.

## How these documents fit the knowledge system

[catalog.json](catalog.json) gives each document a stable ID, namespace, owner,
status and audience. Markdown in Git remains the editable source. At startup,
the importer reads the committed HEAD snapshot, creates immutable revisions for
changed registered sources, and preserves proposed/recorded status. Uncommitted
edits are not imported. Agents can search and read these snapshots, but cannot
edit protected sources through knowledge tools or promote their own metadata.
See the [implementation contract](KNOWLEDGE-IMPLEMENTATION.md) for access rules,
withdrawal, migration and retrieval limits.

Run `npm run docs:check` to validate catalog fields, IDs, source paths, coverage,
and local Markdown links. Run `npm run build` and then
`node scripts/review-probes.mjs` to reproduce the assessment's domain probes.
Those probes use isolated in-memory databases and are informational; they do not
require defects to remain present for a test suite to pass.

## Maintenance

Update this library alongside behavior changes. Each implementation PR should
identify affected contracts and close the corresponding acceptance gate in the
plan. Keep proposed and implemented states distinct. Record consequential choices
in an ADR; use ordinary issue/task records for implementation work. Do not copy
API keys, account credentials, or private operator notes into this library.
