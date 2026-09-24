# Fixed worker tool scope experiment

Status: synthetic integration passed after the [worker review](REVIEW-2026-09-24.md),
2026-09-24. This checks a Docker MCP gateway boundary, not the complete Collective
worker adapter. No model, real account credential or application mutation was used.

## Experiment and result

The host registered a maintainer-written server exposing only `allowed_add`, a
bounded integer addition function with no filesystem/network actions. A mountless
VM was created with that server in `--static-mcp`. The host then registered a
second arithmetic fixture exposing `unlisted_add`, outside the fixed set.

The [recorded result](mcp-scope-results.json) includes the observed runtime/image
identity, fixture and bundled-client hashes, both phases and verified cleanup.

| Path | Before restart | After restart |
| --- | --- | --- |
| Configured MCP endpoint: list tools | Allowed arithmetic plus `mcp-exec` and `code-mode`; no unlisted tool | Same |
| Ambient gateway URL: list tools | Same restricted inventory | Same |
| Allowed arithmetic call through each endpoint | Returned the expected server identity and sum | Same |
| Explicit `unlisted_add` call | MCP unknown-tool error | Same |
| `mcp-exec` dispatch to `unlisted_add` | Tool-not-found error | Same |
| `code-mode` request for `unlisted_add` | Explicit unknown-tool response | Same |

This is four positive arithmetic calls and twelve denied attempts across the two
endpoint configurations and two phases. The endpoints resolved to the same host
gateway URL, so these are alternate configuration paths to one enforcement
boundary, not independent gateway implementations. Neither omitted client
configuration nor naming an unlisted tool bypassed that boundary in this test.

Code mode's unknown-tool response contained error text but omitted `isError`.
The verifier checks the exact denial semantics; a transport success or missing
error flag cannot establish a successful tool action. Regression cases cover
missing observations, exposed unlisted tools, unusable allowed tools, timeouts,
generic error text and duplicate result frames.

## What this permits us to build

Continue toward a fixed, run-scoped Collective MCP bridge using the existing
domain command services and official MCP SDK. Retain host-side principal,
mission-generation, job-attempt and permission checks on every request. The
gateway's fixed server set does not establish an agent's application identity,
prevent stale writes, ratify a permission, or enforce a model budget.

The gateway also exposes orchestration helpers. This test exercised their refusal
to resolve an unlisted tool; it did not audit their general code execution or
resource limits. Keep them in the explicit integration inventory. Credential
injection, real Claude sessions, cancellation of in-flight domain calls and host
clipboard-write restrictions remain separate gates in the
[worker design](WORKER-REHEARSAL.md#next-implementation-one-bounded-worker-episode).

An initial manual attempt to launch with the bare image digest reported by
`sbx inspect` reached image preparation but failed at container startup. The
known cached tag worked with the same MCP attachment. The successful experiment
therefore uses that tag and records the observed digest; it does not claim an
immutable launch reference. Resolve the supported pinned reference before live
admission rather than silently falling back from a failed pin.

## Reproduction

```sh
npm run mcp:rehearse -- --image docker/sandbox-templates:claude-code-docker
```

The command requires an empty local MCP registry and the reviewed SSH/skills/local
gateway settings. It registers two uniquely named pure arithmetic fixtures,
creates a private VM without host mounts or public egress, bundles the official
MCP SDK client from locked development dependencies, runs the test, restarts and
retests, then removes only its VM and registrations. It records planned identities
before dispatch and reports a pass only after cleanup. SIGINT/SIGTERM run cleanup;
an abrupt process/host loss still needs reconciliation from the saved identities.

The report is written to `test-results/mcp-scope-rehearsal.json`. No credentials,
HTTP authorization headers or complete agent configuration are recorded. Local
MCP fixture processes execute on the host and must remain maintainer-controlled.
This is a test-only integration; the application's live-launch gate is unchanged.
