# Durable worker lifecycle implementation

Recorded 2026-10-09. Implements the single-supervisor lifecycle from
[design 6](designs/06-worker-lifecycle.md). This adds ownership, termination and
recovery infrastructure; the live Claude execution gate remains closed.
The subsequent [focused review](REVIEW-2026-10-09.md) fixes peer cancellation during
cleanup and closes the episode signal on every exit, with expanded VM evidence.

## What changed

Schema 5 adds a `worker_intents` table with unique run and unresolved-agent
constraints. An intent records immutable run/attempt/mission identity, a random
resource identity, image digest, lifecycle phase and provision acknowledgement.
Tokens remain in host-private files and memory, never in that table or reports.
Worker transitions and their audit events commit together.

`WorkerLifecycle` performs preflight, saves dispatch intent, provisions the VM,
checks the runtime configuration, runs a bounded episode, revokes authority and
cleans up. The Docker adapter uses the previously tested mountless configuration,
fixed MCP registration, denied network and pinned cached image. The compatible
installed CLI is v0.45.1; a different version requires verification. No runtime
upgrade, provider credential transfer or model invocation is part of this change.

The command runner now lives in the application; older rehearsals import the
same implementation. Every sandbox command has an output limit and deadline.
Cleanup independently attempts VM removal, registration removal and host MCP
process-exit verification. A failed SQLite stopping write does not prevent the
best-effort external cleanup or in-memory token revocation.

The scheduler checks durable worker state on every tool authentication and before
admitting work. Only a ready, unrevoked worker can use its run token. An unresolved
or orphaned intent blocks new admission, including simulation mode. The main
application reconciles intents before starting scheduling and awaits its lifecycle
operations before closing SQLite on shutdown. The native live harness is still
disabled; the new execution method is exercised by synthetic workers.

## Recovery rules and limits

Acknowledged workers can be removed automatically after a supervisor crash.
Cleanup can safely repeat if the VM was removed before SQLite recorded that fact.
Names come only from the persisted intent; unrelated resources are preserved.
Intent records survive removal so their identities and audit history remain visible.

An unacknowledged external dispatch remains `unknown` even if cleanup observes
absence. The daemon might finish an interrupted create later. Such an intent
blocks replacement work and retains an explanation. A later ordinary restart does
not erase this uncertainty. Backend-specific operator reconciliation must establish
that no create can still complete before any future resolution mechanism clears
it. This increment deliberately exposes no automatic forget/override command.

Episode deadlines include provisioning and work; cleanup uses separate bounded
commands. Ignoring a cancellation signal in a work callback does not keep its VM
alive. These controls require a functioning supervisor. Host sleep, power loss,
daemon failure and an OS-killed supervisor are not VM-native expiration; startup
reconciliation handles surviving records when the supervisor returns.

The intent ledger does not provide a distributed lease or a multi-host scheduler.
It also does not yet transfer guest artifacts, preserve/resume Claude sessions,
prove provider subscription billing, enforce a dollar budget, or disable the host
clipboard-write integration. Those remain live-worker admission work.

## Reproduction and evidence

```sh
npm run check
npm run lifecycle:rehearse -- --image docker.io/docker/sandbox-templates:claude-code-docker@sha256:549730947ed8a43182547bb5628245fe6d6c089564dd73d2194e899f791d970f
npm run migration:rehearse -- .collective/collective.sqlite .collective-demo/collective.sqlite
```

The [VM report](worker-lifecycle-results.json) records two synthetic trials. Both
use the actual scheduler, run-scoped MCP gateway and a real pinned VM. The guest
successfully obtains Atlas's authenticated context before the injected failure.

1. **Pause:** the scheduler revokes the token while a worker callback deliberately
   never returns. The controller removes its VM, registration, host MCP process
   and private launch file, and records removal before ending the episode.
2. **Supervisor crash:** the child supervisor kills itself with `SIGKILL` after
   the ready state and successful tool call. A separate parent opens SQLite,
   recovers the interrupted run, observes blocked admission, and reconciles the
   acknowledged VM. Admission is clear only after verified cleanup. The fixture
   and its launch credentials are removed; unrelated VM inventory is preserved.

The regression tests additionally inject failed preflight, failed dispatch writes,
lost provision acknowledgements, failed cleanup writes, failed runtime cleanup,
deadlines, malformed inventories, mismatched image digests and unexpected mounts.
They verify durable revocation, unique allocation and that unknown work stays
blocked. Passing these checks is bounded evidence, not a security score.
The final regression run passed all 139 tests; type checking and compilation also
passed. The documentation catalog contains 30 registered sources. The committed
VM report matches the implementation source fingerprint used for these trials.

Migration/restore was rehearsed on independent copies of both existing databases:
schema 4 to 5, original files unchanged, history/evidence preserved, integrity
checks passed and restoration exact. Startup creates a pre-migration backup when
an existing application is upgraded.

## Next increment

Connect explicit bounded workspace/artifact snapshots to this lifecycle and close
the remaining host-integration/provider admission gaps. Then run one measured real
Claude episode. The separate Python/Inspect adapter, repeated trials and solo/team
comparisons remain sequenced in [design 5](designs/05-work-cycle.md), with the
earlier [research record](EVALUATION-RESEARCH.md) preserved for that work.
