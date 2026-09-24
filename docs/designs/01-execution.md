# Design 1: Reliable commands, runs and recovery

Status: target design, partially implemented. Owner: platform maintainer. Covers
assessment R1/R2/R5/R6/R8/R9 and plan slices 1, 2 and 4. See the
[foundation record](../FOUNDATION.md) for the shipped task/transaction/mission
subset and its limitations. [Research and alternatives](../RESEARCH.md).

## Decision and scope

Keep one SQLite supervisor for the personal milestone. Build a bounded command,
job and external-operation protocol; do not build a generic workflow language.
The stable interface is typed application commands, so a later execution backend
can change without rewriting knowledge, task or permission semantics.

Temporal and DBOS were considered in the research. Revisit before remote worker
hosts, independently versioned workflows, complex durable fan-out or a second
scheduler are added. If the next milestone needs those, spike an existing engine
before extending our scheduler. This is an explicit provisional choice.

## Invariants

1. An accepted local command commits its state, receipt, jobs and audit together.
2. One active lease per agent; every run write verifies its lease generation and
   active mission revision in the same transaction as its mutation.
3. One command identity cannot represent two payloads. A retry returns the prior
   result; it does not replay the mutation or emit another logical event.
4. No database transaction spans model, Discord, filesystem-heavy or GitHub I/O.
5. External outcomes can be unknown. Only reconciliation or a new explicitly
   authorized attempt resolves an ambiguous dispatch.

## Records and boundaries

| Record | Key fields / constraint |
| --- | --- |
| Command receipt | `(principal, command_key)` unique; payload hash, command version, mission revision, result reference |
| Job | Stable logical work ID, kind, owner, mission revision, available time, state, bounded retry policy |
| Run attempt | Job, agent, lease owner/generation/expiry, session, status, usage values plus known/unknown status |
| Audit event | Monotonic ID, command/run/mission IDs, type, referenced entities, immutable payload |
| Inbox | `(transport, external_message_id)` unique, room, received payload, processing state |
| Outbox | Stable intent ID, destination, content hash, delivery state and attempt references |
| Operation | Grant, immutable scope hash, state, external idempotency key, dispatch time, result/unknown reason |

Retain current entity IDs through numbered migrations. Introduce relational
tables by use case; remaining JSON entities can coexist temporarily but must
have one writer and participate in the same connection/transaction. Reject
unknown newer schema versions. A copied-database migration/restore rehearsal is
required before touching live state.

```ts
interface CommandEnvelope<T> {
  commandKey: string;
  version: 1;
  expectedEntityVersion?: number;
  payload: T;
}
// Authenticated principal, collective, run lease and mission are supplied by
// the adapter, checked against storage, and never trusted from payload fields.
```

Local command handling: authenticate → begin transaction → validate current
authority → look up receipt → reject key/payload mismatch or return result →
check transition/version → write state/jobs/audit/receipt → commit → notify.
Notifications are expendable wakeups; readers can recover by durable cursor.
Nested use cases share the transaction context rather than opening a second one.

Command identity is not a hash of natural-language intent. Persist a logical
action key in the job/step record before dispatch and reuse it on transport
retries. Include recent completed actions in resumed context. If the model invents
a new key for the same intended work, domain uniqueness rules or review must
catch it; infrastructure cannot promise semantic deduplication.

## Run and operation states

```text
job: pending -> leased -> complete
                     -> retry_at -> pending
                     -> blocked | cancelled | exhausted
run: starting -> active -> succeeded | failed | interrupted | lease_expired
operation: prepared -> dispatching -> succeeded | failed | outcome_unknown
          revoked       outcome_unknown -> reconciled_success | reconciled_failure
```

The claim transaction reserves a run slot and generation. Heartbeats extend only
that generation. A restart expires old ownership and reconciles attempts before
resuming. An old process cannot write just because its token has not timed out.
Mission replacement invalidates old generations and queued work transactionally;
historical carry-forward is a new, linked command.

Capability dispatch atomically claims a valid grant and operation. Revocation
wins before that claim; afterward the UI reports in-flight work and whether the
executor supports cancellation. Store external receipts before signalling task
progress. Budget unknowns remain unknown, and admission stops when required
telemetry is stale.

## Discord protocol

Persist gateway arrivals while fetching history. Deduplicate the union by Discord
message ID and process per-room history in order. A cursor advances only over a
known processed prefix, not simply to the largest newly seen snowflake. If a
history window cannot be filled, surface a gap and pause affected conversation.

The outbox retains stable identity across message edits. Delivery acknowledgement
and addressed wakeups commit together. Reconciliation has explicit search bounds;
a missing marker outside those bounds yields uncertainty, not an exactly-once
claim. Use a fake transport to inject arrival during catch-up and acknowledgement
loss before testing with a private Discord server.

## Verification and rollout

- Start with task creation and mission replacement. Inject failure after each
  write and assert zero partial state and zero rollback notifications.
- Test same-key retry, changed-payload conflict, competing claims, stale lease
  output, cancellation, and mission replacement while a command is pending.
- Rehearse crashes before/after external dispatch using deterministic fake
  providers, then verify reconciliation with real private destinations.
- Track queue age, retries, unknown effects, lease expiry, quota freshness and
  command latency; protect logs from credential and private-content leakage.

Keep tool names compatible during extraction. Gate a release on old workflow
tests plus the new failure matrix. Roll back code only with a compatible schema
or the rehearsed state restore; do not reset migration numbers to downgrade.
