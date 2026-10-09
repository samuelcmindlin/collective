# Design 6: Durable sandbox ownership and recovery

Status: accepted for the single-supervisor MVP, 2026-10-09. Refines
[work-cycle design](05-work-cycle.md). Live Claude execution remains gated.

## Scope and invariants

The supervisor records a worker intent in SQLite before registering an MCP server
or creating a VM. One intent belongs to one immutable run attempt, agent and
mission revision. Its random VM/registration names and pinned image cannot be
changed by an agent. At most one unresolved intent exists per agent.

The lifecycle owns provision, deadline, revocation and cleanup. It does not own
model prompts, grading, provider credentials or workspace export. The installed
Docker Sandbox adapter is used only with synthetic work until the remaining
clipboard, authentication, quota and snapshot-transfer gates pass.

```text
planned -> provisioning -> ready -> stopping -> removed
               |                       |
               +-----------------------+----> unknown
unknown -> stopping -> removed only when provision was durably acknowledged
```

Persist `dispatched` before the first external mutation and `provisioned` only
after registration, VM creation and runtime inspection all return successfully.
Persist revocation before cleanup, and reject tools for an intent that is not
ready or has been revoked. Cancellation revokes its in-memory token immediately;
restart also invalidates all old tokens. A transport reconnect grants no authority.

Unknown cleanup blocks new admission across the supervisor. Stopping the local
CLI is not proof the daemon stopped its work. In particular, an interrupted create
can finish after an inventory read reported absence. If dispatch was recorded but
provision was not acknowledged, attempt cleanup but retain `unknown`, even if
the VM currently appears absent. This conservative case needs backend-specific
operator reconciliation; there is no automatic "forget" or retry switch.

## Startup, shutdown and deadlines

On startup, recover application attempts, then reconcile every nonremoved worker
intent before starting scheduling or exposing worker tools. Revoke first; remove
only resources whose exact names were saved in this database. Verify VM absence,
MCP registration absence and host MCP subprocess exit before recording removal.
Never remove another project's VMs or registrations. Keep the intent and audit
events after cleanup; do not erase uncertain external effects.

On pause, mission replacement, episode deadline or shutdown, revoke commands,
cancel the worker operation and clean up using an independent bounded command
budget. A cleanup failure is visible and prevents replacement work. Application
shutdown awaits owned lifecycle operations before closing SQLite. The deadline
includes provisioning and work; cleanup has separate bounded command deadlines.
The host must remain running for these deadlines to be enforced: host power loss
or a dead supervisor requires startup reconciliation, not a claim of automatic
VM expiration.

## Verification and rollout

Test failures before dispatch, after an unacknowledged create, after acknowledged
provision, during removal, and after removal before its local acknowledgement.
Reopen the database to prove recovery does not depend on an in-memory map. Test
pause, deadline, ignored cancellation, concurrent same-agent allocation, malformed
inventory and preservation of unrelated runtime resources. Replay cleanup safely;
never reinterpret an infrastructure error as absence.

Use the lifecycle in a synthetic VM rehearsal before attaching a real Claude
episode. Rehearse schema migration/restore on copies of the live/demo databases.
Keep the existing CLI argument and process-bound tests. The main application
uses the recovery/admission guard even while model execution is disabled.

This is one local supervisor, not a distributed lease system. Revisit an existing
durable workflow engine before adding remote worker hosts or multiple supervisors.
The Python eval adapter follows this stable execution boundary.
