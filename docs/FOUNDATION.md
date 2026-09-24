# Core foundation implementation

Status: implemented first increment, 2026-09-23. This records the changes to the
prototype after the [assessment](ASSESSMENT.md). It does not mark every gate in
the four subsystem designs complete. The subsequent
[knowledge increment](KNOWLEDGE-IMPLEMENTATION.md) supersedes the knowledge-write
limitations and schema-v2-only description below; this remains the first-increment
verification record.

## Priority and scope

Reliable work state takes priority over richer knowledge retrieval. An agent
cannot make trustworthy progress if a failed command leaves half a task, a retry
duplicates accepted work, or an old mission continues to dispatch new work.
This increment fixes those foundations while preserving the current UI and tool
names. No new model, search, sandbox or GitHub dependency was installed.

## Implemented contracts

| Area | Behavior now |
| --- | --- |
| Task commands | Extracted into typed application commands; task, job, counter, audit and command-receipt writes share one transaction |
| Transactions | Synchronous only; nested savepoints; notifications emitted only after outer commit and discarded on rollback |
| Retry identity | Task commands accept stable `commandId`; identical retries return the stored original result, including after reopening the database |
| Identity conflicts | Reusing an ID for another task command, payload or mission rejects the call |
| Task concurrency | Tasks expose a version; supplied `expectedVersion` rejects stale edits. Review rounds give follow-up jobs stable identities |
| Mission scope | New jobs, messages, meetings and permission requests retain mission ID/revision; task writes require the active mission |
| Mission replacement | Cancels old queued/failed work and outstanding meetings; late message delivery remains visible but cannot wake the new mission |
| Run ownership | Each run captures the monotonically increasing job attempt; stale results/events and stale run tokens cannot act for a replacement attempt |
| Run transitions | Start, success and failure commit related job/run/agent records atomically. A persistence failure halts admission for restart/recovery |
| Local tools | Local database mutations commit with their audit records; external network calls do not hold a database transaction |
| Storage upgrades | Numbered schema migration to v2; startup backup; incompatible newer schemas rejected; migrated installations start paused |

Task commands live in `src/application/tasks.ts`, receipts in
`src/application/commands.ts`, and migration/backup code in `src/storage/`.
The remaining service switch is still a prototype module to extract incrementally.

## Retry semantics and limits

The MCP client assigns a task command ID if omitted and reuses it for one retry
after an ambiguous HTTP failure. The HTTP endpoint requires an ID for task
mutations. Agents should supply their own stable logical IDs when work may cross
MCP process/session restarts; recent task receipts are included in context.

An identical retry returns the original result snapshot, not the current task
version. Read context before a new edit. `expectedVersion` remains optional for
compatibility; callers that omit it do not get optimistic-concurrency checking.
Authority and active mission are checked before applying work. Receipts remain
retained; deleting them would change the retry guarantee.

This is task-command idempotency, not semantic deduplication of arbitrary agent
intent. An agent using a new ID for the same intended work can still create a
duplicate. Knowledge writes, room speech and arbitrary external effects do not
yet have a universal command-receipt protocol. The client does not automatically
retry those non-task operations after an ambiguous network response.

Run attempt checks protect the current single-supervisor recovery model. They
are not expiring distributed leases or support for multiple independent hosts.
Pause and mission replacement retain the existing requirement to stop active
runs before replacing the mission. Usage of interrupted model calls is still an
accounting limitation; precise cost reservation is not implemented.

Artifact metadata, publication intent and audit commit together. A file copied
before a failed database transaction can remain as an unreferenced blob; this
increment does not implement blob garbage collection or race-resistant artifact
export. GitHub operations still need the durable execution ledger described in
the designs before broader external writes.

## Migration and rollback

Normal startup acquires the supervisor lock, creates a committed SQLite backup
under the data directory's `backups/` folder when an upgrade is needed, then
applies migrations transactionally. Backups include committed WAL data and use
private file permissions. The original supervisor must be stopped before the
new binary opens the live database.

Version 1 jobs with a verifiable task or mission reference receive the associated
mission scope. Other unfinished legacy jobs are retained as cancelled, with an
explanation. Existing tasks, knowledge, artifacts and event history are retained.
Old unscoped meetings/requests are not silently granted current-mission authority;
recreate useful requests or meetings under the current mission. Migrating v1
sets the collective paused so this transition can be inspected before resuming.

To rehearse an upgrade and exact database restore without changing the originals:

```sh
npm run migration:rehearse -- .collective/collective.sqlite .collective-demo/collective.sqlite
```

The script uses read-only source connections and temporary copies. On the actual
prototype snapshots, v1→v2 preserved 11 live entities/5 events and 44 demo
entities/71 events; both integrity checks passed and restoring the frozen
snapshot reproduced the original schema and state exactly. Temporary rehearsal
files are removed afterward.

To roll back a deployed upgrade, stop the application and restore the selected
pre-upgrade database into a clean data-directory copy with the matching old code.
Do not put an old database beside newer WAL/SHM files or downgrade only the
`user_version` flag. Retain the current directory until the restored copy has
been inspected. Database backup is not a substitute for separately backing up
immutable artifacts and any required Claude session data.

## Verification and remaining gates

The suite has 58 passing checks including nested fault-injection cases. Coverage
now includes failure at task/job/audit/receipt writes, review counter rollback,
dropped HTTP replies after commit, durable receipts after reopening, task-version
conflicts, mission replacement, stale worker output, atomic meeting activation,
run persistence failures, migration rollback and WAL-aware backups. Build and
documentation checks passed.

Both local installations were then restarted with the tested code. Startup
created their pre-upgrade backups and applied v2. HTTP checks returned 200 for
the live dashboard on port 4310 and simulation on port 4311; both reported
paused with zero active runs. The demo retained its two tasks and one artifact.
Discord and GitHub remain unconfigured, and no real agent run was started.

[Current probes](foundation-results.json) show R1 leaves zero tasks/jobs after
failure and R2 rejects old-mission submission/review. The original
[review results](review-results.json) remain an unchanged historical baseline.
R3 (retrieval/revision conflicts) and R4 (insufficient outcome verification)
remain reproduced gaps; this pass does not pretend those are solved.

Next, implement the smallest shared-knowledge/evidence path needed for a real
handoff: versioned source records, exact reads, bounded search and criterion-bound
review. Run the planned retrieval comparison before selecting an engine. Worker
containment and real Claude/Discord behavior remain prerequisites for a live
coding pilot. Public deployment, agent-installed extensions and money are outside
this increment.
