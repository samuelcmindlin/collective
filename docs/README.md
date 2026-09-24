# Collective engineering library

The first implementation is a vertical slice. The documents below distinguish
observed behavior from the architecture proposed for the next iteration. A design
document is not a claim that its interfaces or safeguards already exist.

## Start here

| Document | Purpose | Status |
| --- | --- | --- |
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
retrieval implementation is an open adapter decision until a comparative spike.

| Design | Concrete decisions and acceptance experiments |
| --- | --- |
| [1. Reliable execution](designs/01-execution.md) | Command receipts, transactions, leases, external effects and Discord recovery |
| [2. Knowledge integration](designs/02-knowledge.md) | Canonical writes, replaceable search, source authority and reuse evaluation |
| [3. Isolated workspaces and PRs](designs/03-workspaces-prs.md) | When isolation is needed, worker compatibility, immutable candidates and publication |
| [4. Progress and live validation](designs/04-progress.md) | Criteria, protected checks, independent review, comparison trials and stopping rules |

The four designs are targets with implementation tracked in the
[foundation record](FOUNDATION.md). The suite now has 58 passing checks including
fault injection and six offline GitHub protocol tests. GitHub and Discord remain
unconfigured; no new sandbox or knowledge package has been installed.

## Decision records

- [ADR-001: One application with explicit module boundaries](decisions/001-modular-application.md)
- [ADR-002: Shared discovery with separate authority](decisions/002-knowledge-authority.md)
- [ADR-003: Develop freely; activate through a controlled release path](decisions/003-controlled-evolution.md)

These ADRs are recommendations for review, not a record of user approval.

## How these documents fit the future knowledge system

[catalog.json](catalog.json) gives each document a stable ID, namespace, owner,
status, and audience. Markdown remains the editable source. The proposed importer
will publish immutable, hash-addressed revisions into the shared knowledge
service, preserving the source link. Search results will show whether an item is
a platform description, proposed design, agent observation, or approved policy.

There is no runtime importer yet. The catalog does not grant permissions and is
not an additional copy of document content. A future importer must use a
maintainer-configured source root and approved revision; an agent cannot confer
platform authority by copying this catalog or adding metadata to a note.

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
