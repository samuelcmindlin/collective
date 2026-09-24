# Collective — implementation decisions

This describes the original prototype and its intended boundaries. It is not a
security certification. The [assessment](ASSESSMENT.md) records current gaps;
the [HLA](HLA.md) proposes the next architecture. See the
[engineering library](README.md) for the design and implementation plan.

## Product contract

The user supplies a broad mission. Agents discover a direction, discuss it in
Discord rooms, create work and evidence, review one another's results, and adapt
to feedback. Room membership controls live attention. No physics is required.
Stable identities outlive CLI processes and individual task sessions.

Initial policy: personal system, invited Discord observers, weekdays 09:00–17:00
America/New_York. No general publishing, payments, or unsolicited human contact.
Repository writes and deployment require a configured destination and scoped
authority. Requests persist independently of agent sessions.

## Reuse decision (2026-09-23)

Use Claude Code's installed harness, MCP's official TypeScript SDK, discord.js,
and SQLite. A small application supervisor owns the domain-specific state.
We are not implementing an LLM/tool loop or our own context compaction.

Paperclip was evaluated via its current Claude adapter and extension docs:
https://github.com/paperclipai/paperclip/blob/master/docs/adapters/claude-local.md
https://github.com/paperclipai/paperclip/blob/master/adapter-plugin.md

Its resumable local-CLI approach is appropriate. Its larger company model and
permission-bypass default would still require custom room routing, subscription
allocation, and capability enforcement. For this personal prototype, a small
supervisor around the same Claude harness makes those boundaries explicit.
The harness interface is separate so a Paperclip adapter can be added later.

## State and execution

- SQLite is authoritative for agents, rooms, messages, missions, tasks, evidence,
  knowledge revisions, calendar entries, permission requests, runs, jobs, and outbox.
- Jobs are durable and claimed transactionally; one active run per agent.
- An expired/interrupted run becomes resumable work. External side effects use
  an outbox, stable keys, and reconciliation rather than assuming exactly-once I/O.
- Claude is invoked with explicit session IDs, structured event output, bounded
  turns, a timeout, restricted configuration, and mandatory sandboxing.
- Shared knowledge and artifacts remain usable after session compaction/rotation.
- Live conversation routes through Discord before delivery to occupants. Offline
  Discord pauses new live work; queued messages remain visible as undelivered.
- Simulation is separately labelled and uses a separate database. It never invokes
  a model or sends Discord messages; it exists for UI exploration and regression tests.

## Authority

Agents receive a short-lived run token for agent endpoints, never operator tokens,
Discord credentials, or GitHub credentials. The operator UI binds to loopback,
validates Host/Origin, and requires a non-simple header for state changes.
Discord operator actions are checked against configured user IDs. Other visitors
may discuss but cannot approve capabilities or replace the mission.

The CLI's built-in tools are confined to its workspace. Shell commands must use
Claude's sandbox with no unsandboxed fallback and no network destinations. Network
reads and external writes go through separate broker tools. Protected runtime
configuration, credentials, databases, and other agents' files are outside the
workspace and excluded from shell reads. Agent-written config is not loaded.

Capability approval binds to a typed action and exact scope. A pending request is
not authority. Denied requests do not retry indefinitely. Agent changes to tools,
team size, and environment pass through validated operations; they cannot widen
runtime policy or change their own budget.

## Budget semantics

Subscription cost estimates are not dollars billed or a precise fraction of plan
quota. We track token usage, episode limits, and available account quota signals
separately. Missing/stale quota telemetry blocks unattended live launches. In-flight
requests can finish after a quota threshold is reached, so a safety reserve is
required. The pinned Agent SDK supplies an experimental account-usage control
request with no model prompt. Unavailable provider data stays unavailable; manual
readings expire too. Both windows and confirmation that overage is disabled are
required. API mode is not enabled implicitly and paid overage must stay disabled.

## Verification

Tests cover persistence/recovery, same-room routing, delivery deduplication,
operator authority, request scoping/revocation, task review, scheduling across DST,
quota pauses, safe CLI arguments, and a complete simulated mission. UI is checked
against the running service. Live Discord and subscription tests require local
credentials; the app reports connection status instead of treating mocks as live.
