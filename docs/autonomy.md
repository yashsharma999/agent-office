# Autonomy, reliability, the tribe

How the pieces from `roadmap.md` work now that they are built.

## Jobs

A job is one unattended run of the boss. Three ways one starts:

- **JOBS tab → RUN IN THE BACKGROUND**: `POST /api/jobs {prompt}`.
- **A routine fires** (schedule, or a mail/calendar trigger that found something).
- **A resume**: `/approve` or `/deny` on a job that paused.

The job id is also the chat id, so every job is a chat in HISTORY with the
whole transcript. Records live in DynamoDB `my-agent-jobs` (`userId`, `jobId`).

Locally (`AGENT_TARGET=local`) the UI server runs the job in-process. Against
AgentCore, the UI server sends `{ job: {...} }` to the runtime, which answers
`{accepted:true}` at once and keeps working; `/ping` says `HealthyBusy` until
it is done so the container is not reclaimed.

## Approvals

In an unattended run, `create_event`, `update_event` and `draft_email` call
`approveFirst()` (`src/approvals.js`), which raises an SDK interrupt. The
loop stops with `stopReason: 'interrupt'`, the session manager snapshots the
agent with the pending tool call inside, and the job becomes
`needs_approval`. The outbox says what the agent wants to do; APPROVE/DENY in
the JOBS tab or `/approve <job>` on Telegram resumes the agent with an
`InterruptResponseContent`. On approve the very same tool call completes; on
deny the tool reports "the user declined" and the agent finishes without it.

Attended chats are unchanged: the agent asks in words.

## Routines

`ROUTINES` tab, or `PUT /api/routines`:

```json
{ "name": "Morning brief", "prompt": "…", "kind": "schedule",
  "when": { "daily": "08:00", "days": "weekdays", "tz": "Europe/London" } }
{ "name": "Deck watch", "prompt": "…", "kind": "mail", "query": "deck",
  "when": { "every": 15 } }
{ "name": "Meeting prep", "prompt": "…", "kind": "calendar", "lead": 60,
  "when": { "every": 30 } }
```

Each routine gets an EventBridge Scheduler schedule named `ao-<user>-<id>`
whose target is the runtime itself (`aws-sdk:bedrockagentcore:invokeAgentRuntime`,
role `MyAgentSchedulerRole`). Without a scheduler role (local dev) the UI
server's one-minute ticker runs whatever `dueNow()` says is due.

Triggers cost nothing when quiet: the runtime reads the inbox or the diary,
compares with `lastSeen`, and only wakes the model when there is something new,
handing it what it found.

## Outbox

`/link` on Telegram stores `telegram.chatId` on the user record. Job results,
files and approval requests go there (`src/outbox.js`). Without Telegram they
wait in the JOBS tab.

Telegram commands: `/jobs`, `/approve <job>`, `/deny <job>`, `/link`.

## Reliability rails (`src/team.js`)

- `SummarizingConversationManager` on every agent, proactive compression.
- `DefaultModelRetryStrategy`, 8 attempts, exponential backoff with jitter.
- `limits.turns` (default 60, `MAX_TURNS`).
- Every tool wrapped in `GuardedTool` (`TOOL_TIMEOUT_MS`, default 180 s;
  colleagues 900 s).
- Metering: `team.measure()` after each turn → `usage:<user>:<day>` counters;
  `DAILY_TOKEN_BUDGET` (default 2M tokens) → `OutOfEnergy` refuses further
  turns; `/api/usage` feeds the ENERGY readout under the HUD.
- Evals: `npm run eval` (`evals/`), workflow in `.github/workflows/eval.yml`.

## The tribe

- Four agents (`MAX_AGENTS`), four desks.
- Colleagues are `HandoffTool`s (`src/handoff.js`): the boss fills brief,
  context, deliverable, constraints; the envelope adds the user, the date and
  the house rules. Inner events are tagged with `who`, so parallel colleagues
  animate separately.
- Role templates (`src/roles.js`) with skills in `skills/*.md`; the Foundry's
  START FROM picker pre-fills an agent and keeps the template id so the skill
  text rides in the prompt.
- Fan-out: the SDK runs tool calls in one turn concurrently; the boss is told
  to hand out independent subtasks together.
