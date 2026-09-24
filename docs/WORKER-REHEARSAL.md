# Whole-worker compatibility rehearsal

Status: initial synthetic VM checks passed, 2026-09-24. Live execution remains
disabled. This is a continuation of the [isolation architecture](ISOLATION.md)
and [candidate evaluation rehearsal](ISOLATION-REHEARSAL.md), not a completed
Claude integration or a general sandbox security certification.

The later [domain integration](WORK-CYCLE-IMPLEMENTATION.md) verifies authenticated
run-scoped tools, revocation across restart and the fully qualified image pin.
Production VM lifecycle, clipboard-write denial and real provider/session checks
are still open; the design below is not an enabled worker adapter.

The subsequent [review](REVIEW-2026-09-24.md) found an empty heartbeat read in the
original result and tightened the host's acceptance rules. Its new
[67-check report](worker-review-results.json) supersedes the original lifecycle
validation. Keep the older report as diagnostic history, not the current gate.

## Recorded experiment

The [final machine-readable report](worker-rehearsal-results.json) contains 60
passing checks and verified removal of both temporary VMs. The
[first diagnostic](worker-diagnostic-results.json) preserves an incorrect network
assertion and the observations that led to correcting it.

| Item | Observed value |
| --- | --- |
| Host sandbox CLI | `sbx` 0.45.1, commit `9d79d90ee4c5d297fb3d36b75384e8cea7a4fbcb` |
| Cached template | `docker/sandbox-templates:claude-code-docker` |
| In-VM runtimes | Linux 7.0.12, Node 22.22.1, Claude Code 2.1.280, Docker Engine 29.8.1 |
| Resources | Two VMs; two CPUs and 2 GiB configured per VM, guest CPU/memory readings recorded |
| Workspace | Mountless, private `/home/agent/workspace` |
| Host integrations | Shared skills off; SSH forwarding off; local MCP gateway required; no registered MCP servers |
| Egress | Per-VM `--deny-network '**'`; bundled provider allowances remain present but are overridden |
| Authentication | Docker signed in; Claude inside the VM reports unauthenticated |
| Model use | None; only CLI version/help/auth-status and synthetic programs ran |

This experiment records a cached template tag, not an immutable image digest.
That is a reproducibility limitation to close before production launch. The
reported Engine 29.8.1 belongs to each worker VM; it does not replace the old
Docker Desktop engine used by the earlier candidate experiment.

## What passed

- Synthetic host and other-workspace files were unreadable; an attempted host
  sentinel overwrite failed, and both host sentinels remained unchanged.
  Attempting the read with VM root privileges and through a symlink also failed.
- Host home, platform checkout, host Docker socket and a synthetic SSH socket
  were absent. `SSH_AUTH_SOCK` was set to a conventional VM path, but no socket
  existed there and `ssh-add -l` reported no agent connection.
- Each worker could write its own workspace. Writing the same path in the second
  VM did not change the first. The VMs had different kernel boot IDs and Docker
  engine identities. This tests private workspace separation, not every possible
  shared volume, session directory or peer-network attack.
- The only observed virtiofs share was the runtime's DNS configuration at
  `/etc/resolv.conf`. Claude runtime volumes and the private Docker data volume
  were visible; no platform/home/workspace share was present.
- Forward-proxy requests to a public website, provider API, GitHub API and a
  synthetic host service received HTTP 403. Bypassing proxy environment variables
  did not complete direct HTTP or TLS exchange. Guest loopback did not reach
  the host's loopback service; the host recorded zero requests.
- A detached heartbeat process ran before stopping its VM. The VM reported
  stopped, restarted with a different kernel boot ID, preserved workspace files,
  and did not resume that process. Both rehearsal VMs were subsequently removed
  and their absence verified.

The raw TCP connect event initially reported success. Docker documents a
[transparent proxy as well as a forward proxy](https://docs.docker.com/ai/sandboxes/security/isolation/).
A locally accepted connection is not evidence of successful exchange with the
destination. The revised test records that event, then requires direct HTTP and
TLS exchanges to fail. In the final run curl returned errors 52 and 35 with no
HTTP response. A separate host control request to the same HTTPS IP returned
301. No network policy was loosened to make the test pass.

## Remaining host integrations

A mountless VM is not an empty integration surface. Its environment included
`GH_TOKEN` and MCP gateway variables, even without an agent broker configured.
The rehearsal records presence only, never token values. `/run/secrets` was
empty and Claude was unauthenticated. Those observations do not validate the
future authenticated credential-proxy behavior. GitHub requests were denied.

Clipboard handling needs a separate decision before unattended launch. Docker
[documents a host clipboard write capability](https://docs.docker.com/ai/sandboxes/security/isolation/).
The installed template's `pbcopy`/`wl-copy` helpers call a host gateway endpoint
at `/_sbx/clipboard-write`. `clipboard.imagePaste` is false, but controls image
reading, not this write path. We inspected the helpers without reading or
changing the operator's clipboard. Whether a headless run can use that path,
and how to deny it outside the worker's control, remain acceptance checks.
Removing the helper inside a root-controlled VM would not enforce that boundary.

The local MCP gateway has no registered servers today. Registering a host shell,
filesystem or Docker tool would deliberately give authority back to the worker.
An empty registration list must become an explicit per-worker tool allowlist;
future unrelated server registrations must not silently expand agent authority.
The later [fixed MCP scope experiment](MCP-SCOPE.md) verifies that restriction
for two arithmetic fixtures before and after restart, including indirect dispatch.
Run identity and application permission enforcement still need integration.

## Next implementation: one bounded worker episode

Reuse Claude Code inside `sbx`; replace only the execution transport behind the
existing harness interface. Do not write a new agent loop. Keep the trusted
supervisor, task/knowledge services and protected evidence storage on the host.

1. **Resolve the host-integration surface.** Verify clipboard denial for headless
   operation, fixed MCP membership, proxy credential scopes and the immutable
   template identity. Keep host sharing and SSH off. A CLI setting writable from
   inside the worker is not sufficient enforcement.
2. **Create a supervisor-owned launch profile.** Launch `claude` explicitly with
   the existing restricted/non-interactive argument contract. Do not call the
   stock `sbx run` profile: Docker's Claude kit includes permission-bypass flags.
   Stream bounded stdin/stdout through pipes, without a terminal or raw escape
   sequence forwarding. Treat all output as untrusted data.
3. **Bridge domain tools, not the operator API.** Supply one fixed MCP definition
   to the VM. The host bridge exposes Collective commands with a run-scoped
   principal, mission revision and job-attempt identity. Pause/replacement must
   revoke authority before VM shutdown; stale tokens must remain invalid after
   restart. Test actual transport using synthetic requests before inference.
4. **Reconcile VM lifecycle durably.** Record the intended VM identity and run
   attempt before starting it. On timeout, cancellation or parent exit, revoke
   authority and stop the entire VM; killing `sbx exec` alone is insufficient.
   Keep that agent's next episode blocked until stopped state is verified.
   Recover incomplete attempts before scheduling new work after app restart.
5. **Transfer explicit snapshots.** Deliver context and approved project bytes;
   export bounded files as untrusted bytes to the existing publication validator.
   Never mount the platform repository or execute exported hooks on the host.
   Preserve private project/session state between episodes, and test separation
   of those session volumes independently of ordinary workspace persistence.
6. **Then authenticate and spend a bounded allowance.** Use subscription OAuth
   through the reviewed provider-only proxy path. Test one short print-mode
   episode, resume, cancellation and real quota reporting. Do not fall back to
   paid API credentials when subscription authentication is unavailable.

The state contract is `prepared → starting → running → stopping → stopped`, with
`unknown` requiring reconciliation. A late stream or cleanup error never grants
permission to retry effects or start an overlapping writer. CPU/memory controls
do not cap model spend; quota admission remains a separate gate.

Only after this passes should the scheduler use the VM backend and the protected
evaluation ledger accept executable criteria. The current production checks
remain bounded JSON data checks. A two-agent Discord mission follows that
integration; broader autonomous tool installation and publishing come later.

## Reproduce and maintain

Use an already cached official template and the installed local `sbx` runtime:

```sh
npm run worker:rehearse -- --image docker/sandbox-templates:claude-code-docker
```

The command verifies existing SSH/skills/MCP settings, creates uniquely named
mountless VMs with all-host egress denied, and removes only the VMs it attempted
to create. It does not change settings, pull images, register tools, copy
credentials, launch a model or touch live/demo databases. It writes
`test-results/worker-rehearsal.json`. A failed assertion still runs cleanup; an
uncertain removal is recorded as failure. An abruptly killed maintainer script
can leave a VM behind; production requires the durable reconciliation above.

The underlying command client has output/time bounds and kills its local process
group. VM removal is separate and verified through the daemon. `npm test` stays
offline and does not start Docker, Sandboxes or models.

Validation for this increment: 117 application tests passed, TypeScript typecheck
and build passed, and the documentation validator checked 23 documents and 131
local links. The first test invocation was blocked by the development command
sandbox's IPC restriction; the normal suite passed after running with the
required local-process permission. No production schema or live-launch gate changed.
