# my-agent

Strands agent with three interchangeable model backends.

## Running it

```bash
npm run dev "what time is it in Tokyo?"   # one-shot question
npm run dev                                # interactive chat, type "exit" to quit
```

Interactive mode keeps conversation history, so follow-ups like "and in UTC?" work.

## The agent

- `src/tools.js` defines the tools. Add one by writing a `tool({...})` and
  appending it to `allTools`.
- `src/agent.js` assembles model + tools + system prompt via `createAgent()`.
- `index.js` is just a CLI wrapper around it.

Built-in tools:

| Tool | Purpose |
|---|---|
| `get_current_time` | current date/time, optional IANA timezone |
| `calculate` | arithmetic, character-whitelisted so it cannot run code |
| `list_files` | list project files, hides dotfiles and `node_modules` |
| `read_file` | read a project file, blocks `.env`, `.git` and path traversal |

## Switching models

Everything routes through `createModel()` in `src/model.js`. Pick a preset:

| Command | Provider | Model | Cost |
|---|---|---|---|
| `npm run local` | Ollama | `glm-5.3:cloud` | free |
| `npm run dev`   | AWS Bedrock | Claude Sonnet 4.6 | AWS credits |
| `npm run demo`  | Anthropic API | Claude Opus 5 | your API key |
| `npm start`     | whatever `MODEL_PRESET` in `.env` says | | |

Pass a prompt as arguments: `npm run dev "what is 2+2"`.

To change the default permanently, edit `MODEL_PRESET` in `.env`.

## Per-agent override

Any single agent can use a different model than the default:

```js
import { Agent } from '@strands-agents/sdk';
import { createModel } from './src/model.js';

new Agent({ model: createModel({ preset: 'demo' }) });
new Agent({ model: createModel({ provider: 'ollama', modelId: 'glm-5.3:cloud' }) });
```

## Smoke test

`npm run smoke` runs every preset that has credentials and checks both a plain
answer and a real tool call. Pass preset names to narrow it: `npm run smoke local`.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in the keys you need:
   - Bedrock: `AWS_BEARER_TOKEN_BEDROCK` + `AWS_REGION`
   - Anthropic: `ANTHROPIC_API_KEY`
   - Ollama: nothing, just have Ollama running

## Notes

- The Strands **TypeScript** SDK has no Ollama provider (that is Python only).
  Ollama serves an OpenAI-compatible API, so `src/model.js` points `OpenAIModel`
  at `http://localhost:11434/v1`.
- Ollama model ids ending in `:cloud` run on Ollama's cloud, not your machine,
  and need `ollama signin`. `glm-5.3` is 753B parameters so it could not run
  locally regardless. For a truly offline model, `ollama pull llama3.1` then set
  `OLLAMA_MODEL_ID=llama3.1`.
- Tool calling is confirmed working through the OpenAI-compatibility shim.
- `Agent.invoke()` streams the reply to stdout by itself. Do not print the
  return value too or you get it twice.


## The Foundry: building your own agents

Nothing about the roster is hardcoded. You open the Foundry, build an agent,
and buy it a computer - and what it owns decides what it can do.

### The three computers

| Rig | Brain | Unlocks | Runs at |
|---|---|---|---|
| **Salvaged Terminal** | Haiku 4.5 | nothing - talk only | 1x |
| **Office Workstation** | Sonnet 4.6 | workspace, saved files, web browser | 4x |
| **Overclocked Rig** | Opus 4.6 | all of the above, plus deep thinking and longer sessions | 6x |

This is not decoration. A Salvaged Terminal agent has no shell tool, no
library tools and no browse tool, and its prompt tells it to say plainly that
its hardware cannot do the job. Buying the upgrade is what makes it capable.

**AWS does not sell you CPU.** `create-code-interpreter` and
`create-agent-runtime` have no compute, size or memory parameters at all -
every sandbox is a fixed 2 vCPU / 8 GB. So a better computer buys a better
model, more thinking and more peripherals instead. All real, all costed
differently, and all visible in the room: a bare desk, a squat CRT, a flat
panel, or dual screens with a humming tower.

### Access passes: what an agent may reach

A rig decides what an agent can **do**. A connector decides what it may
**reach**. Keeping them separate is what makes least privilege a visible
choice: a Salvaged Terminal with a Gmail pass can read your mail but not build
a PDF; an Overclocked Rig with no passes can build anything and sees none of
your accounts.

An account is linked **once for the world**, then granted **per agent**. So
you can give the boss your inbox and leave the writer with no sight of it.
Revoking a link strips every grant that depended on it, automatically.

In the room, each pass shows as a keycard on the agent's chest, and an agent
with mail access gets an inbox tray on its desk whose envelopes flutter while
it reads.

| File | Role |
|---|---|
| `src/connectors.js` | the shop. Gmail live; Calendar, Slack and Notion shown locked |
| `src/mail.js` | **currently a stub inbox** so the mechanism works with no credentials |
| `src/mail-tools.js` | `search_email`, `read_email`, `draft_email` |

**There is deliberately no send tool.** The agent prepares a draft and the
human sends it. That keeps the scariest action out of the model's hands, and
"here is the draft I wrote you" is the better ending anyway.

**Swapping the stub for real Gmail** touches one file. `src/mail.js` exposes
`search`, `read`, `draft` and `profile`; the real version fetches a token from
the AgentCore Identity vault (`GetResourceOauth2Token`) and calls the Gmail
API. Nothing above it changes. AgentCore supports ~20 OAuth vendors out of the
box, so the second connector is mostly a catalogue entry.

### How it fits together

- `src/rigs.js` - the catalogue. Single source of truth, served to the UI over
  `GET /api/rigs` so the shop can never drift from what agents actually get.
- `src/world.js` - the roster, stored on the same DynamoDB record as the theme
  and keyed by the stable user id. Validates names and the cap.
- `src/team.js` - assembles agents from the roster at session start. Slot 0 is
  the boss; the rest become its tools.
- `public/foundry.js` - the builder overlay.

Creating or editing an agent is a **database write**. Nothing is redeployed,
and the cached team is dropped so the next message uses the new configuration.

### Rendering notes

- `public/markdown.js` renders the console. Agents emit real markdown -
  headings, tables, lists, inline code - and a pipe table printed as plain
  text in a narrow monospace rail is unreadable. It builds DOM nodes with
  `textContent`, never `innerHTML`, so model output cannot inject markup.
- Give the table `width: max-content` inside an `overflow-x` wrapper.
  Otherwise it squeezes itself into the rail and wraps headers one letter per
  line ("Pr / ic / e").
- **Place floor objects clear of furniture.** The Overclocked Rig's tower was
  first drawn inside the desk's own footprint, so only its top few pixels
  showed; moved flush to the desk's near edge it read as shadow. It now stands
  out on the open floor.

### Gotchas

- **Tools must be passed at construction.** Pushing onto `agent.tools`
  afterwards leaves the array looking right while the model still cannot call
  the tool - it tries, gets rejected, and reports that it has no access.
- **Hardware belongs to agents, not teams.** A boss on a Salvaged Terminal has
  no workspace while its helper does all the work, so artifact collection and
  browser frames both iterate every member and tag events with `who`.
- **Wrap the render loop in try/catch.** A bad lookup inside
  `requestAnimationFrame` stops the loop dead and freezes the room with no
  visible error - it just looks like a still image.
- Agent colours live in `public/themes.js` for the renderer and `src/rigs.js`
  for validation. The ids must match.

## The agent team

Two agents, defined in `src/team.js`:

| Agent | Role |
|---|---|
| **atlas** | The assistant the user talks to. Time, arithmetic, reading project files. |
| **scribe** | Writing specialist. Drafts emails, notes and documents. Has its own tools (`word_count`, `tone_check`). Idle until Atlas hands it a job. |

Delegation needs no plumbing. A Strands `Agent` placed in another agent's
`tools` array is auto-wrapped by `Agent.asTool()`, so Atlas simply "calls"
Scribe like any other tool:

```js
const atlas = new Agent({ tools: [...allTools, scribe] });
```

Atlas's system prompt tells it to relay Scribe's draft verbatim, otherwise it
tends to summarise the specialist's work instead of showing it.

### Watching a specialist work

The delegated agent's **entire inner event stream** surfaces on the parent's
stream, wrapped twice:

```
toolStreamUpdateEvent -> ev.event (ToolStreamEvent) -> .data (the real event)
```

`ev.agent` on those inner events reports the **parent**, not the specialist, so
`src/stream-events.js` attributes them by tracking which tool call is a known
agent name. That is what lets the UI light up the right desk.

### Thinking

`createTeam({ reasoning: true })` turns on Claude extended thinking
(`additionalRequestFields.thinking` on Bedrock, `params.thinking` on the
Anthropic API). It arrives as `reasoningContentDelta` deltas and drives the
thought clouds. Set `REASONING=false` to switch it off and save tokens.

## The cloud workspace

Atlas has a sandboxed VM - an AgentCore Code Interpreter session. 2 vCPU,
8 GB, 10 GB disk, Python 3.12 on ARM64 Amazon Linux, with ~200 packages
already installed (reportlab, python-pptx, python-docx, openpyxl, Pillow,
pandas, matplotlib). Ask for a PDF, a deck, a spreadsheet or a chart and the
agent writes a script, runs it, and hands back the file.

`src/agentcore-sandbox.js` implements Strands' abstract `Sandbox` class over
the service's nine operations. That is the whole integration: the SDK's vended
tools route their I/O through whatever sandbox the agent holds, so attaching
one is enough.

```
you --file--> App Runner --> AgentCore agent --> Code Interpreter (microVM)
                                                        |
                              S3 (presigned) <---- the finished document
```

### Saved files: the filing cabinet

The sandbox is a **desk** - wiped when the VM dies, 15 minutes by default.
Anything lasting goes in a **filing cabinet**: S3 under `library/<userId>/`,
with no expiry.

- Files the user sends are filed automatically.
- Documents the agent finishes are filed automatically.
- `list_saved_files`, `open_saved_file`, `save_file` and `delete_saved_file`
  (`src/library-tools.js`) let the agent work with it.

`open_saved_file` copies a document back onto the desk, which also makes it
new relative to the turn's snapshot - so the user gets a download link in the
same step. One tool call covers both "let me read that" and "here it is".

**Why S3 rather than a mounted filesystem.** Mounting EFS or S3 Files into a
Code Interpreter requires `networkMode: VPC`, and VPC mode is mutually
exclusive with `PUBLIC` - which would cost the agent `pip install`. Copying
files on and off the desk keeps both.

`userId` is stable across conversations: the browser's anonymous client id, or
`tg-<chatId>` on Telegram. The per-tab `sessionId` is deliberately NOT used -
the cabinet follows the person, not the tab. Adding real auth later means
changing what fills that one field.

### Files in and out

Drag a file onto the console, or use ATTACH FILE. It lands in the agent's
working directory before the turn starts. Anything **new** the run leaves
behind is uploaded to S3 and offered as a download chip; the same files go to
Telegram as documents. The bucket expires objects after 7 days.

### Things that cost real debugging time

- **Do not give the agent two filesystems.** The old host-side `list_files` /
  `read_file` tools read *this container's* source, and once a sandbox existed
  the model could not tell which disk it was on - it called `read_file` on an
  uploaded file, got ENOENT, then resorted to `find /`. They are gone from
  `allTools`.
- **`fileEditor` is not vended.** It validates that paths are ABSOLUTE; the
  AgentCore file API rejects absolute paths as "potential path traversal".
  Both cannot be satisfied, so the agent errors once then falls back to the
  shell regardless. A shell with heredocs covers the same ground.
- **The file API is rooted at the session's working directory.** `/tmp/out.pdf`
  is rejected even though code inside the VM writes there happily. Relative
  names only - which is also why the prompt insists on them.
- **Sessions have a flat wall-clock TTL** (900s default, 8h max) with no idle
  extension, and the filesystem is destroyed with the VM. The adapter restarts
  a dead session and retries once. Keep that retry test NARROW: matching
  `ValidationException` made ordinary argument errors wipe the workspace
  mid-task.
- Sandboxes bill per second while alive, so the session starts lazily on first
  use and is stopped when its chat session is evicted.
- **Do not touch the sandbox on every turn.** The artifact snapshot originally
  ran unconditionally at the top of `agentEvents`, and listing files STARTS a
  VM - so "what is 2+2" was quietly booting a microVM and billing until its
  15-minute timeout. Both the snapshot and the collection are now skipped
  unless `workspace.started` is already true.

## The browser

The agent drives a real headless Chrome in the cloud - AgentCore Browser, one
microVM per session - and the page it is looking at is painted onto its
monitor in the room.

`browse(url)` navigates, returns the page title and visible text, and captures
a screenshot. One verb on purpose: clicking and form-filling are possible over
the same connection, but every extra verb is another way for the model to get
lost, and "open a page and tell me what it says" covers most of what a personal
assistant is asked.

### How it connects

The automation stream speaks genuine Chrome DevTools Protocol over a
WebSocket. Two things make that simpler than it sounds:

- **The signature goes in the query string, not headers.** Node's built-in
  WebSocket cannot send custom headers, so SigV4 `presign()` puts it in the URL
  instead. That removes the need for both Playwright and the `ws` package -
  `src/browser.js` is plain CDP messages over the native client.
- **Navigation is not in `InvokeBrowser`.** That API has mouse, keyboard and
  screenshot actions but no navigate, so CDP is not optional.

### How the frame reaches the room

Screenshots never enter the tool result - a base64 PNG in the model's context
would be ruinously expensive. The frame goes to S3, the URL is parked on the
session, and `agentEvents` picks it up after each tool call and emits a
`screen` event.

`scene.js` then draws it onto the monitor face. **Not into the room's buffer**:
at 196x146 the glass is only about 48x16 pixels, which turns a web page into
unreadable mush. The frame goes on a second canvas (`#screenlayer`) sized to
real device pixels and laid exactly over the room, with smoothing ON - so the
page stays sharp while everything around it keeps its chunky look. The glass is
a parallelogram, so the image is mapped through a matrix built from three of
its corners, which `drawMonitorA()` records each frame.

Two traps there. A `<canvas>` is a replaced element, so `position:absolute;
inset:10px` leaves it at its intrinsic 300x150 - the overlay needs explicit
`width`/`height`. And Atlas's thought cloud floats directly over its monitor,
so it is suppressed while a page is up.

`ARTIFACT_BUCKET` must be set or `capture()` returns nothing and no frame is
ever emitted - silently. It is in `.env` now, and with no bucket at all the
frame falls back to an inline `data:` URL rather than disappearing.

Two details that matter for the demo: the capture is **awaited** before the
tool returns (fire-and-forget lands too late for the UI to show it), and the
monitor **stays lit while a page is up**, so the agent leaves the page on
screen after it finishes rather than going dark. The bucket needs a CORS rule
for the browser to load the frame.

## Talking to it from Telegram

`src/telegram.js` adds a second channel. App Runner already has a public HTTPS
URL, so it is a webhook rather than long polling. Both channels run through the
same `runTurn()` in `ui-server.js`, so they cannot drift apart.

To switch it on:

1. Message **@BotFather** on Telegram, `/newbot`, and copy the token.
2. Redeploy with it in the environment:

```bash
TELEGRAM_BOT_TOKEN=123456:ABC... \
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 16) \
./deploy-ui.sh
```

The service registers its own webhook on boot from `PUBLIC_URL`. Telegram
cannot stream, so a turn sends a placeholder, edits it as tools run (throttled
to about one edit per 1.4s, which is roughly Telegram's limit), then posts the
answer and uploads any files as documents. Attachments work in reverse:
send a file and it lands in the agent's workspace.

## Pixel-art web UI

```bash
npm run ui                       # local agent, streams straight from the SDK
MODEL_PRESET=local npm run ui    # same UI, running on Ollama
npm run ui:cloud                 # UI locally, driving the DEPLOYED AgentCore agent
```

An isometric pixel office, Sims-style camera. The agent sits at a desk; the
task console is docked on the right. The monitor is **off** while idle. Give
it a task and the screen powers on, code scrolls, light floods the room, and
the agent types.

Every state is driven by a real SDK stream event, not a timer:

| Event from the SDK | The room |
|---|---|
| `beforeModelCallEvent` | THINKING - monitor fades on, slow scroll, purple antenna |
| `beforeToolCallEvent` | WORKING - fast scroll, agent types, sparks at the keyboard |
| `afterToolCallEvent` | tool card turns green or red and shows the return value |
| `modelStreamUpdateEvent` | answer types out in the console |
| `agentResultEvent` | DONE - green screen with a tick, then the monitor powers down |
| a specialist is called | its desk lights up, it wakes and types; roster chip turns on |
| `reasoningContentDelta` | a pixel thought cloud above that agent, showing its last 3 reasoning pointers |
| any failure | ERROR - red screen with an X |

### Console behaviour

The people using this ask for a document or an email. They care about the
answer, not which tool ran. So one turn renders as:

```
YOU     <the request>
ok 2 steps - 8.2s  [+]        <- all thinking + tool work, one line
AGENT   <the answer>          <- every text delta merged into one block
```

The activity line ticks live while the agent works, then settles into a
summary. Clicking it expands each tool with its arguments and return value,
so nothing is lost when something looks wrong. Agent text is merged into a
single answer block even when tool calls interrupt it, rather than being
scattered across the transcript.

**The divider is draggable.** Grab the handle between the two panels to
resize the console (260-760px), double-click to reset. The width persists in
`localStorage`, and the divider is hidden when the layout stacks on narrow
screens.

### Themes

Three rooms, picked from the dropdown at the bottom-left of the scene:

| Theme | Look |
|---|---|
| **Office** (default) | Open-plan greys and blues, carpet tiles, whiteboard, daylight city window, water cooler |
| **Home** | The cosy night room: wooden desks, rug, poster and bookshelf, moon and stars |
| **Arcade** | Neon after-hours: checkerboard floor, magenta sign, purple city |

A theme is **pure data** in `public/themes.js` - a palette plus a few decor
selectors (`windowStyle`, `leftWall`, `floorStyle`, `extras`). `scene.js` reads
the active theme rather than hard-coding colours, so adding a fourth room means
adding an entry to that file and changing no drawing code.

Agent body colours deliberately sit **outside** the theme, in `AGENT_SKINS`: an
agent's colour is its identity and should stay recognisable in every room.

### Where the choice is stored

There is no login, so the browser generates an anonymous `clientId` once and
keeps it in `localStorage`. The theme itself lives in **DynamoDB**
(`my-agent-prefs`, partition key `clientId`), read and written through
`GET/PUT /api/prefs`.

```
browser --clientId--> App Runner --GetItem/PutItem--> DynamoDB
```

`localStorage` still holds a copy, used as a cache so the room paints
immediately with no flash of the wrong theme; the server value wins once it
arrives. Every DynamoDB call degrades gracefully - with no table or no
credentials the API returns `stored: false`, the UI says "saved locally", and
local development needs no AWS at all.

`deploy-ui.sh` creates the table, and the App Runner instance role carries
`dynamodb:GetItem`/`PutItem` scoped to that one table.

### How the scene is drawn

`public/scene.js` renders into a 196x146 pixel buffer that CSS upscales, so
one fill is one crisp pixel. An 8x8 grid in 2:1 isometric projection:
**+i goes down-right on screen, +j goes down-left**, so the camera always sees
each box's +i and +j faces.

Gotchas, all of which cost real debugging time:

- **Do not use canvas path fills for shapes.** `ctx.fill()` antialiases, which
  turns to mush at 4x upscale. `poly()` in scene.js is an integer scanline
  filler instead.
- **"In front of" means adding to i AND j equally.** Moving the agent left on
  screen only changes `i - j`; it slides them along the wall rather than
  toward the camera.
- **Give the monitor a stand.** At this camera angle a panel sitting flat on
  the desk has its lower half covered by the seated agent's head.
- Anything shared between the scene module and the page needs its own
  declaration in both. Pulling the scene out of `index.html` left `state`
  undeclared there, and the module-scope assignment threw on the first call,
  silently killing every task.
- `ev.result` on `afterToolCallEvent` is a `ToolResultBlock`. Its real
  properties are `{type, toolUseId, status, content, error}`. The
  `{toolResult: ...}` wrapper in `JSON.stringify()` output comes from its
  `toJSON()` and **does not exist as a property**.
- Pass `printer: false` to `createAgent()` so the SDK stops writing the answer
  to stdout when a UI is already rendering the stream.
- Tools often finish in milliseconds, so the UI holds WORKING for 900ms.

## Deploying to Bedrock AgentCore

`server.js` wraps the agent in the two HTTP endpoints AgentCore requires
(`GET /ping`, `POST /invocations`) on port 8080.

Run it locally first:

```bash
npm run serve
curl -s localhost:8080/ping
curl -s -X POST localhost:8080/invocations \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"what is 15% of 240?"}'
```

Then deploy:

```bash
./deploy.sh                                   # build, push to ECR, create/update runtime
./deploy.sh invoke "what time is it in Tokyo?"
```

`deploy.sh` creates the IAM role, the ECR repo, builds a linux/arm64 image,
pushes it, and creates or updates the AgentCore runtime. Override defaults with
env vars: `AWS_REGION`, `ECR_REPO`, `RUNTIME_NAME`, `ROLE_NAME`.

### Prerequisites

- **Docker running.**
- **Real IAM credentials.** `AWS_BEARER_TOKEN_BEDROCK` is enough to call models
  but cannot push to ECR or create an AgentCore runtime. Run `aws configure`
  with an access key/secret, or `aws sso login`. Verify with
  `aws sts get-caller-identity`.

Your own user needs permission for ECR push, `iam:CreateRole` / `PutRolePolicy` /
`PassRole`, and `bedrock-agentcore-control:*`.

### Notes

- AgentCore only runs **linux/arm64** images.
- Each AgentCore session id gets its own `Agent`, so callers do not share
  conversation history. A single module-level agent (as in the AWS example)
  leaks history between users.
- The Strands docs list `express@^4.18.2`, but SDK 1.14.0 peer-requires
  **express 5**. Express 4 fails `npm ci` inside Docker.
- **AgentCore sends no `Content-Type` header.** `express.raw({type:'*/*'})`
  therefore never parses the body, Express 5 leaves `req.body` undefined, and
  every call 400s. `server.js` reads the request stream directly instead.
  The AWS doc's example has this bug.
- In `deploy.sh`, do not build the session id with `tr ... | head -c N`.
  `head` exits early, SIGPIPEs `tr`, and `set -o pipefail` aborts the script
  with no output.

### Deployed runtime

```
arn:aws:bedrock-agentcore:us-east-1:271583835787:runtime/my_agent_service-Z0DqCbFvp2
```

Logs: `aws logs tail /aws/bedrock-agentcore/runtimes/my_agent_service-Z0DqCbFvp2-DEFAULT --region us-east-1 --follow`


## Deploying the UI (App Runner)

**The UI cannot be hosted inside AgentCore.** That runtime exposes only
`/ping` and `/invocations`, reachable exclusively through the SigV4-signed
`InvokeAgentRuntime` API. There is no public URL and no static hosting, so a
browser can never load a page from it.

So the UI ships as its own container on App Runner. It serves the page and
signs the AgentCore calls with its instance role - the browser never holds AWS
credentials.

```bash
./deploy-ui.sh           # build, push, create/update the service, print the URL
./deploy-ui.sh url       # print the public URL
./deploy-ui.sh delete    # tear it down and stop the hourly charge
```

```
Browser  --https-->  App Runner (UI, x86_64)  --SigV4-->  AgentCore (agent, arm64)
                          |                                      |
                    serves the page                        runs the tools
                    holds the IAM role                     calls Bedrock
```

### Streaming all the way through

`/invocations` answers with **`text/event-stream`**. AgentCore streams a
response back only for that content type - return `application/json` and the
caller waits for one blob, which would flatten the UI to THINKING then DONE
with no tool animation. `src/stream-events.js` holds the one event protocol
that the container emits and the browser animates.

### Gotchas

- **App Runner runs x86_64; AgentCore requires arm64.** Two Dockerfiles, two
  ECR repos, two `--platform` flags. Pushing the arm64 image to App Runner
  fails at startup.
- App Runner needs **two** roles: an *access role*
  (`build.apprunner.amazonaws.com`) to pull from ECR, and an *instance role*
  (`tasks.apprunner.amazonaws.com`) for the app's own AWS calls. Mixing up the
  trust principals is the usual failure.
- IAM role creation is eventually consistent - `create-service` can reject a
  role that exists but has not propagated. `deploy-ui.sh` retries.
- AgentCore rejects runtime session ids shorter than 33 characters; the proxy
  pads the browser's session id.
- **App Runner bills hourly while the service exists**, even when idle. Run
  `./deploy-ui.sh delete` when you are done with the demo.
