# Evaluation and collective organization: research record

Recorded 2026-09-24. This preserves the research and decisions discussed with the
operator before implementing the first reproducible work cycle. Product features
in these sources change; integration claims require a pinned compatibility test.
This document records evidence and hypotheses, not proof that Collective works.

## Current evidence and limits

The [progress implementation](PROGRESS-IMPLEMENTATION.md) freezes task criteria,
submissions, evidence and reviews. Its production deterministic check,
`json.fields.v1`, checks required top-level JSON fields and types, not meaning.
Agents propose these task criteria; they are not ratified mission policies.
Inspection receipts prove access to bytes, not understanding. A different reviewer
can share the author's errors. A structured but poor review can accept irrelevant
knowledge. Software regression tests do not establish real-agent effectiveness.

The [candidate rehearsal](ISOLATION-REHEARSAL.md) compares frozen JavaScript
artifacts against protected behavioral examples. It is maintainer-only evidence,
not a production acceptance check or general repository/browser evaluator. The
deliberately broken game failed restart; its corrected version passed six cases.
The [knowledge screening](KNOWLEDGE-IMPLEMENTATION.md) measured recall@5 of 0.75
for both FTS5 and QMD lexical search, below the proposed 0.9 gate. Neither result
establishes end-to-end mission quality. No completed real-model pilot or fair
single-agent/team comparison exists yet.

## Reusable evaluation tools

| Candidate | Documented capability | Proposed use and caveat |
| --- | --- | --- |
| [Inspect AI](https://inspect.aisi.org.uk/) | Python datasets, scorers, external agents, sandbox integrations and experiment viewer | First experiment-runner candidate. Drive the actual application through an adapter; do not recreate Collective's organization inside Inspect. |
| [Inspect SWE](https://meridianlabs-ai.github.io/inspect_swe/) | Claude Code and other CLI agents in sandboxes, with model calls proxied through Inspect | CLI compatibility does not establish subscription authentication or billing compatibility. Never silently switch to paid API credentials. |
| [Harbor](https://docs.harborframework.com/core-concepts/agents/pre-integrated-agents) | Existing CLI agents and sandboxed task evaluation | Compare before expanding our custom executable runner. Its [separate verifier](https://docs.harborframework.com/core-concepts/tasks/separate-verifier) is opt-in; default grading shares the agent's container. Validate the chosen boundary. |
| [Langfuse](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk) | Python/TS experiments, tracing, datasets and custom scoring | Potential persistent analysis interface after initial experiments. [Self-hosting](https://github.com/langfuse/langfuse/blob/main/docker-compose.yml) adds several services; defer that burden initially. |
| [Promptfoo](https://www.promptfoo.dev/docs/providers/custom-api/) | Custom application providers and declarative comparisons | Consider focused regressions and [adversarial tests](https://www.promptfoo.dev/docs/guides/llm-redteaming/) for retrieved content, permission requests and tools. |
| [Ragas](https://docs.ragas.io/en/latest/concepts/metrics/available_metrics/) | Context precision/recall, faithfulness and other retrieval/answer metrics | Add when evaluating agents' use of retrieved knowledge. Model-based metrics need calibration against human labels. |
| [Phoenix](https://arize.com/docs/phoenix/) | Tracing, evaluation, datasets and experiments using OpenTelemetry/OpenInference | Alternative to Langfuse, not an additional required deployment. |

No package in this table is selected as a trusted acceptance authority. Tool
research is not an installed integration, license audit or measured comparison.
The first implementation should reuse a small runner and viewer, not deploy all
of these systems or build their features ourselves.

## What multi-agent research supports

| Source | Evidence | Limit and implication for Collective |
| --- | --- | --- |
| [Towards a Science of Scaling Agent Systems](https://arxiv.org/html/2512.08296v1), Dec 2025; [Google account](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/), Jan 2026 | Controlled comparison of 180 configurations across four benchmarks. Task decomposition and coordination topology materially affect outcomes; sequentially dependent tasks can deteriorate with more agents. | No universally best topology. Results on those models/tasks are not a law for all coding or workplace missions. Test resource-matched alternatives. |
| [Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), Jun 2025 | Reports benefits for independent parallel research directions, with higher token consumption and difficulties on highly dependent work. | Production engineering evidence for delegation; reported gains do not establish equal-cost superiority for our workload. |
| [Anthropic parallel Claude compiler experiment](https://www.anthropic.com/engineering/building-c-compiler), Feb 2026 | Sixteen Claude instances, isolated working copies, shared Git state and task claims. Tests and decomposition enabled progress. Agents duplicated and overwrote fixes at tightly coupled bottlenecks until the evaluation environment was improved. | Close precedent for separate CLI instances collaborating. Capability demonstration with substantial spend, not a controlled solo comparison or evidence for visual rooms. |
| [Cursor long-running agents](https://cursor.com/blog/scaling-agents), Jan 2026 | Flat self-coordination suffered contention and weak ownership; planner/worker separation improved the experiment. | Useful engineering observation, not evidence that hierarchy always wins. |
| [Cursor swarm economics](https://cursor.com/blog/agent-swarm-model-economics), Jul 2026 | Further experiments emphasize decomposition, environment and corrective feedback. | The article explicitly declines quality conclusions from informally graded solo baselines. Do not interpret cost charts as a proven solo/team quality comparison. |
| [Project Vend phase two](https://www.anthropic.com/research/project-vend-2), Dec 2025 | Persistent business agents communicated through Slack. A manager reduced discounts but increased other concessions; agents sometimes drifted into unproductive conversations. | Particularly relevant to open-ended missions. Role labels, agreement and proxy targets do not guarantee useful outcomes. Changes were not an isolated randomized test of management. |
| [MAST](https://arxiv.org/abs/2503.13657), revised Oct 2025 | More than 1,600 annotated traces across seven frameworks; 14 failure modes grouped into system design, inter-agent alignment and verification. | Use the taxonomy to classify our failures; do not transfer benchmark failure rates to Collective. |
| [MultiAgentBench](https://arxiv.org/abs/2503.01935), 2025 | Interactive scenarios, milestone measures and comparisons of communication topologies. | Reuse scenario/measurement ideas and test topology rather than assuming all-to-all discussion is beneficial. |

The synthesis is our interpretation: decomposition, additional context capacity,
specialization, independent checking and durable coordination can justify teams.
Communication, duplicated work, shared blind spots and reconciliation can erase
those gains. There is not strong controlled evidence in this review for our exact
combination of persistent peers, spatial communication, open-ended missions and
nested swarms.

[Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) are documented
as experimental and disabled by default, with no nested teams. Their availability
does not prove arbitrary recursive organizations are beneficial. Recheck current
CLI behavior before integration. Collective currently disables native Agent/Task
delegation and keeps live execution gated.

## Persistent members and rooms

Distinguish temporary helpers, persistent members with durable responsibilities,
and organizations choosing work over time. Identity and knowledge should persist;
individual processes or indefinitely growing conversations need not. Persistent
context can preserve useful continuity or entrench mistakes. Both are hypotheses.

[Generative Agents](https://arxiv.org/abs/2304.03442), 2023, demonstrated believable
behavior and social coordination in a simulated town. Its endpoint was
believability, not workplace productivity or economic value.
[TheAgentCompany](https://arxiv.org/abs/2412.14161), revised 2025, provides a
simulated workplace with documents, websites, coding and coworkers. It supports
realistic work scenarios, not a claim that a spatial metaphor improves outcomes.

Retain rooms as configurable communication groups: explicit audience, project
context, pinned knowledge, bounded meetings and human visibility. Movement stays
immediate. Membership does not grant new permissions. Unaddressed speech should
not wake every occupant. Durable knowledge and asynchronous tasks need not wait
for a meeting. Test agent performance separately from human comprehension of the
visual environment. A headless execution path must remain possible.

## Agent-accessible evaluation and controlled improvement

Agents should be able to request bounded, preauthorized evaluations of artifacts,
retrieval, handoffs, workflows and proposed organizations. Every descendant and
experiment counts against a global resource allowance, with visible ownership,
stopping conditions and cancellation. Requesting evaluation grants no additional
tools, publication rights or ability to edit the acceptance ledger.

Development tests may be agent-authored and fully inspectable. Protected
acceptance/regression suites have separately reviewed policies. Keep held-out
cases, limit repeated access and preserve failed attempts; otherwise adaptation
can overfit a familiar suite. Policy revisions are new records, not edits to an
already frozen submission. Judge-model evaluations require human calibration and
an explicit allowance. A judge's opinion cannot override a required failed check.

[GEPA](https://arxiv.org/abs/2507.19457) proposes and evaluates prompt updates using
execution trajectories and textual feedback. Revisit it after trustworthy
scenarios exist. This kind of workflow/prompt optimization does not require
training our own model and is not automatically reinforcement learning.

## Relationship to reinforcement-learning environments

Collective has state, observations, actions, transitions and feedback. Observations
are partial and actions asynchronous. [PettingZoo](https://pettingzoo.farama.org/api/aec/)
provides relevant multi-agent environment API ideas; [AgentGym](https://arxiv.org/abs/2406.04151)
provides an exploration/learning environment precedent. Neither is a required
production dependency.

Borrow resettable scenarios, fixed starting state, controlled clocks, recorded
trajectories, explicit termination and reproducible scoring. A trajectory can be
rescored; a fresh model execution is not deterministic replay. Actual RL adds a
learning algorithm updating a policy using feedback. Keep correctness, preference,
resource use, intervention and violations distinct instead of inventing one
universal reward for broad human goals.

## Deferred experiments and return criteria

Compare one CLI without delegation, one CLI with bounded helpers, a small
persistent team, and that team with bounded helpers. Separately vary room routing.
Use the same missions, starting knowledge, tools and total allowance. Include
coordination/review costs; report common scoring costs separately. Compare quality
at equal resources and time to a quality threshold. Repeat trials, preserve all
failures, blind subjective review where possible, and report uncertainty.

Start with artifact repair, cited research, constraint-preserving handoff and
permission-denial recovery. Longer sequences must measure whether persistence
earns its cost. Neither task count nor conversation volume establishes progress.
For subjective missions, operator judgment and observed intermediate outcomes
remain necessary.

Resume these experiments once the [reproducible work-cycle design](designs/05-work-cycle.md)
has a verified real-worker path. Add semantic retrieval when measured misses
warrant it; add nested delegation when global accounting/cancellation works; add
automatic evolution only after held-out evaluation and rollback are available.
