# Roadmap: autonomy, reliability, the tribe

Status 2026-09-14: everything below is built and deployed; see `autonomy.md`
for how it works in practice.

What is being built after identity, in the order it lands. Each item names the
file it lives in so the plan and the code stay one thing.

## 4. Reliability (first: everything else stands on it)

| gap | fix | where |
| --- | --- | --- |
| tenth long turn dies on `ContextWindowOverflowError` | `SummarizingConversationManager` on every agent, proactive compression on | `src/team.js` |
| throttles surface as errors | `DefaultModelRetryStrategy` + exponential backoff, 8 attempts | `src/team.js` |
| a runaway loop can spin forever | `limits.turns` per invocation | `src/team.js` |
| a hung tool hangs the turn | every tool wrapped with a deadline (`GuardedTool`) | `src/guard.js` |
| no metering | `agent.metrics` summed per turn into `usage:<user>:<day>`; daily token budget; `/api/usage` drives the ENERGY bar | `src/usage.js`, `ui-server.js`, `public/index.html` |
| nothing scripted | 20 evals against the mock connectors, `npm run eval`, GitHub Actions workflow | `evals/` |

## 3. Autonomy (agents act when not spoken to)

- **Jobs** (`src/jobs.js`, table `my-agent-jobs`): one record per unattended
  run: status `running / done / failed / needs_approval`, prompt, result,
  the chat it was filed under. Every job is also a normal chat, so it appears
  in HISTORY with the full transcript.
- **Detached invocations** (`server.js`): `{ job: {...} }` in the payload makes
  the runtime answer at once and keep working; `/ping` reports busy until it
  is done. Long jobs from the browser go this way too (`POST /api/jobs`).
- **Routines** (`src/routines.js`): saved on the user record, one EventBridge
  Scheduler schedule each, universal target `bedrockagentcore:invokeAgentRuntime`
  with the job payload. Locally a one-minute ticker plays the scheduler.
- **Triggers**: a routine of kind `mail` or `calendar` runs every N minutes but
  only wakes the model when there is something new (new matching mail, an
  event starting within the lead time). The cheap check is a connector read;
  no model call otherwise.
- **Outbox**: Telegram, when the account has linked a chat (`telegram.chatId`
  on the user record, written by `/link`). Results and files go there;
  otherwise they wait in the JOBS list in the browser.
- **Approvals**: in unattended runs, tools that change the world
  (`create_event`, `update_event`, `draft_email`) raise an SDK interrupt. The
  job parks as `needs_approval`, the outbox says what the agent wants to do,
  `/approve <id>` or `/deny <id>` (or the buttons in JOBS) resumes the agent
  with an `InterruptResponseContent`. State rides in the session snapshot.

## 5. The tribe

- **Room for four** (`MAX_AGENTS = 4`, two more desks in `public/scene.js`).
- **Handoff envelopes** (`src/handoff.js`): a helper is no longer a bare
  agent-as-tool with one `input` string. The boss fills a brief, the context
  it has, the deliverable and constraints; the envelope adds who the user is
  and the house rules. Inner events keep streaming to the room.
- **Role templates with skills** (`src/roles.js`, `skills/*.md`): researcher,
  writer, scheduler, analyst, operator. A template pre-fills the Foundry and
  its skill text rides in the prompt.
- **Parallel fan-out**: the SDK already runs tool calls concurrently; the boss
  is told to hand out independent subtasks in one go, and the room animates
  every busy helper at once (events carry `who`).

## Out of scope for this pass

Memory (profile + notebook) is phase 2 and comes after; envelopes leave a slot
for it.
