# Foundation research and reuse decisions

Status: recorded research, with proposed recommendations. Checked 2026-09-23.
Upstream pages describe current moving branches; no candidate package has been
installed, benchmarked, licensed for a particular distribution, or accepted into
the runtime by this research. Pin versions and recheck contracts during a spike.

Follow-up: the [knowledge implementation record](KNOWLEDGE-IMPLEMENTATION.md)
contains the subsequent QMD 2.8.3/FTS5 lexical screening and its unmet quality gate.
QMD was installed temporarily for that experiment; no application dependency was
added. The repository is now tracked in local Git without a remote. The entries
below preserve the original research recommendations.

The [isolation follow-up](ISOLATION-REHEARSAL.md) records the subsequent runtime
inventory, current `sbx` installation/subscription sources, candidate experiment,
and lifecycle defects found using real disposable containers. The ordinary Docker
container experiment does not establish Docker Sandboxes or Claude compatibility.

## What changed after research

The previous plan committed too early to building retrieval directly on SQLite.
Keep our knowledge ownership and evidence contracts, but compare reusable search
and knowledge implementations before implementing the index. Likewise, choose
an execution boundary by testing a supported sandbox product rather than writing
our own isolation runtime. These are recommendations based on the sources below.

## Knowledge shortlist

| Candidate | Verified upstream capabilities | Fit and proposed decision |
| --- | --- | --- |
| [QMD](https://github.com/tobi/qmd) | MIT; local Markdown search; lexical, vector and reranking paths; MCP and a TypeScript SDK | First search-adapter spike. Retain Collective's document identities, access rules and immutable evidence outside its index. Measure model download, memory and indexing overhead before enabling hybrid search. |
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | AGPL-3.0; Markdown is canonical; MCP read/write/search; linked observations and relations; optional semantic retrieval | Strongest fuller knowledge-system candidate. Compare if its editing/graph workflow saves more than the synchronization and concurrency adapter costs. Do not assume hosted collaboration/backup features are in the local edition. |
| [Graphiti](https://github.com/getzep/graphiti) | Apache-2.0; temporal context graph, source provenance and historical relationships; Python, graph backend and model/embedding integrations | Revisit when changing relationships and historical questions are a measured retrieval problem. Extra ingestion inference and infrastructure need explicit allowance. |
| [Mem0](https://github.com/mem0ai/mem0) | Apache-2.0 SDK; agent/user memory infrastructure; library and self-hosted paths; managed benchmark results include proprietary optimizations | Consider for episodic/personal memory later. It does not by itself establish our protected document, acceptance or release contracts. Do not transfer its hosted benchmark scores to this app. |
| [Outline](https://github.com/outline/outline/blob/main/LICENSE) | Current license is BSL 1.1, with a future Apache change date | A possible human wiki interface, but do not label the current release unconditionally open source. It is not the first integration for agent execution. |

The license entries report upstream labels, not a conclusion about all possible
embedding, modification or hosted-distribution arrangements. Basic Memory's
[technical reference](https://docs.basicmemory.com/reference/technical-information)
also documents its license. Before committing to it, decide whether we are
operating a separate service or incorporating modified code, and review the
actual pinned license for that use.

Our recommendation is an adapter comparison, not “install all four.” The first
experiment compares QMD lexical search with a minimal FTS5 baseline on exactly
the same approved document snapshot and labelled queries. Test Basic Memory as
an alternative knowledge workflow if it can meet the versioning/access gates
without introducing two editable sources. See [design 2](designs/02-knowledge.md).

## Durable execution reuse

| Candidate | Verified source | Judgment for this project |
| --- | --- | --- |
| Temporal | Durable workflow history and recovery; activities still need retry/idempotency design. [History](https://docs.temporal.io/encyclopedia/event-history), [activities](https://docs.temporal.io/activity-execution) | Strong revisit option for independently deployed workers and long-running orchestration. Service operations and workflow versioning would add work to the personal pilot. |
| DBOS TypeScript | Durable execution library; its TypeScript setup requires PostgreSQL. [Integration](https://docs.dbos.dev/typescript/integrating-dbos), [transaction model](https://docs.dbos.dev/typescript/reference/datasource) | A closer alternative if we decide PostgreSQL is acceptable now. Do not infer TypeScript SQLite support from its Python SDK documentation. |
| Existing SQLite supervisor | Local source review: short episodes, one supervisor, durable jobs but incomplete transaction/retry contracts | Keep provisionally for a bounded command/run protocol. Stop extending it into a general workflow engine; use the decision triggers in [design 1](designs/01-execution.md). |

Neither a workflow SDK nor a queue can infer whether a restarted agent is
semantically repeating an earlier decision. The application must still supply
stable work identities, domain invariants and external-action reconciliation.

## Execution isolation reuse

- **Claude's current Bash sandbox:** already configured by the app. Its documented
  controls apply to sandboxed commands; in-process tools have separate permission
  rules. Validate the installed version's actual behavior, including native file
  tools and MCP, rather than counting settings as containment proof.
  [Claude sandbox documentation](https://code.claude.com/docs/en/sandboxing).
- **Anthropic sandbox-runtime:** Apache-2.0 process isolation implementation,
  using platform mechanisms on macOS/Linux. Useful for a lightweight controlled
  execution backend, but integrating authentication and protecting host-side
  brokers would still be our responsibility.
  [Upstream repository](https://github.com/anthropics/sandbox-runtime).
- **Docker Sandboxes:** current documentation describes microVMs, private Docker
  engines, controlled mounts and network policy. This is an integration candidate;
  no assumption is made that the whole product has an open-source license.
  Workspace mounts remain writable host resources, and local MCP servers remain
  trusted host integrations. Disable SSH-agent forwarding and shared writable
  skills in our launch policy. [Security model](https://docs.docker.com/ai/sandboxes/security/).

Docker's getting-started page describes Claude OAuth subscription login for Max,
Team and Enterprise. Verify this user's actual plan, non-interactive episodes,
resumption, quota access and local MCP bridge in a spike; the documentation is
not proof of compatibility with this installation.
[Docker setup](https://docs.docker.com/ai/sandboxes/get-started/).
Its kit interface supports separate interactive and non-interactive commands,
which is promising for our process adapter.
[Kit reference](https://docs.docker.com/ai/sandboxes/customize/kit-reference/).

Local check: Docker CLI 23.0.5 is installed, `sbx` is absent, and no usable sandbox
command appeared in the CLI help. No sandbox was installed or started. See
[design 3](designs/03-workspaces-prs.md) for stages and compatibility gates.

## PRs and evaluation

The current GitHub code constructs private-repository and draft-PR requests, but
never uploads local commits. Both GitHub and Discord configuration-presence
checks returned false. At that baseline the platform directory had no `.git`. Local Git has since
been initialized; no remote is configured. The new protocol tests use fake credentials and an in-process
HTTP substitute. They do not establish account permissions or live GitHub success.

GitHub's API separates creating a PR from publishing a branch/ref. Our design
must bind approval and evidence to an immutable candidate, then verify the
resulting remote SHA. [PR API](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request),
[ref API](https://docs.github.com/en/rest/git/refs#create-a-reference).

For evaluation, reuse existing test runners for executable outcomes. Promptfoo
is a candidate for later agent-policy comparisons, with an MIT root license and
custom evaluation support; check the pinned components actually used. Configured
scripts are trusted code, so keep our protected evaluation configuration outside
agent workspaces. [License](https://github.com/promptfoo/promptfoo/blob/main/LICENSE),
[trust boundaries](https://github.com/promptfoo/promptfoo/security).
No evaluation package is required to record criteria, evidence hashes, verdicts
and limitations. Those domain records are specified in [design 4](designs/04-progress.md).

## Highest-return next milestone

Build one complete, bounded work cycle: an agent finds a prior constraint, creates
a candidate in an isolated project, another agent evaluates that exact candidate
from durable context, and the broker can open an authorized private draft PR.
The milestone must survive restart and preserve its evidence.

Begin with the smallest transaction/mission fix and the knowledge-adapter spike.
Run the sandbox compatibility spike before live code execution. Defer general
extension installation, a universal graph ontology, distributed orchestration and
visual expansion until this cycle demonstrates useful progress. The four designs
define stop/go experiments rather than assuming every proposed dependency works.
