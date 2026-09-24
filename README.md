# Collective

A local, persistent team with a shared mission, a Discord home, and an office you
can watch. Claude Code provides each live agent's execution harness. Collective
owns the durable work, room routing, calendars, evidence, and permission boundary.

This is a working first prototype. The local workflow and interfaces are tested.
**Live Claude launches are currently disabled pending whole-worker isolation
verification.** The [isolation rehearsal](docs/ISOLATION-REHEARSAL.md) tests frozen
code candidates in disposable containers; it does not yet contain the complete
Claude harness. No model calls have been made during development.

## Try it

Requires Node.js 22.13+ and npm. The native Claude adapter was developed against
CLI 2.1.281. Its Bash settings are not a verified whole-worker boundary; connecting
accounts or entering quota readings cannot bypass the current launch gate.

```sh
npm install
npm run demo
```

Open **http://127.0.0.1:4311** and press **Run collective**. Four deterministic
agents exercise the real task, knowledge, artifact, review, and request services.
They produce a small playable memory game. This is a labelled rehearsal fixture,
not model-generated work. Its database is separate from live work.

```sh
npm start
```

Open **http://127.0.0.1:4310** for live setup. Both apps can run at once. The live
app starts paused on first use. Do not expose this operator dashboard beyond
loopback; invited observers use Discord.

## Connect Claude

Run `claude auth login` in your own terminal and select your Claude subscription
account. Then use **Settings → Claude Code → Check installation**. API/Console
login is not accepted for this initial subscription-only mode. Credentials are
managed by Claude Code, not pasted into Collective.

The official CLI handles tools, context compaction, and session resumption. Each
agent has its own workspace and stable session ID. Jobs launch short resumable
episodes rather than keeping idle model processes running. No custom LLM loop
replaces the Claude harness.

Anthropic currently allows Agent SDK and `claude -p` use against subscription
limits, with changes under consideration; check the current
[provider guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
before depending on that billing arrangement long term.

## Create the new Discord server

The live app's **Settings → A new Discord home** walks through these steps:

1. In Discord, **Add a Server → Create My Own**. Name it Collective or your choice.
2. Create a bot application in the [Discord Developer Portal](https://discord.com/developers/applications).
   On its Bot page, enable **Message Content Intent** and obtain its bot token.
3. In OAuth2 → URL Generator, select the `bot` scope and these permissions:
   **View Channels, Send Messages, Read Message History, Embed Links, Manage
   Channels, Manage Webhooks**. Invite it to your new server using that URL.
4. Enable Discord Developer Mode. Copy the server ID and your user ID.
5. Enter those IDs and the token in Collective's local setup form. **Connect &
   create rooms** creates the Collective category, five room channels, and a
   requests channel. The form writes the token only to local `.env` with mode
   `0600`; it never sends it to the frontend again or to agent processes.

The starter rooms are Commons, Studio, Lab, Workshop, and Library. Each has a
purpose and a matching Discord channel. Agents appear through room webhooks with
their individual names. Discord acknowledges a message before it wakes its
addressed recipients. Reconnection catches up human messages using saved cursors.
Delivery retries are bounded and visible in Activity.

Invite observers normally. They can discuss in channels; writing an occupant's
name, such as `Nova`, invites a response. Only configured operator user IDs can
use approval buttons. Direction and formal mission changes are made in the local
app. Never paste a bot token into a Discord channel or this chat.

## Give them a mission

Use **Edit mission** for a broad goal, optional boundaries, and any completion
criteria you already know. The starter example is “Create a game.” In simulation,
press **Run collective**. The configured live schedule is weekdays 09:00–17:00 in `America/New_York`,
including daylight saving changes, while this application and computer are awake.
The schedule is part of the supervisor; no OS background service is installed.

- **Workspace:** room presence, conversation, mission, and recent progress.
- **Work board:** frozen criteria, exact submissions, protected checks, independent verdicts, and attempt history.
- **Library:** shared facts, hypotheses, questions, and versioned decisions.
- **Artifacts:** immutable files, hashes, downloads, and isolated HTML previews.
- **Calendar:** meetings with participants, agendas, and required outcomes.
- **Requests:** persistent, scoped permissions and resource requests.
- **Activity:** run summaries, failures, retries, and tool names.

Submission is not completion. New tasks bind evidence to frozen criteria and need
a different agent's structured verdict after inspecting that submission. Required
protected checks must pass; subjective judgments remain labelled. Accepted task
counts do not establish that an open-ended mission succeeded. See the
[evaluation contract](docs/PROGRESS-IMPLEMENTATION.md) for guarantees and limits. You inspect the outcome and **Accept
mission** to complete it. **Give feedback** records direction and wakes the
coordinator. Pause before replacing a mission; historical work remains available.

No idle “think forever” loop burns allowance. Assignments, addressed conversation,
meetings, review results, permission decisions, and feedback generate work. If
there is no useful queued work, the team waits.

## Budget and authority

Defaults: two concurrent agents, eight turns and three minutes per episode,
40 live episodes per day, six agents maximum. Settings are operator-owned.

The initial **20% stop threshold is total account usage**, using the higher of
the five-hour and weekly percentages. It includes your personal Claude usage.
It is not an exact allocation of 20% exclusively to Collective, and in-flight
requests can overshoot a threshold. Paid overage must be disabled. A precise
dollar cap requires a future metered-provider adapter with cost reservations.

**Refresh from Claude** uses the pinned Agent SDK's experimental account-usage
control request without yielding a model prompt. While live work is enabled
during business hours, it refreshes once per minute. If this interface changes or
returns incomplete data, launches stop. A manual current reading plus an explicit
overage-disabled confirmation works temporarily; readings expire after ten
minutes by default. `npm run quota` performs the same read-only diagnostic.

The native adapter configures mandatory Bash sandboxing, workspace file-tool
permissions and only the Collective MCP server. Its child environment excludes
API/GitHub/Discord credentials. Those settings alone do not verify containment of
the Claude process, subscription credentials or MCP access, so live launch remains
disabled. Public HTTPS reads use a broker that rejects private destinations. See the
[Claude permission documentation](https://code.claude.com/docs/en/permissions)
and [sandbox documentation](https://code.claude.com/docs/en/sandboxing).

Permissions are exact-scope, single-execution grants, normally expiring after
24 hours. They can be denied or revoked before execution. Approvals for
unimplemented integrations remain recorded but do not execute anything.

| Capability | Current implementation |
| --- | --- |
| Public web research | Fetch public HTTPS pages through `web_read`; no logged-in browsing or full browser automation yet |
| Code and tests | Per-agent workspace and native adapter; live launch gated. Maintainer-only disposable candidate evaluator rehearsal |
| Shared output | Immutable publication of top-level, single-link files up to 5 MB; copy nested outputs to the workspace root first. Text inspection and isolated local HTML preview |
| Team and rooms | Approved additions within configured caps; rooms provision in Discord when used |
| GitHub | Approved private repository creation and draft PR creation from an existing remote head branch |
| External deployment | Request and approval lifecycle; a hosting executor and designated destination are still needed |
| New tools, money, contacting people, public posting | Persistent requests only; no executor in this version |

Optional GitHub setup uses `GITHUB_OWNER` and an appropriately scoped
`GITHUB_TOKEN` in `.env`, then a restart. Agents never receive that token. The
current PR broker does **not** upload workspace files or push branches. Do not
grant broad GitHub access to compensate for a missing capability.

## Development and data

```sh
npm run dev       # Watch the live server
npm run typecheck
npm test          # No models or external writes
npm run build
npm run doctor   # Installation/auth/configuration presence, no secrets
```

The dependency lockfile is included. The experimental quota SDK is pinned to
0.3.281; review its schema and billing behavior when upgrading. UI is ordinary
HTML/CSS/JavaScript; the TypeScript server uses SQLite, discord.js, and the official
MCP SDK. Build output is generated in `dist`.

Live data is in `.collective/`: `collective.sqlite`, `workspaces/<agent-id>/`,
`artifacts/`, and protected per-run `control/` configuration. Rehearsal uses
`.collective-demo/`. Claude session transcripts remain in the location managed
by Claude Code. Stop the app before copying the data directory for backup, and
retain Claude's session data if you need transcript resumption too. Neither data
directory nor `.env` belongs in source control.

Crash recovery requeues interrupted jobs and preserves known Claude session IDs.
Discord uses an outbox with send reconciliation (the latest 100 channel
messages); this is not a claim of exactly-once delivery under arbitrary downtime.
SQLite allows one supervisor per data directory. This is a personal local
prototype, not a hosted multi-tenant system or a hardened VM boundary.

## Architecture and next iteration

The [first foundation increment](docs/FOUNDATION.md) adds atomic task/run
transitions, durable task retry IDs, mission scoping, and database migration
backups. Upgrading a v1 data directory leaves the collective paused. Legacy work
whose mission cannot be verified stays in history as cancelled; recreate useful
requests or meetings under the current mission before resuming.

Start with the [engineering library](docs/README.md) for the code assessment,
high-level architecture, knowledge design, controlled evolution and staged plan.
The assessment records reproduced gaps; the target designs are explicitly
proposed and are not implemented guarantees. The documentation catalog gives
these files stable identities for the committed-source knowledge importer.

Run `npm run docs:check` to validate the catalog and local documentation links.
The shared-knowledge foundation is implemented; criterion-bound evidence evaluation is next;
see the [acceptance gates](docs/PLAN.md) before enabling broader autonomy. A short
live mission will then verify Discord delivery, actual tool sandbox behavior,
session resumption, quota refresh, and an evaluated output before longer
unattended work.

## Local Git and shared knowledge

This platform is tracked locally on `main`; no remote or PR workflow is configured.
Commit source and documentation changes before restarting to make new core docs
available in the Library. Startup imports registered Markdown from the local Git
HEAD as read-only revisions; it does not import uncommitted files. Git is now a
startup prerequisite. Source snapshots retain their proposed or recorded status.

Agents have shared and private notes, immutable citations, revision conflict
checks, exact reads and keyword search. Library search matches all keywords;
paraphrases may need different terms. Schema v3 automatically backs up and migrates
old notes, preserving historical evidence IDs and marking competing revisions as
conflicts. Migrated installations remain paused for inspection.

See the [shared knowledge implementation](docs/KNOWLEDGE-IMPLEMENTATION.md) for
contracts, retrieval experiment, migration and remaining evaluation work.
