# Architecture assessment of the first prototype

Reviewed September 23, 2026, local time. Scope: current source, build, existing
tests, and isolated domain probes. This was not a penetration test, live Discord
test, real-model quality evaluation, or load benchmark.

This is the preserved pre-refactor baseline. The subsequent
[foundation implementation](FOUNDATION.md) fixes task transaction failures and
old-mission mutations and records the remaining gaps. Source line references
below describe the assessed snapshot, not the current file layout.

## Recommendation

Do a focused foundation refactor before adding external deployment, arbitrary
tools, or autonomous platform changes. Keep the existing harness, transport,
local database, and UI as a useful vertical slice. The main problem is incomplete
contracts between these pieces, rather than the choice of language or database.

The first pass prioritized a runnable workflow. It is not yet a reliable
unattended collective. The 22 existing tests cover useful behaviors, but do not
establish crash consistency, adversarial isolation, goal quality, or capacity.
The code is also heavily compressed: large one-line handlers and UI templates
need formatting and separation before routine contributions become comfortable.

## What is worth preserving

| Foundation | Evidence | Practical value |
| --- | --- | --- |
| Harness abstraction and explicit sessions | `src/claude.ts`, `src/scheduler.ts` | Reuses Claude Code's tool loop and compaction; a run is separate from agent identity |
| Durable jobs and Discord outbox | `src/store.ts`, `src/discord.ts` | Better recovery model than chaining model calls in memory |
| Domain tools rather than arbitrary DB writes | `src/service.ts`, `src/mcp-worker.ts` | A place to enforce meaningful invariants independently of prompts |
| Scoped operator decisions and separate run credentials | `src/http.ts`, `src/service.ts` | A basis for controlled access and persistent requests |
| Immutable artifact copies and separate review | `src/service.ts` | Evidence survives subsequent workspace edits |
| Explicit rehearsal mode | `src/simulation.ts` | Exercises workflow without pretending simulated output proves live capability |
| Hours, quota staleness, concurrency, episode limits | `src/scheduler.ts` | Conservative admission control, though not precise financial accounting |

## Gaps to address, in order

### R1 — Commands do not consistently commit atomically

**Reproduced.** `task_create` writes the task, enqueues work, then records an
event in separate commits (`src/service.ts:123`). Injecting failure at enqueue
leaves one task and no new job even though the command rejects. Similar groups
of writes exist in submission, review, meeting start, and run completion.

`Store.event` queues a notification immediately (`src/store.ts:43`); deferring
its callback to a microtask does not ensure an enclosing transaction committed.
A rollback can still produce a notification for an event absent from storage.
These are notification callbacks, not a reliable event delivery mechanism.

**Required:** application commands own a transaction covering state, jobs, audit
events, and outbox intents. Emit notifications only after successful commit.
External I/O happens after commit and has its own durable operation lifecycle.
Add failure injection at every boundary, not only restart of a running job.

### R2 — Mission boundaries are incomplete

**Reproduced.** Replacing a mission cancels old queued jobs, but the tools for
updating, submitting, and reviewing a task do not require its mission to remain
active (`src/service.ts:131`). An agent can submit and accept an old task after
the new mission starts. Context also contains tasks from all missions.

**Required:** commands carry mission/revision identity and reject stale writes.
Old work remains readable; explicitly scoped carry-forward creates a link to the
new mission. Jobs, meetings, context, and permission decisions need a stated
policy for mission replacement. Stale work must not silently reactivate.

### R3 — Knowledge is a recent-notes feed

**Reproduced.** After 30 newer entries, an early relevant decision disappears
from `collective_context`; agents have no knowledge search/read-by-ID tool
(`src/service.ts:60`). The record is stored but inaccessible through the normal
agent knowledge interface. Two writes from the same `previousId` both become
revision 2 and both appear current (`src/service.ts:159`).

**Required:** stable document IDs, immutable revisions, compare-and-swap updates,
namespaces, provenance, retrieval, and explicit conflict handling. Core docs
must not be mixed into this feed with the same authority as agent notes.

### R4 — Independent review is a process check, not measured success

**Reproduced.** A task demanding a working game can be accepted using an unrelated
hypothesis as evidence and a different agent's “Looks fine” note. The code checks
that evidence exists and the reviewer differs from the owner; it does not
enforce relevance, an inspection record, or an executable acceptance check
(`src/service.ts:137`). Reviewer identity alone cannot guarantee truth.

**Required:** mission outcomes, versioned criteria, evidence links, evaluation
results, and human acceptance where success is subjective. Inspection receipts
improve traceability; they are not proof of comprehension. Keep task throughput
separate from outcome metrics and run a single-agent comparison for sample goals.

### R5 — Discord recovery needs its own protocol tests

**Inspected risk, not live-reproduced.** While `catchingUp` is true, the gateway
handler ignores messages (`src/discord.ts:32`). A message arriving in a room whose
history was already scanned can be missed while another room is being scanned.
A later message can advance the saved cursor past that missed message. Reconnect
and shutdown also need tests with work in flight.

Send reconciliation inspects only the latest 100 messages. An approval updates
the request embed without preserving its outbox marker, which weakens recovery
if its original send acknowledgement was lost. Local approval changes are not
immediately projected back onto existing Discord request messages.

**Required:** durable inbox deduplication, buffered gateway events during
catch-up, per-room checkpoints, verified reconnect behavior, and stable projection
IDs. Test acknowledgement loss, duplicates, deleted channels, and disconnects.

### R6 — Approval and execution need different durable records

**Inspected.** `executeCapability` uses an in-memory lock, checks the grant, then
awaits remote calls before marking it fulfilled (`src/service.ts:202`). There is
no durable execution attempt, dispatch state, or explicit outcome for a revoked
grant whose operation was already in flight. Agent tools do not generally carry
idempotency keys, so retrying an interrupted episode can duplicate tasks or notes.

**Required before broader external writes:** normalized typed proposals, exact
artifact/commit hashes, grants, execution claims, receipts, and reconciliation.
Revocation must prevent new dispatch; it cannot promise to undo an already sent
external action. Unknown outcomes stay unknown until reconciled.

### R7 — The current isolation is not a hostile-code boundary

**Unverified live.** The CLI is launched under the local user's identity and
uses that user's subscription authentication. The intended file/network sandbox
is configured and tested as configuration, not adversarially exercised against
the actual CLI. The loopback operator interface trusts local access; it is not
an authentication boundary against arbitrary processes running as that user.

The broker reads artifact paths after path checks. Race-resistant file handling
and ancestor-symlink changes need review before running untrusted generated
programs. No exploit was attempted during this assessment.

**Required:** actual containment tests and a separate worker identity or isolated
execution environment before executing agent-installed extensions. Repo layout,
prompt text, and `0600` files under the same OS identity do not provide that
separation. Provider-auth compatibility must be proven before selecting the
isolation backend.

### R8 — History growth becomes a cost and latency problem

**Inspected.** Many hot paths read every JSON row and filter in JavaScript
(`src/store.ts:26`, `src/scheduler.ts:25`). The HTTP snapshot includes whole
knowledge/task collections, and every change triggers another snapshot
(`src/http.ts:29`, `public/app.js:80`). Prompt construction includes all tasks.
There is no migration framework, schema-level referential integrity, pagination,
retention policy, or measured performance envelope.

**Required:** typed tables/repositories, indexed bounded queries, cursor-based
UI views, batched notifications, prompt budgets, and storage growth limits.
SQLite can stay for the personal single-host deployment. Its one-writer model
becomes a reason to reconsider the database when multiple hosts need independent
writes, not simply when the avatar count increases.
[SQLite's deployment guidance](https://sqlite.org/whentouse.html).

### R9 — Unattended operation has unproven dependencies

Quota retrieval previously returned no snapshot despite a recognized subscription.
Manual readings expire. Therefore the present setup cannot claim reliable all-day
autonomy. Interrupted runs record zero usage rather than explicitly unknown usage;
there is no reserved-cost ledger. Agent-authored estimated external cost is not
a trustworthy enforcement mechanism.

**Required:** provider compatibility tests, honest unknown accounting, reliable
quota freshness, and a defined pause/recovery path. A future API budget must reserve
maximum authorized cost before dispatch and settle against receipts. Subscription
quota thresholds remain approximate account-wide controls.

## Verification record

The existing build and 22 tests pass. Additional probes reproduced R1, R2, R3,
and the limited enforcement described in R4. Results and source hashes are in
[review-results.json](review-results.json). They characterize this baseline; they
are not evidence of fixes. The Discord, sandbox, and scaling concerns above are
explicitly identified as inspected or unverified.

No live app database, permissions, or running configuration was changed in this
review. Use the [implementation gates](PLAN.md) to turn these findings into a
small, verifiable refactor rather than a speculative rewrite.
