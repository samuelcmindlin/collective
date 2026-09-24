# Worker isolation and behavioral evaluation gate

Status: controlled candidate rehearsal completed, 2026-09-24. This is a maintainer-run compatibility
rehearsal, not permission to run autonomous workers. It follows
[the workspace design](designs/03-workspaces-prs.md) and
[criterion-bound evaluation](PROGRESS-IMPLEMENTATION.md).

## Decision and scope

Separate two gates: containing a candidate program, and containing the complete
Claude process with subscription authentication, session state and MCP access.
The existing native harness has only configuration/fake-process tests for the
latter. Keep that gap visible.

For the first executable check, use a disposable Docker container with **no host
mounts and no network**, containing only an approved Node runtime and one frozen
source file supplied as bytes. The host evaluator sends input and compares output.
The candidate never loads inside the evaluator process and cannot replace its
assertions, policy, receipt writer or expected results. No candidate test command,
package script, dependency installation or plugin is executed on the host.

Keep this path behind an explicit maintainer rehearsal command. Do not add an
agent-facing executable criterion until worker compatibility, a maintained runtime,
durable dispatch/recovery and result reconciliation are established. The
rehearsal binds its observations to real fixture submission IDs, criterion hashes
and artifact hashes. Those observations are experimental records, not required
checks in the production submission ledger. No task is accepted automatically.

## First contract

- One UTF-8 JavaScript module, at most 64 KB; no source tree, archives or dependencies.
- One bounded JSON input on stdin and JSON output on stdout; fresh container per case.
- Fixed non-root UID, all capabilities dropped, no privilege escalation, default
  seccomp, isolated IPC and PID namespaces, 128 MiB memory without extra swap,
  half a CPU, 32 PIDs and 16 MiB disposable scratch space.
- Root filesystem read-only; no Docker/SSH socket, host home, supervisor state,
  evaluator policy, model credentials or tool gateway is mounted or passed in.
- Wall-clock and output bounds enforced outside the container. Destroy the
  container by its supervisor-chosen identity, then verify absence. Unknown
  cleanup, setup errors, timeouts and oversized output cannot become passes.
- Resolve the image to a local immutable image ID. Never pull during evaluation.
  Record the image, runtime, policy and source hashes with every observation.

The first behavior suite exercises a small matching-game state machine: initial
state, a mismatch, a successful match, completion, invalid/repeated selections
and restart. The maintainer owns the examples and oracle. Passing these examples
does not establish general correctness, security, UI playability or enjoyment.

## Publication boundary

Publication now has a deliberately narrower source contract: a top-level,
single-link regular file. Nested outputs must be copied to the workspace root.
Open the leaf with no-follow/nonblocking flags, inspect the opened descriptor,
read at most the bounded size plus one byte, and reject observable changes during
the read. This removes worker-controlled intermediate path traversal and the
separate path-check/path-read race. The supervisor must own workspace ancestors.
These checks cannot protect against an uncontained process with the supervisor's
OS identity; full worker isolation remains necessary. A snapshot identifies the
copied bytes, not a coherent Git checkout or a proven authored result.

## Runtime findings

The installed macOS Docker Desktop is 4.19.0, Engine 23.0.5, runc 1.1.5 (2023).
It starts successfully, but it is not a maintained baseline for autonomous code.
Use only our controlled fixtures for this rehearsal. Existing images, containers
and application state are outside its cleanup scope.

Current [Docker Sandboxes installation documentation](https://docs.docker.com/ai/sandboxes/install/)
describes a separate `sbx` installation and Docker sign-in, without requiring
Docker Desktop. This machine meets the documented macOS/Apple silicon prerequisites,
and `sbx` was initially absent. Docker Sandboxes **0.45.1** is now installed via
the official Homebrew tap; `sbx version` reports commit
`9d79d90ee4c5d297fb3d36b75384e8cea7a4fbcb`. Its actual `sbx ls` readiness check
stops with **Not authenticated to Docker** and instructs `sbx login`.
No sandbox or model was launched through `sbx`.
The [Claude subscription flow](https://docs.docker.com/ai/sandboxes/get-started/)
uses login inside the sandbox; that has not been tried here. A native-process
alternative is [Anthropic sandbox-runtime](https://github.com/anthropics/sandbox-runtime),
but its filesystem/network controls alone do not establish the whole-worker
credential, lifecycle and resource contract.

The remaining local setup action is to run `sbx login` in a terminal and complete
Docker's browser sign-in. No password/token should enter this repository or chat.
After that, use a dedicated disposable worker directory, an explicit locked-down
network policy and a reviewed launch kit. Do not launch from the platform checkout:
the default workspace sharing would give the worker that checkout. Verify the
actual subscription plan/login, restricted non-interactive CLI, resume/cancel,
MCP bridge and quota path before replacing the current disabled native backend.

The candidate policy uses Docker's documented
[resource constraints](https://docs.docker.com/engine/containers/run/),
[no-network driver](https://docs.docker.com/engine/network/drivers/none/) and
[default seccomp policy](https://docs.docker.com/engine/security/seccomp/).
Actual probe results, rather than flags alone, determine this gate's outcome.

## Results and corrections

The [complete final report](isolation-rehearsal-results.json) records the pinned
Linux/ARM64 Node image, Engine/containerd/runc versions, evaluator source hash,
container policy hash, exact fixture criteria/submissions and per-case observations.
It includes 18 disposable container executions. All final containers were removed
and absence was verified before the corresponding result was classified.

| Gate | Observation |
| --- | --- |
| Allowed operation | Scratch write/read succeeded as UID 65534 |
| Host boundary | Synthetic supervisor/other-worker reads and writes, symlink traversal, host operator/gateway connections and fake SSH socket access failed; no Docker socket or supplied credentials |
| Runtime enforcement | No effective capabilities, no-new-privileges and seccomp active; no routable interface; network/DNS attempts failed; cgroup memory/CPU/PID limits observed; bounded process exhaustion enforced |
| Resource/lifecycle failures | Infinite loop timed out; output flood was bounded; allocation fixture was OOM-killed; cancellation and leader exit removed descendants with the container |
| Behavioral detection | Five examples passed and the deliberately broken restart failed; all six examples passed on a new corrected artifact/submission |
| Frozen source | Replacing the workspace file after publication did not change evaluated bytes |
| Evidence/review distinction | Earlier rejection remains in the fixture ledger; corrected task remains in review, without automatic acceptance |
| Application regression suite | 117 tests pass; build and documentation validation pass |

The [earlier failed diagnostic](isolation-diagnostic-results.json) is retained.
The initial interface assertion counted every sysfs device and rejected inactive
`tunl0`/`ip6tnl0` entries. Inspection found only loopback addressed; the corrected
probe requires no non-loopback UP interface, no non-loopback address and no IPv4
route, in addition to failed network attempts. This was a probe correction, not
a relaxation of the container network policy.

A separate real timeout exposed Docker Desktop's CLI wrapper: killing the parent
left `com.docker.cli` holding pipes open, which delayed container cleanup. The
rehearsal was stopped and that exact fixture removed. The client launcher now
kills the process group, explicitly closes pipes and bounds promise completion;
container destruction/absence remains a separate step. A fake-wrapper regression
reproduces that failure mode, and the final real timeout succeeds. The native
Claude adapter similarly kills remaining group members on leader exit. Descendants
that create a new OS process group still require whole-worker containment.

`npm test` does not run Docker or make model calls. The separate command below
requires an installed/running Docker engine and an approved local Linux Node image.
Pull an official image deliberately, inspect its immutable image ID, then run:

```sh
npm run isolation:rehearse -- --image sha256:<local-image-id> --socket unix:///absolute/docker.sock
```

The command uses an empty temporary Docker configuration, an explicit local
socket and only the checked-in fixtures. It writes `test-results/isolation-rehearsal.json`,
uses its own temporary SQLite database, removes its own containers and leaves
the live/demo data untouched. It never upgrades the container runtime, pulls an
image, logs into a provider, or enables agent execution. The application schema
remains v4; no data migration was needed for this increment.

The supervisor and native harness both enforce the current live-launch gate.
Connecting Discord, entering fresh quota, or pressing Run cannot turn an
unverified native worker into an allowed one. Simulation and local setup remain
available. `npm run doctor` reports this readiness gap explicitly.

## Next integration boundary

Executable checks must not run inside the current synchronous task transaction.
Prepare an immutable evaluation intent containing mission revision, job attempt,
task version, submission/evidence identities, policy hash and pinned runtime.
Persist that intent before dispatch. Run the evaluator asynchronously. Reconcile
container identity after restart, and append the result only after rechecking
authority and all frozen identities in one transaction. Late or unknown results
remain historical observations; they never accept current work. Retry of an
identical command returns its durable result, without silently running another
experiment. The acceptance path must require the matching protected result.

This needs a small dedicated evaluation ledger and a schema migration, not an
optional result supplied by an agent to `task_submit`. Keep that integration
separate from the compatibility experiment so runtime failures cannot weaken
the already-implemented evidence and review protocol.
