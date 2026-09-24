# Reproducible work cycle and authenticated VM bridge

Status: deterministic scenario and synthetic VM bridge implemented, 2026-09-24.
No model was invoked. The production live-worker gate remains closed. Implements
the first scenario and domain-transport portions of [design 5](designs/05-work-cycle.md).
The [research record](EVALUATION-RESEARCH.md) preserves the later Python/framework,
organizational, room and learning experiments.

## One-command local scenario

```sh
npm run scenario:run -- correct
npm run scenario:run -- wrong
```

Each invocation creates a fresh temporary database, workspace and loopback HTTP
server. It runs the actual Scheduler, authenticated `/agent/tools` ingress, MCP
server, knowledge commands and submission ledger. The worker is deterministic
maintainer code using the official MCP client, not a Claude model or a VM worker.
No `.env` or production configuration is loaded. Discord is not connected.

The worker discovers and reads a palette/cardinality constraint, starts its task,
publishes an immutable JSON artifact and submits it. It also attempts to change a
different agent's task and retries an identical own-task command. Ownership is
preserved and the repeated command returns the same receipt.

An independent host check reads the published snapshot and compares the full
configuration with the expected palette, count and exact source revision. The
wrong variant deliberately uses the wrong palette while satisfying the production
JSON field/type check. Its outcome is `fail`, not `pass`; its CLI exit status is 1.
Both submissions remain in review. Neither is silently accepted by the external
scenario result.

Reports default to `test-results/work-cycle-correct.json` and
`test-results/work-cycle-wrong.json`; `--output path` selects another destination.
The [correct report](work-cycle-correct-results.json) and
[wrong report](work-cycle-wrong-results.json) are committed examples.

## Evidence and lifecycle checks

The version-1 report distinguishes `pass`, `fail`, `cancelled` and infrastructure `error`.
Scored reports require a complete observation inventory, exact evidence, a
completed artifact run and verified cleanup. Trace entries retain tool names,
error status and input/result hashes without credentials. The source fingerprint
includes TS/MJS/JSON under `src` and `scripts`, package files and compiler config;
the fixture has a separate hash. UUIDs and timestamps vary between trials.

A separate active probe attempt sends a partial HTTP body while authorized. Only
after the server receives that body does the fixture call the real scheduler pause
operation; the completed request is rejected and makes no profile change. The
MCP client also verifies rejection after the original artifact run completes.
Evidence is checked through a newly opened database connection and the existing
recovery function. This is persistence verification, not a process-crash, VM
reconciliation or Claude conversation-resume test.

Cleanup attempts each owned resource even after another cleanup fails. It checks
MCP process exit, scheduler quiescence, server shutdown and temporary-directory
removal. SIGINT/SIGTERM request cancellation and cleanup. Cleanup failures preserve
the original diagnostic and make the result an error. An OS-level kill still requires external reconciliation; this script is
not the durable production VM lifecycle controller.

## Actual VM-to-domain bridge

```sh
npm run bridge:rehearse -- --image docker.io/docker/sandbox-templates:claude-code-docker@sha256:549730947ed8a43182547bb5628245fe6d6c089564dd73d2194e899f791d970f
```

This separate test requires the cached template, Docker sign-in and an empty local
MCP registry. It creates one mountless VM with all-host network denial, two CPUs,
2 GiB memory and one fixed MCP registration. All application state is synthetic.
It invokes no Claude model and transfers no provider credentials.

The registered host MCP process loads one private launch file. That file must be
owned by the current user, single-link, regular, non-symlinked, no more than 4 KiB
and inaccessible to group/other users. It holds only a run token and the exact
loopback domain-tool endpoint; it is not copied to the VM or embedded in registry
arguments. Every request still passes through the platform's run, attempt,
principal and mission checks. The host process remains trusted code with host
privileges; this is not an independently sandboxed MCP server.

The [verified report](domain-bridge-results.json) records:

- Authenticated context identifies Atlas; exact knowledge retrieval succeeds.
- Atlas's task changes; its identical retry returns the same result.
- A mutation of Iris's task fails and her task remains unchanged.
- Pause rejects both reads and writes through the actual gateway.
- After stopping the VM, unpausing the operator and restarting the VM, the old
  aborted run remains unauthorized. Reconnection does not revive authority.
- VM, MCP registration, host MCP process, scheduler, HTTP server and private
  fixture state are removed. Planned identities are checkpointed before creation.

The image-reference gate is now narrowed: the fully qualified repository/tag plus
digest above launches successfully with `--pull never`, and `sbx inspect` reports
the requested digest. A bare digest failed in an earlier experiment; that failure
does not require falling back to a mutable tag. This is evidence for the cached
image/runtime on this host, not portability across all sandbox versions.

During development, client bundling rejected top-level await in CommonJS, before
VM creation. A later cleanup check exceeded the bounded output limit because it
listed every host process; the scenario correctly returned an error. Cleanup now
checks only the unique launch-file identity with `pgrep`, rather than increasing
the output limit or accepting an unknown process state.

## Verification and remaining work

The full application suite passed all 128 tests, including the new work-cycle,
cancellation, launch-file and gateway-protocol checks. Type checking and build
passed. The final correct/incorrect scenario pair and pinned VM bridge were rerun
against the source fingerprint in the committed reports. Documentation validation
checks the 28 registered sources and their local links. Reports are fixture
evidence; counts are not a robustness or security score.

Still pending: a production VM episode adapter, durable VM-intent reconciliation,
guest artifact export, enforced clipboard-write denial, provider authentication,
real session resume/cancellation and usable quota admission. Current public Docker
settings and installed v0.45.1 expose clipboard image-paste control, not a verified
clipboard-write denial. The existing live gate is unchanged.

The next core change is the bounded VM lifecycle and remaining admission surface.
The independent Python/Inspect runner can consume the versioned scenario boundary
after that integration; no Python package or Inspect dependency is installed by
this increment. Then run the first measured real-agent episode, configure Discord
and compare a small team with the appropriate solo/delegation baselines. The
scripted scenario cannot justify a claim about model quality or team advantage.
