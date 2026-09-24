# Design 4: Measured progress and a bounded live pilot

Status: partially implemented; see the [implementation record](../PROGRESS-IMPLEMENTATION.md). Refines [HLA](../HLA.md)'s work loop and
plan slice 5. Links to candidate execution in [design 3](03-workspaces-prs.md) and
durable memory in [design 2](02-knowledge.md). No real-model quality claim is made.

## What the system must measure

A broad mission creates uncertainty, not a missing required form field. Agents
should propose approaches and cheap experiments while retaining the original
mission. Measure evidence gained and outcomes produced. Task volume, conversation
volume and agreement among agents are diagnostic signals, not goal attainment.

For “create a game,” separate executable behavior from enjoyment. For “fund
yourselves,” early progress can be a grounded opportunity hypothesis and tested
prototype, while money and human contact remain unavailable. For “establish a
mission,” compare proposed directions and tradeoffs; operator acceptance may be
the meaningful terminal outcome. Do not manufacture numeric scores for subjective
success or let agents silently redefine the user's objective to an easier one.

## Records and authority

| Record | Required contents |
| --- | --- |
| Outcome criterion | Mission revision, criterion version, description, type, evidence requirement, evaluator policy, proposed/accepted status |
| Experiment | Hypothesis, predicted observation, method, budget, stopping condition, dependencies |
| Submission | Task/experiment, candidate or document revision hashes, criterion versions, known limitations |
| Evaluation | Evaluator/run ID, protected check version, inspected evidence IDs, result, logs, environment and uncertainty |
| Review | Independent principal, referenced evaluations, criterion-by-criterion verdict, rationale, unresolved questions |
| Outcome observation | What changed outside the task ledger, baseline, measurement method, time and source |

Criteria types: deterministic check, empirical observation, subjective judgment
and operator decision. A criterion version declares what counts as evidence; a
candidate cannot rewrite that version. Agents can propose stronger/weaker checks
with reasons, but authorization to revise acceptance policy is separate from
authoring the candidate being evaluated.

## Evaluation protocol

1. Validate that a submission belongs to the active mission and references an
   immutable candidate/revision. Freeze its applicable criterion versions.
2. Schedule an evaluator with scoped access to that evidence. For code, provision
   a clean environment from the candidate, not the builder's mutable workspace.
3. Run protected checks and save receipts before the review verdict. Agent-written
   tests can be included, labelled with their author and limitations.
4. A different agent examines evidence and failed checks, then gives a structured
   per-criterion verdict. A note such as “looks fine” without bindings is invalid.
5. Accept only the criteria whose required evidence passed. Mark subjective or
   externally blocked criteria honestly; do not coerce them into a fabricated pass.
6. Record the next experiment, revision, durable request or operator acceptance.

Required deterministic check failures cannot be overruled by an ordinary agent
review. Explicit operator exceptions are new audit records with scope and reason;
they do not rewrite the failed result. An inspection receipt proves access to an
artifact, not comprehension. Independent review is complementary to reproducible
checks, and two agents using the same model can share failure modes.

## Reuse

Use the existing test runner and narrowly scoped artifact-specific checks first.
Browser interaction checks can use an established browser-test runner inside the
evaluator environment when a game needs them. Evaluate Promptfoo for repeated
agent-policy/model comparisons once fixed cases exist; keep its executable
configuration protected and audit data destinations. See [research](../RESEARCH.md).
Do not build an evaluation framework or incur judge-model spend before it helps
answer a specific quality question.

## Pilot design

Use two agents, a fixed small mission, fixed starting state, limited episodes and
a frozen rubric. One produces and one reviews; both may collaborate through
Discord. Give a single-agent baseline the same mission, tools and total allowance
and apply the same external checks. Keep the coordinator overhead visible rather
than hiding it outside the budget.

Use multiple trials before claiming an advantage; a single success is a smoke
test. Record model/CLI versions, prompts/config revisions, task fixture hash,
starting knowledge, context manifests, calls/turns/tokens, account quota readings,
elapsed time, failure causes, output quality and human intervention. Subscription
account usage cannot precisely isolate this project's token share or billed
dollars, especially when the user is also using Claude.

| Scenario | Observation required |
| --- | --- |
| Earlier constraint | Agent finds a relevant decision after distracting new notes and cites its revision |
| Restart/handoff | Fresh or resumed session continues from durable work without losing accepted commands |
| Room discussion | Only addressed occupants hear live speech; Discord delivery and catch-up are observable |
| Candidate review | Reviewer evaluates the exact candidate; a deliberately broken candidate fails its required check |
| Permission denial | One persistent request leads to an alternative plan, not repeated identical requests |
| Mission replacement | Old work cannot mutate current mission state; history stays readable |
| Quota/cancellation | Stale/exhausted telemetry stops admission and cancellation contains child processes |
| Private publication | Approved tested candidate SHA matches the private draft PR; no merge or deployment is implied |

Not all scenarios need models: transport, permissions, stale-run and fault tests
should be deterministic first. Spend model allowance on actual reasoning,
retrieval/handoff behavior and useful collaboration. The GitHub scenario follows
configuration and scoped authorization; it is not required to test local quality.

## Pilot prerequisites and stopping rules

New Discord server setup, supported Claude subscription authentication, verified
execution restrictions, and fresh quota readings are prerequisites for live code
work. Current setup has no Discord or GitHub configuration. Automatic quota
readings previously lacked usable windows; a manual fresh reading can support a
short supervised run while unattended operation remains gated.

Stop the trial on isolation failure, unknown external effect, exhausted allowance,
stale required telemetry, criterion tampering, repeated non-progress or the episode
cap. Preserve partial evidence and failed runs in the result; do not retry until
the evaluation silently becomes a success. Allow user feedback to create a new
trial/mission revision without erasing the original result.

## Decision after the pilot

Report quality/evidence coverage, intervention count, latency and consumed resources
together. Do not collapse them into one opaque progress score. If collaboration
adds cost without improving outcomes, change roles/routing or reduce the team.
Expand to longer business-hour runs only after recovery and quota reliability are
observed. Add tools or world features when failed experiments identify a concrete
benefit, using the existing persistent request and release paths.

## First implementation contract

This increment implements task-level evaluation. Mission criteria and final
operator acceptance retain their existing authority. Agent-created task criteria
are explicitly **agent-proposed**, frozen at task creation and never editable
through candidate tools. A new task is a new proposal, not a revision of the
user's mission or proof of its completion. Criterion policy editing and operator
ratification are later work.

The durable records are:

- `progress_criteria`: one immutable version-1 criterion set per task, with author,
  mission revision, authority and a canonical hash. A plain acceptance string
  becomes one subjective criterion named `acceptance`.
- `progress_submissions`: immutable attempts, each binding every criterion to
  exact artifact IDs/hashes/sizes or knowledge document/revision IDs/hashes.
  Each carries limitations, the frozen criterion hash, and protected check results.
- `progress_inspections`: submission-specific evidence read receipts including
  principal, evidence hash, content range and job/attempt when available.
- `progress_evaluations`: independent reviews bound to one submission, containing
  every criterion verdict, rationale, evidence IDs and inspection receipt IDs.
- `progress_legacy_tasks`: exact pre-migration task records. No evaluations are
  fabricated for prior accepted work. An old pending review must be resubmitted
  by its owner under the new contract; historical completion remains labelled.

`task_create` optionally takes up to 12 typed criteria. `task_submit` takes
criterion/evidence bindings and limitations; the old `evidenceIds` shorthand is
valid only for a single-criterion task. `task_get` returns the frozen contract,
selected submission, checks and evaluation, plus bounded attempt summaries.
`task_evidence_read` verifies the selected submission's exact evidence and returns
at most 12,000 characters with explicit truncation. Its receipt proves access to
that range, not comprehension or a complete reading. Binary receipts describe
metadata access only; they must not be represented as visual inspection.

`task_review` requires `submissionId` and a verdict for every criterion. All
bound evidence IDs must be cited. Acceptance requires all verdicts to pass, fresh
integrity/access validation, and a matching evidence-read receipt for the reviewer
for every bound item. Rejection does not require successful reads, so corrupted
or withdrawn evidence can still receive a durable failure review. A stale
submission ID cannot review its replacement even if task version is omitted.

The first protected evaluator is `json.fields.v1`: a bounded UTF-8 JSON artifact
must be an object containing specified top-level fields with declared primitive,
array or object types; strings must be nonempty and numbers finite. The configuration
is frozen with the criterion. The evaluator executes no submitted code, resolves
no references, loads no plugins and performs no network calls. Input is capped at
250 KB. Passing establishes this narrow data contract, not usefulness, truth,
playability or enjoyment. Subjective criteria record judgment without fabricated
executable results.

Checks run synchronously during submission. A failed/error check still creates a
submission and wakes review; its failure is durable and cannot be overridden by
an agent's passing verdict. Reject, revise and resubmit instead. Review acceptance,
counters, dependency wakeups, ledger records, events and command receipts commit
atomically. Identical command retries return the original result; changed intent
needs a new command ID. Reads are audited but need no mutation command identity.

Schema v4 adds the ledgers and pauses migrated collectives. Existing entities,
knowledge, events and command receipts are preserved; the migration is rehearsed
on copies before live data is upgraded. Candidate files remain outside SQLite
transactions. There is no distributed evaluator, general test-execution service,
automatic rubric revision, semantic correctness guarantee or complete context
budget in this increment.

Acceptance tests must cover failed checks despite a passing reviewer, missing and
mismatched criteria/evidence, private or withdrawn sources, corruption after
submission, owner review, missing inspection, stale submission/mission, duplicate
commands, rollback at each ledger write, immutable rejected attempts and reopening.
A deterministic rehearsal exercises the same APIs with explicitly labelled fixture
judgments; it does not claim to validate a real model's reasoning.
