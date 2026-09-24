# Foundation and rollout plan

Status: ordered plan with the execution and knowledge increments explicitly
marked implemented below. This is an ordered set of reviewable changes, not a claim that
the runtime already implements the target architecture.

## Recommendation

Pause feature expansion for a focused foundation pass. Keep the current stack,
harness reuse, Discord room model and UI. Move incrementally toward the
[HLA](HLA.md), introducing knowledge management as a core module during the same
pass. Do not spend months designing a framework before trying a real mission.

## Slice 0 — Record the baseline

Completed in this review:

- Source assessment with reproduced failure cases and separately labelled risks.
- Current build and 22 existing tests checked; isolated review probe results saved.
- HLA, knowledge/evolution contracts, proposed decisions and implementation gates.
- Stable documentation catalog and local validation; runtime ingestion is pending.

No live model or Discord acceptance test was performed, and no live app state was
changed. The existing tests establish a useful baseline, not production readiness.

## Slice 1 — Reliable application commands

The first implementation is recorded in [FOUNDATION.md](FOUNDATION.md): task
commands, nested transactions, commit notifications, durable task receipts,
mission scoping and stale-attempt protection are implemented and tested.
Idempotency for every other domain command remains future work. Parts of slices
2 and 4 required for this increment (schema versioning, backups and atomic run
transitions) landed with it; indexed domain repositories, expiring leases and
external-operation ledgers have not.

Extract the task and mission commands first, preserving existing MCP/HTTP shapes
through adapters. Format touched modules and split the large service switch into
use cases. Avoid mixing a full UI rewrite or new features into this change.

Introduce typed input/output contracts, explicit transaction ownership,
post-commit notifications, command identities and mission-generation checks.
Move related state, jobs, audit events and outbox intents into one transaction.
Add version checks where concurrent edits can overwrite one another. Historical
work stays readable, but modifying it requires a deliberate historical-work flow
rather than accidentally using the active mission's authority.

Acceptance:

- Injected failure between each related write leaves either the complete command
  or no change, including no notification after rollback (assessment R1).
- Retried commands with the same identity return the same result without duplicate
  tasks, reviews, notes or wakeups.
- A replaced mission invalidates old run mutations, including task submission and
  review, while preserving readable history (R2).
- Existing room routing, permission checks and rehearsal still pass.

## Slice 2 — Storage contracts and knowledge versioning

Implemented for knowledge in [KNOWLEDGE-IMPLEMENTATION.md](KNOWLEDGE-IMPLEMENTATION.md):
schema v3, document/revision repository, migration preserving legacy IDs and
conflicts, atomic revision commands and optimistic revision checks. Other generic
entity repositories and relational links remain future work.

Add actual numbered migrations and concrete repositories for documents, tasks,
jobs, messages and delivery operations. Migrate the generic JSON records in a
bounded, transactional conversion with an explicit backup/restore path. Keep
stable IDs; do not maintain permanent dual writes. Use indexed SQL predicates,
foreign keys where applicable, bounded pagination and optimistic concurrency.

Build document identity/revision/source/link records from the
[knowledge design](KNOWLEDGE.md). This provides the durable substrate for the next
slice and avoids building a second, disconnected memory store.

Acceptance:

- Existing live/demo fixtures migrate with preserved identities, task/evidence
  links and history. Validate counts, hashes and integrity on a copied database.
- Interrupted migration rolls back or resumes deterministically; a newer schema
  is rejected by an incompatible binary instead of reset to version 1.
- Concurrent revisions cannot silently create two current children (R3).
- Query plans use the intended indexes; list operations have enforced limits.

## Slice 3 — Searchable knowledge and core-document import

The bounded knowledge path is implemented: protected committed-source import,
exact reads, keyword search, source-aware Library and deterministic fresh-session
retrieval tests. The lexical comparison scored 0.75 recall for both candidates;
semantic retrieval and the full 0.9 gate remain open. A real model handoff and
a durable complete context manifest are still pending.

First run the reuse experiment in [design 2](designs/02-knowledge.md): compare QMD
with a minimal FTS5 baseline, and consider Basic Memory's fuller workflow against
the canonical-write and permission gates. The earlier direct-FTS proposal is
provisional. Implement authorized search through the selected adapter,
exact-revision lookup and bounded context assembly. Import the registered documentation catalog from a maintainer-approved
snapshot as read-only records with hashes, provenance and explicit proposal status.
Expose search and revision history in the existing Library UI and MCP tools.

Acceptance:

- Older relevant decisions remain discoverable beyond the current newest-30
  cutoff, with citations to the exact revision (R3).
- Source changes produce traceable revisions; unchanged imports are idempotent.
- Namespace access filters apply to search results, snippets and context packets;
  agent-authored metadata cannot acquire platform authority.
- A fresh agent session can take over a prepared task using only durable context.
- A small labelled retrieval set records expected documents, ranking and context
  size. Add semantic retrieval only if measured misses justify it.

This completes the first useful knowledge foundation. It should ship before new
autonomous tool installation or broad public-write capabilities.

## Slice 4 — Recovery, transport and operations

Introduce durable run attempts with lease generations and a transactionally
claimed capability-execution ledger. A single supervisor remains the deployment
model; leases protect stale output and recovery, not an untested claim of
multi-host support. Record incomplete usage as unknown rather than zero.

Buffer Discord gateway events during catch-up, deduplicate against replay, and
commit inbox processing with per-room cursor advancement. Preserve reconciliation
identity through approval-message updates. Bound reads and SSE invalidations;
provide queue age, delivery lag, run outcome, quota freshness and request status
as useful operational views.

Acceptance:

- Crash/restart injection across run claim, tool response, Discord send/ack and
  capability dispatch never silently loses work; ambiguous effects are reconciled
  or surfaced instead of blindly executed again (R5/R6).
- Live events arriving during paginated catch-up are processed once locally.
- Late output from an expired or replaced run cannot mutate current state.
- Revocation and dispatch have a documented atomic boundary. Unsupported executor
  operations remain unexecuted, with a visible reason.
- Backup and restore are rehearsed on a copy, including immutable artifacts.

## Slice 5 — Measured progress and a bounded live pilot

Bind submissions and reviews to criterion versions and immutable evidence.
Require evaluators to record what they checked; retain failed experiments and
limitations. Add a deterministic check where the criterion is executable. Keep
subjective judgments distinct from test results and operator acceptance (R4).

Before enabling less restricted generated code, test worker isolation against
protected files, local operator access, credentials, network and tool escalation.
Review and close artifact publication races. Claude argument/configuration tests
alone are not sufficient containment evidence (R7).

Then connect the new Discord server through the existing local setup flow and
run a short mission with two real agents under a strict episode cap:

- Verify room delivery and catch-up, session resumption, a searchable decision,
  an independently evaluated artifact, and a persistent request/denial path.
- Verify actual provider quota behavior. The present account diagnostic returns
  no usable quota windows; unattended business-day operation must remain blocked
  while telemetry is unknown. An explicitly entered fresh reading and disabled
  overage can support a short supervised pilot, not all-day unattended operation.
- Confirm shutdown, pause, cancellation and retry behavior with real processes.
- Compare a small fixed mission against a single-agent baseline: quality/evidence,
  allowance consumed, elapsed time and required human interventions. Keep extra
  agents only when their coordination improves the outcome enough to justify it.

No real money, public deployment, or human-contact executor is needed for this
pilot. Subscription allowance is an operational threshold, not a hard dollar cap.
Exact monetary guarantees require a metered adapter with reservations and a
defined policy for in-flight cost.

## Slice 6 — Project collaboration and controlled evolution

Add shared project repositories with separate worktrees, immutable candidate
commits, brokered upload to an approved private remote, and draft PRs. Implement
bounded declarative world changes under preapproved policies. This allows useful
autonomy without requiring a fresh approval for every reversible room adjustment.

After a concrete need appears, implement one extension class end to end:
capability manifest, isolated staging, protected acceptance checks, persistent
approval when needed, limited activation, observability and rollback. Platform
patches follow the maintainer release path in [evolution](EVOLUTION.md). Do not
let an agent's source checkout become the active supervisor automatically.

Acceptance:

- Approval and deployment refer to the same immutable candidate and exact scope.
- Candidate code cannot alter its grant, evaluator or activation controller.
- A failed extension can be disabled and its prior release restored.
- A database migration has an explicit recovery strategy independent of code rollback.

## Proposed scale and reliability targets

These are starting acceptance targets, not measured performance or model-capacity
claims. Record hardware, data distribution and workload before using results to
make deployment decisions.

| Dimension | Initial target and measurement |
| --- | --- |
| Team | Six configured agents, two concurrent episodes; measure useful output per unit of allowance |
| Historical state | Synthetic fixture with 100,000 messages, 10,000 documents, 10,000 tasks and 50,000 audit events |
| Local reads | p95 under 250 ms for representative bounded board/search/context-source queries; excludes model and Discord latency |
| Context growth | A configured fixed context-packet budget with visible truncation; historical data growth must not grow every prompt |
| Recovery | Fault injection at durable transition boundaries; no silently lost accepted commands, and ambiguous external effects explicitly tracked |
| Sustained operation | Simulated multi-day replay followed by a supervised business-day pilot once live prerequisites pass |
| Progress quality | Criteria and evidence coverage, reproducible checks, uncertainty, intervention rate, and comparison with a single-agent baseline |

SQLite stays until measured writer contention or a multi-host deployment need
justifies a change. UI rendering and prompt growth need their own measurements;
moving databases cannot repair those problems. Hosted multi-tenant operation
would additionally need tenant isolation, hosted authentication, per-tenant
secrets/budgets, deployment operations and a separate security review.

## What to implement next

The [research memo](RESEARCH.md) and four [implementation designs](README.md#research-and-implementation-designs)
make the contracts and stop/go experiments concrete. Grouping the work into four
designs does not require four independent services or a separate sandbox per room.
The intended milestone is one restart-safe, evidence-backed work cycle ending in
an authorized private draft PR. Knowledge and worker compatibility spikes resolve
dependency choices before substantial integration code is written.

Start with slice 1, then take the smallest vertical path through slices 2 and 3:
reliable commands → versioned knowledge → searchable, read-only core docs. Keep
the UI recognizable while the underlying contracts improve. Close transport,
execution and containment gaps before the live pilot or broader autonomy. Revisit
the ADRs with evidence from that pilot rather than prebuilding a distributed system.
