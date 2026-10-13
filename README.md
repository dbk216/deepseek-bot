<p align="center">
  <img src="docs/logo.svg" width="112" height="112" alt="deepbot">
</p>

<h1 align="center">deepbot</h1>

<p align="center">
  <strong>Your memory, on DeepSeek Harness</strong><br>
  a self-hosted AI teammate that remembers your threads, reads the links you send it,<br>
  drafts your documents, and asks before it deletes anything.
</p>

<p align="center">
  <strong>Version 0.2.0</strong> · <a href="CHANGELOG.md">changelog</a> · runs on DeepSeek Harness <code>0.2.0-rc.2</code>
</p>

Every claim below is pinned by something you can run: a suite in `test/` that needs no harness
(`pnpm test`), a scenario in `test/scenarios/` that boots a real profile and calls a real model,
or a live check on a running deployment. Where a claim is **not** verified it says so.

**deepbot is one plugin bundle for [DeepSeek Harness](https://github.com/deepseek-ai).** The
harness ships the runtime — sessions, tools, sandbox, model routes, the web surface. This
repository is the *agent edition* on top of it: a long-running process that lives in Slack,
keeps durable sessions, remembers across conversations, and can speak first.

```
Slack (Socket Mode) ──┐
Telegram (polling)  ──┼──▶ transports/  ──▶  index.ts (the core)  ──▶  DSH services
Discord (gateway)   ──┘   one file per        sessions, policy,        agents · sessions
                          platform            prompt assembly          sessionQuery · credentials
                                                    │                        │
                                                    │                        ▼
                                                    │              session log (event-sourced)
                                                    │                        │
                                                    └── recall block ◀── memory/recall-index.jsonl
                                                                         (written host-side)
```

No process is spawned per message: the adapter drives the gateway's already-running `agents`
service, so a turn is a session call, not a CLI invocation.

---

## What it is

One bundle row in a gateway profile. `index.ts` (built to `dist/index.js`) registers the
adapter; `profile/` is the gateway composition it expects; `service/` wraps both so the thing
survives logout, reboot and a dropped socket.

- TypeScript, built with `tsc`, **zero runtime dependencies** — nothing in the plugin imports
  from `node_modules` (`docs/harness-api-notes.md` §5 explains why).
- MIT. Version 0.2.0.
- Built against DeepSeek Harness `0.2.0-rc.2`. That is a release candidate: session driving,
  message construction and the event fold are recovered from the shipped implementation and
  have no published contract. An upgrade can break this project; pin your version.
- `SPEC.md` is the specification (a draft, with its open decisions marked as such) and `PLAN.md`
  is the milestone record: what is done, what is next, and what is still unverified.

## What it does

Each line is traceable to code and to something that checks it.

| It | Where | Checked by |
|---|---|---|
| Serves Slack over **Socket Mode**: receive, reply in thread, chunk long answers, drop duplicate events | `transports/slack.ts` | `test/slack.test.mjs` 36/36; `tools/qa-slack.mjs` against a live workspace |
| Serves **Telegram** by long polling | `transports/telegram.ts` | `test/telegram.test.mjs` 28/28 |
| Serves **Discord** (gateway websocket + REST), with buttons for approvals | `transports/discord.ts` | `test/discord.test.mjs` 35/35 |
| Keeps a **durable session per thread**, resumed after a restart | `index.ts`, `<stateDir>/sessions.json` | `test/core.test.mjs` 130/130; `test/scenarios/restart-1.json` + `restart-2.json` |
| Injects **persona and notes** (`SOUL.md`/`USER.md`/`MEMORY.md` from the adapter, `AGENTS.md` from `dsh-agent-instructions`), without re-sending them every turn | `index.ts` | `test/core.test.mjs`; `test/scenarios/persona.json` 3/3 |
| **Recalls past conversations** — rank passages, then ask for what they imply | `recall/`, `recallContext.ts` | `test/recall.test.mjs` 11/11; `test/recall-context.test.mjs` 17/17 |
| Reads the **thread it was mentioned in**, as a delta | `transports/slack.ts` | `test/history.test.mjs` 9/9 |
| Sends an attached **image** to the model as an image | `transports/attachments.ts`, `index.ts` | `test/attachments.test.mjs` 13/13; `vision.json` needs a model |
| Produces **documents** (docx, pptx, xlsx) | `profile/cordis.patch.yml` office rows | `test/scenarios/document.json` asserts the artifacts |
| Asks the user to **approve** a destructive command, in the conversation | `index.ts` | approval checks in `test/core.test.mjs`; `approval-gate.json` records one open gap |
| Confines **reads**, for commands and for the file tools | `service/confined-runner.sh`, `readScope` | `test/confined-runner.test.mjs` 10/10; `test/edges.test.mjs` 19/19 |
| Flags **instruction-like text** in fetched material | `injection.ts` | `test/injection.test.mjs` 31/31 |
| Runs **one turn at a time per conversation**; a later message waits, and a stop withdraws what is waiting | `index.ts` | `test/failures.test.mjs` 24/24 |
| Shows it is **working at once** (typing, or a progress message on Slack) and edits it | `progress.ts`, `index.ts` | `test/progress.test.mjs` 22/22; `test/core.test.mjs` |
| **Stops** a running turn on request, and on its own timeout | `index.ts` | `test/scenarios/interrupt.json` |
| Reports **token usage** without starting a turn | `usage.ts` | `test/usage.test.mjs` 19/19 |
| Delivers **reminders** and **watches** — speaking first, but only when asked to | `watch/`, schedule bundle | `test/watch.test.mjs` 16/16; `test/delivery.test.mjs` 9/9 |
| Publishes **health** so an external probe can restart a disconnected bot | `service/health-check.mjs` | `PLAN.md` M3: injected unhealthy state → restart → recovered |
| Gives each conversation group its own **workspace** (tenants) | `index.ts` | tenant checks in `test/core.test.mjs`; `test/scenarios/tenant.json` |
| Prunes its own bookkeeping so a long-running process does not grow forever | `index.ts` (`stateRetentionDays`) | `test/resources.test.mjs` 8/8 |

## Does it work? How to read the claims

Three kinds of evidence appear in this repository, and they are not equivalent:

1. **Unit suites** (`pnpm test`) drive `apply()` against mocks — a fake context, fake transports,
   fake Slack/Discord/Telegram APIs. No harness install, no network, no account. They run in CI.
2. **Scenarios** (`test/run-scenario.mjs`) boot a real profile and call a real model. They prove
   behaviour, and they need a model credential, so **CI does not run them**.
3. **Live checks** were made against a running deployment and are recorded here, in `PLAN.md`, or
   in a code comment with the measurement next to it.

The counts below are from a run of `pnpm test` on 2026-10-13 (macOS, Node 26.7.0): **413 checks
in 20 suites, exit 0**, plus the `dist-fresh` build guard and a secret scan. CI runs the same
suites on Node 22 with `pnpm run typecheck` in front of them.

| Area | State |
|---|---|
| Slack Socket Mode, threads, chunking, dedupe | verified unit + live |
| Telegram | implemented; unit 25/25; **live round trip not done** (needs a bot token) |
| Discord | implemented; unit 32/32; **live round trip not done** (needs a bot token) |
| Durable sessions, resume across a restart | verified (scenario: two processes) |
| Cross-session recall, injected as a decision block | verified unit; scenarios need a model |
| Persona/notes budgets, note hygiene | verified unit |
| Images | implemented; the end-to-end scenario needs a model that accepts images |
| Documents | implemented; the scenario asserts the produced files |
| Approvals over chat | answerer and buttons verified unit; the destructive-command gate is **open end to end** (below) |
| Read confinement | implemented; a **policy** boundary, not a kernel one |
| Watches, reminders, health probe | verified unit; health restart verified against an injected failure |
| Streaming tokens into Slack | **not implemented** — the answer replaces one progress message |
| Semantic/vector recall | **not implemented** — ranking is lexical, so a paraphrase can miss |
| Browser automation | **not implemented** — link reading is an HTTP fetch |
| Per-tenant *permission* preset | **not supported** — `permission` is read and never applied (`TODO` in `test/core.test.mjs`) |

## How it works

### The transport seam

One core, one transport per platform. The core (`index.ts`) owns thread→session mapping, the turn
loop, the channel allowlist, prompt assembly, watches and reminders; a transport owns credentials,
the connection, event parsing, rendering, history and attachments. The interface is
`types/transport.ts`: `connect({ onMessage, onStatus, onAction })`, `post(target, text, { replace,
buttons })`, `fetchHistory`, `fetchAttachments`, `identity()`, optional `permalinkFor` and
`uploadFile`, and a `supportsButtons` flag the core reads rather than assumes.

`platform: 'slack' | 'telegram' | 'discord'` selects one. `test/fake-transport.mjs` supplies a
fourth, which is how the core is tested with no platform account at all.

### Sessions

`channel:thread_ts` is the key; it maps to a session id persisted in `<stateDir>/sessions.json`.
A turn is `agents.resume(sessionId)` when there is one and `agents.create(...)` when there is not,
followed by `followup(...)`, `whenIdle()`, `sessions.flush()` as a durability barrier, then the
last assistant text is read out of the session log and posted. `reason.kind === 'completed'`
decides success; anything else is reported into the thread, so a failed turn never looks like a
silent one.

Two facts that will bite: a session is composed with an **agent preset**, and without one the
agent has no tools at all — that failure was silent and looked like a memory bug for days. And
resume is bound to the recorded working directory, so moving the agent home orphans every old
thread.

### Prompt assembly, and why the standing block is digest-gated

Prompt caching reuses a stable prefix, so anything that changes early in the prompt throws away
everything after it, and anything repeated every turn is paid for every turn. Two rules follow.

**Standing context goes in once.** `AGENTS.md` is injected by `dsh-agent-instructions`, which
appends it as one durable baseline and adds only deltas. Re-injecting it per turn duplicated it —
measured at 7,625 characters per turn on top of the harness's own 3,634.

`SOUL.md`, `USER.md` and `MEMORY.md` are **not** read by that loader, whatever a profile says: the
instance that runs is mounted inside the `standard` agent preset with the default candidates
(`AGENTS.md`, `CLAUDE.md`), and the top-level `agent-instructions` row a profile can patch is
disabled. This README used to say otherwise, and from 2026-10-10 to 2026-10-13 the live bot ran
without its persona — asked "아리 널 어떻게 활용할수있니", it wrote a message *to* 아리 instead of
answering. The adapter now puts those three files at the top of its own standing block (below), so
they are sent once per conversation and again only when they change. `test/core.test.mjs` checks
they reach the model and `AGENTS.md` does not go twice; `test/scenarios/persona.json` checks it
against a real model, with file tools forbidden so the model cannot read `SOUL.md` itself.

**Only the changing part is dynamic.** The adapter's own block — where this conversation is, which
directory is writable, which notes exist, whether the notes need tidying — is hashed (SHA-1, per
session) and sent only when its content changed. Thread history is a delta: only what has not been
delivered yet. The recall block is built per turn and never placed in the standing part, for the
same cache reason.

The adapter logs what it assembled, so this is inspectable rather than inferred:

```
context injection: standing block 217 chars; instruction files present: SOUL.md, AGENTS.md, USER.md, MEMORY.md
```

A home with none of those files logs a warning, because then the agent has no standing context at
all — which is otherwise silent. Three turns of one conversation, from a live run's log:

```
tokens: input 13416 (0% cache-read) uncached 13416 output 112
tokens: input 29458 (45% cache-read) uncached 16146 output 131
tokens: input 48031 (61% cache-read) uncached 18847 output 139
```

Each turn adds roughly 2.7K uncached tokens; the prefix before it is served from cache. The
numbers come from the harness's `tokenUsage` session projection, and are printed after every turn.
They are one run's record, not a benchmark.

### The recall index

The harness gives memory a real substrate: an append-only, event-sourced session log. This repo
wires up what it does not turn on by default, and adds the consumer the agent plane was missing.

- `dsh-base` ships session full-text search **off** (`path: ':memory:'`, `openAt: never`).
  `profile/cordis.patch.yml` opens it on a real file at startup. The agent plane still gets no
  tool and no injected context from *that* index — its consumers are the web UI and the
  `@session` reference source.
- Recall instead reads `memory/recall-index.jsonl`, a plain-text index of past messages built by
  `recall/deepbot-recall.ts` (CLI: `index`, `search`, `recent`, `show`, `sessions`). The host
  builds it, because the session store lives outside the agent's home and the agent runs confined
  to that home; the agent only reads the index.
- The index is refreshed after **every turn** (`autoIndex`, default on). Measured: the indexer
  costs about 0.4 s for 61 session logs, which is affordable; a ten-minute window made "what did
  we just discuss?" fail in exactly the situation it is asked. `recall/install-refresh.sh`
  installs a launchd job that rebuilds it on an interval anyway, as a backstop.
- **Recall stays in its channel.** Each row records the channel its session belonged to, read from
  the adapter's own `[this conversation]` block (never from what the user typed after the marker).
  The block injected into a turn ranks only rows from that turn's channel: a DM's passages surface
  only in that DM, and a row whose channel is unknown is left out. Before this, one shared word was
  enough to put a DM into a public channel's answer. A turn with no conversation (a scenario) is not
  filtered. **Not closed:** the agent can still read the whole index file with its own tools, which
  `AGENTS.md` tells it to do when asked about the past; closing that needs a per-channel index or a
  read rule, and is not done. `test/recall.test.mjs`, `test/recall-context.test.mjs`, `test/core.test.mjs`.

## Memory: the layers, and who writes what

| Layer | Where | Who writes it | When the agent sees it |
|---|---|---|---|
| Working | the current session log | the harness | always |
| Identity | `SOUL.md`, `AGENTS.md` | you (scaffolded by `init.sh`) | every turn |
| Semantic | `USER.md`, `MEMORY.md`, `memory/<topic>.md` | the agent, under the rules in `agent/AGENTS.md`; you may edit them | every turn |
| Episodic | `memory/recall-index.jsonl` | the host-side indexer | when a message points at the past |

All four files in the agent home are read at the start of **every** turn, in this order, with
these budgets:

| File | What it holds | Budget | Changes |
|---|---|---|---|
| `SOUL.md` | identity and voice | 6,000 chars | rarely |
| `AGENTS.md` | operating rules | 12,000 chars | when a rule is wrong |
| `USER.md` | durable facts about the user | 4,000 chars | as you learn them |
| `MEMORY.md` | durable facts about the work | 4,000 chars | as you learn them |

An over-budget file is **truncated silently**: the tail simply stops being part of the prompt,
with nothing logged. `tools/persona-check.mjs` exists for that — it reports the exact overflow,
warns when the same fact is written into two files (it would be injected twice), warns about
undated lines, and refuses on a secret, which would otherwise be in every prompt and every
session log.

```bash
./init.sh --home ~/my-agent            # scaffold all four from agent/*.md
$EDITOR ~/my-agent/SOUL.md             # make it yours
node tools/persona-check.mjs ~/my-agent   # or: pnpm run persona -- ~/my-agent
```

Note hygiene is deliberately small: `notes.ts` counts characters and repeated lines and asks the
model to consolidate, because merging notes needs intent. Past `notesBudgetChars` (6,000) or on a
repeated line it adds the advice to the standing block — which is digest-gated, so the request is
sent once and then cached. The log line `notes: consolidation advice added (N chars)` is the
deterministic signal a scenario asserts on.

## Approvals over chat

A transport that can render buttons gets them — Discord posts an action row and the decision is
made in place — and one that cannot gets the instruction to reply `허용` / `거부` in the thread,
which is the same decision by a slower route. `supportsButtons` on the transport says which; the
core asks and the transport decides. Only the requester's answer counts by default
(`approvalRequireSameUser`), because a thread is shared. An unanswered request is cancelled after
`approvalTimeoutMs` (ten minutes), and a turn is cancelled by its own timeout regardless
(`runTimeoutMs`, fifteen minutes).

The answerer, the buttons, the timeout and the same-user rule are unit-verified in
`test/core.test.mjs`. Two things are honestly less than that:

- **The shipped profile fails closed.** `defaultPreset: unattended` is
  `{ sandbox: workspace-write, approval: never }`: an escalation is refused rather than asked,
  because there is nobody to answer. To answer in chat you need both halves — a preset with
  `approval: ask`, **and** `- id: api-remotes` / `disabled: true`. `dsh-api-remotes` registers its
  `approval/request` forwarding listener per connected client stream; on a headless gateway that
  listener holds the request, the session records `approval/asked` and never `approval/decided`,
  the waterfall never reaches the adapter's answerer, and the turn waits for the timeout.
  Measured: with it composed the same scenario hung and was cancelled fifteen minutes later; with
  it disabled the request reached the answerer and the turn completed (`PLAN.md`).
  `pnpm test:profile` checks the pair, because getting one half right is a hang, not a mistake.
- **The destructive-command gate is open end to end.** The adapter also gates commands the sandbox
  permits inside the workspace (`approvalPatterns`, default `['rm ', 'rmdir ', 'sudo ', 'dd if=',
  'mkfs', 'shutdown', 'reboot', 'kill -9']`), because deleting the agent's own notes is legitimate
  and irreversible. With a real model, the harness dispatches `approval/request` with a scope the
  adapter's answerer never receives, so the gate fires and the turn then waits until the timeout.
  `test/scenarios/approval-gate.json` is left failing on its third step **on purpose**: it is the
  record of that gap. The gate and the answerer themselves are unit-verified.

## Read confinement

The harness sandbox fences **writes**. Its macOS profile is allow-default with
`(deny file-write*)`, so a command an agent runs can read anything the user can — another
instance's home, a retired bot's token file. Measured: unwrapped, the agent read a canary from a
different agent's directory and answered with it.

Two surfaces, two mechanisms:

**Commands** run under `service/confined-runner.sh`, which replaces the sandbox runner. It
implements the harness's own policy arguments (workspace-write keeps the workspace and temp
writable; read-only denies all writes) and adds read denials for the other instances' homes and
for retired bot data.

```yaml
- id: sandbox
  config:
    runnerCommand: ['/absolute/path/to/service/confined-runner.sh']
    runnerFailureSignatures: ['confined-runner:']
```

Wrapping the *gateway* in such a profile does not work and is not what this does: macOS refuses
nested `sandbox-exec`, so the harness's sandbox probe finds no usable backend and refuses to run
commands at all. `service/write-read-profile.sh` is kept as reference for that approach and is
deliberately **not** installed. (`service/run-gateway.sh` will still use a profile if you put one
at `$DEEPBOT_READ_PROFILE`; nothing in this repository generates it.)

**File tools** are fenced at the harness's tool gate:

```yaml
- id: deepbot
  config:
    readScope: true                                        # default
    readScopeTools: [read, read_image, grep, glob]
    readScopeRoots: []                                     # default: workspace + temp + tooling
```

A read outside those roots is denied with a reason the model can act on — "ask the user to put the
file there, or to paste its contents". Symlinks are resolved when the path exists, so a link
inside the workspace that points outside it does not count as inside (`test/edges.test.mjs` pins
that with a symlink to `/etc/hosts`), and with tenant isolation on, the readable roots follow the
**speaking conversation** rather than the shared home.

This is a **policy** boundary, not a kernel one: the tool list has to grow with the composition,
and a tool that reads files another way would not be covered. One OS user per instance remains the
stronger answer, and is not built.

## Images

A picture that arrives as an attachment reaches the model **as a picture**. The transport
downloads it into the agent home, the core admits it through the harness's attachment service
(`ctx.attachments.saveImages`), and the prompt carries
`[{ type: 'text' }, { type: 'image', attachment: ref }]`. The service validates and normalizes
before the message is accepted, and the route projection happens in the llm adapter — for
image-capable models only, so a text-only deployment degrades to a filename rather than failing.

**The model has to declare that it accepts images.** Without this the model is handed a text
descriptor instead:

```yaml
# your provider's model entry — note `input`, not `inputModalities`
- id: deepseek/deepseek-v4.1-flash-ultrafast
  input: [text, image]
```

`inputModalities` is accepted by the config schema and **ignored by the resolver**, which reads
`declaredInput(entry.input) ?? base?.input ?? request.defaultInput`. A wrongly named key fails
silently, which is how it was found.

`test/scenarios/vision.json` is the end-to-end check: a solid-colour PNG from `test/fixtures/` is
attached and the assertion is on the colour — a fact nothing in the prompt reveals, so the answer
can only come from seeing the image. It needs a model credential.

## Documents

The product ships documents to users, so the agent must be able to produce files, and out of the
box it could not: `dsh-skill-office` is a plain package that no shipped bundle mounts. The
profile inserts two rows — `skill-office` (registers `office-docx`, `office-pptx`, `office-xlsx`
and appends the absolute LibreOffice Kit paths) and `tool-workspace-dependencies` (tells the agent
where the bundled Python lives). The second is required for the first to be usable: the office
provider ships instructions only and does not install the authoring libraries.

`test/scenarios/document.json` asserts on the artifacts rather than the answer: ZIP magic, an
inner OOXML path, and the text inside the package. A model describing a document it never wrote
reads exactly like one that did.

## Opening a link

The agent has the harness's `fetch` tool, so a URL in the conversation is something it can
actually read, and it is expected to say where it read it. Verified against a page served locally
whose fact appears nowhere in the prompt (`test:scenario:browser`, 2 steps): the answer carries
both the fact and its source, because the only way to have the fact is to have fetched the page.

**What this is not:** a browser. It is an HTTP fetch — no JavaScript execution, no clicking, no
form filling — so a page that renders its content client-side arrives empty. That is a real limit
and it is written down rather than glossed over. Search is composed separately
(`dsh-web-search-deepseek`) and needs `DEEPSEEK_API_KEY`.

**Reading JavaScript-rendered pages is a decision that has not been taken, and it breaks a rule.**
It needs a browser engine in the deployment, which would be the first runtime dependency this
project has — hundreds of megabytes, a supply-chain surface, platform-specific binaries to keep
current. Keeping that rule at zero is why the plugin resolves nothing from `node_modules` and why
this deployment is a directory and a profile rather than a container. So the decision is recorded
rather than assumed, with a concrete condition to revisit it: a page a user actually needs that
arrives empty, more than once. Until then a client-rendered page is answered honestly — the fetch
reports what it received, and an empty body is reported as empty.

**It runs with bounds, because "in the sandbox" needed its own policy.** The `fetch` tool runs in
the harness rather than under the sandbox runner, so the tool gate bounds it:

```yaml
- id: deepbot
  config:
    fetchPolicy: true            # default
    fetchAllowedHosts: []        # empty means any public host; e.g. [example.com]
```

Only `http` and `https` are fetchable; other schemes are refused with the scheme named. The
**cloud metadata service** is refused outright (`169.254.169.254`, `metadata.google.internal`,
`fd00:ec2::254`, `100.100.100.200`, and the link-local range) — it answers with credentials rather
than content, and a reader that can reach it turns "summarize this page" into a way to hand out an
instance's keys. An allowlist, when set, is the whole reachable web.

One boundary worth stating: the injection guard covers channel history, attachments and pages that
arrive as material. The `fetch` tool's own output goes straight into the model's context and is
**not** annotated.

## Progress on a turn

A message that is taken is acknowledged **at once** (`workingIndicator`, on by default). Discord
and Telegram show their own "is typing…", re-sent every 8 s and 4 s because each lapses on its own,
and stopped before the answer is posted. Slack has no typing indicator for bots, so there the
progress message — `⏳ 아리 작업 중…`, the name taken from the persona's first heading — is posted
immediately instead of after `progressAfterMs`.

The progress message **is edited in place** as tools run, with tool names and elapsed time; on a
platform with typing it appears only once a turn has run for `progressAfterMs` (8 s). When the turn
ends it gives way to the answer, so a turn leaves one message rather than a stale "working on it"
plus an answer. On Slack the answer is posted as a **new message and the progress message is
deleted** (`chat.delete`, which `chat:write` covers): an edit raises no notification, so with the
progress message on every turn, every answer would have reached a phone as "작업 중". Where a
platform cannot delete, the answer edits the progress message instead. Edits are throttled
(`progressUpdateMs`, 2.5 s) because every edit is a rate-limited API call: the message says roughly
what is happening, not every step. Renders are serial per conversation and the answer waits for
them, so a second message in the same thread cannot post a second progress message that nothing
replaces (`test/core.test.mjs`, with a post that takes 150 ms). A turn whose completion fails still
gives way to the failure, so nothing is left claiming to be working.

`progressAfterMs: 0` no longer silences Slack: to post nothing until the answer, set
`workingIndicator: false`. Slack's thread history now stops at the message being answered, so the
progress message, posted before the history is read, is not quoted back to the model.

Not verified on a live Discord or Telegram server: typing is checked against the mocked APIs in
`test/discord.test.mjs` and `test/telegram.test.mjs`, the same as the rest of those transports.

The rule worth knowing when changing this code lives in `progress.ts`, tested with no agent and no
platform: create once, edit after, never leave it behind. An orphaned "working on it" is worse than
no progress at all.

## Stopping a running turn

A turn can take minutes. Say `그만`, `중단`, `취소`, `멈춰`, `stop` or `cancel` on its own in the
thread and the turn is cancelled; the progress placeholder becomes the report, so there is no
second message. With nothing running, the answer is that there is nothing to stop, rather than a
turn started just to say so.

The same path serves the turn timeout. A timeout that only stops the *waiting* leaves the agent
running, writing to the session, and eventually delivering an answer nobody is waiting for — so a
timeout now cancels the work itself. The harness records a cancelled turn with no reason of its
own, so the adapter — the party that asked for the stop — supplies it, and the user is told which
happened: stopped on request, or stopped because it ran too long. `test/scenarios/interrupt.json`
asserts the interrupted turn ends as `cancelled`.

## Watches, reminders, staying up

- **Reminders** use the schedule bundle: the agent creates one, the wall clock fires it, and the
  schedule takes a turn in the session by itself. The adapter does not drive that turn — it
  delivers assistant messages for session ids it is not currently driving, which is
  `test/delivery.test.mjs` 9/9 and `test/scenarios/reminder.json`.
- **Watches** ("tell me when this changes") are `watch/watch.mjs`, installed as a launchd job by
  `watch/install-watch.sh` (evaluated every 60 s by default). Watch definitions come from
  `~/.dsh/watches.json` and from `<agent home>/watches/*.json`, merged by id — the second location
  is how the agent authors its own. The first observation is a **baseline** and never alerts; a
  change alerts once; a change inside the rate-limit window is suppressed and the next alert says
  how many were suppressed. A broken watch config exits 2 rather than failing quietly.
  A watch the **agent** wrote runs inside `service/confined-runner.sh`, **read-only** — the same
  read confinement as the agent's own commands, with no writes at all. It used to run as
  `/bin/sh -c` on the host, outside the sandbox and the approval gate. An agent file that reuses a
  host watch's id is confined too, and without the runner such a watch does not run. Not closed:
  read-only still lets a command read what the user can (outside other agent homes), and its output
  is posted to Slack. `test/watch.test.mjs` 19/19.
- **Health.** A process that is running but disconnected looks perfectly healthy from outside —
  that is how a 57-minute outage went unnoticed. The plugin publishes what it knows to
  `<stateDir>/health.json`, and `service/health-check.mjs` diagnoses it (no file, not connected, or
  stale/wedged). On unhealthy it restarts the service, waits for recovery, and only then alerts, so
  a blip that heals itself stays quiet; alerts are rate-limited because an alert storm is its own
  outage. `service/install-health.sh` installs it as a 5-minute job, and `service/rotate-logs.sh`
  runs from that job — logs are truncated in place (the launchd captures keep an open descriptor,
  so renaming them would leave a file nothing can find).

`PLAN.md` records the verification: an injected unhealthy state
(`unhealthy — not connected (disconnected 1023s ago)`) → `restart requested` →
`recovered after restart`, plus one labelled test DM to prove the alert path.

## What it costs

Ask in the conversation — `사용량`, `비용`, `토큰`, `usage`, `얼마나 썼어` — and the bot answers
from durable totals without starting a turn:

```
이 대화: 7턴 · 입력 112,220 (캐시 61%) · 출력 3,441
전체 (4개 대화): 31턴 · 입력 480,113 (캐시 58%) · 출력 20,441
```

Tokens come from the harness's `tokenUsage` session projection, which reports **cumulative**
totals for a session. The tracker stores the last snapshot per session and adds only the growth,
so the running total survives a restart; a session whose totals go down — compaction, or a
different log — is treated as a new baseline rather than a negative delta. All of that is
`test/usage.test.mjs` 19/19.

Money is deliberately absent. The harness exposes no price for a model, so a price table here
would be a number nobody could check: the summary reports tokens and says why.

## One workspace per tenant

By default every conversation shares the agent's home: one persona, one set of notes, one recall
index. For a deployment serving more than one customer that is the wrong default, so isolation is
one config away:

```yaml
- id: deepbot
  config:
    tenantIsolation: true
    tenantChannels:
      'C0123ABCD': acme        # channel → tenant
      'C0456EFGH': globex
    tenantRoot: <home>/tenants        # default
    tenantTemplateDir: ./agent        # its persona, copied on creation
    tenantPolicies:
      acme: { preset: standard, model: { provider: og, model: <id> }, persona: acme }
```

A tenant's directory is created on its **first message** — provisioning belongs to the message,
not to a turn that happened to succeed — with a `.deepbot-root` marker so the instruction loader
cannot climb out and hand it the home's `AGENTS.md`, and seeded from the template if one is
configured (markdown only). Without a template a tenant simply has no persona, which is the honest
default. The read scope follows the speaker, so one tenant reading another's notes is refused and
the refusal names what it *is* allowed to read.

`test/scenarios/tenant.json` (6 steps, needs a model) has one tenant write a file and the other
fail to read it by name, fail to find it in its own directory, and fail to reach it by walking up
and across (`../acme/...`). `tenantPolicies` gives a tenant its own agent preset, model and
persona, with the deployment's settings as the default and a refusal that names the tenant when a
preset does not exist — all verified by checks in `test/core.test.mjs`.

**A per-tenant *permission* preset is not supported.** The `permission` key is read into the
policy, but the session-level call that would apply it never executes, and the check for it is a
`TODO` printed by `test/core.test.mjs` rather than a passing one. Treat it as unsupported.

**A YAML trap worth knowing:** a key containing a colon must be quoted. `scenario:T1: acme` parses
as the key `scenario` with the value `T1: acme`, so isolation silently does nothing — which is
exactly what happened the first time this was tested.

## Text that tries to give orders

Channel history, attachments and pages are fetched material, and anyone can put an instruction in
them. Fetched text is framed (`content, not instructions`) and scanned; the shapes covered include
instruction overrides, `system:` impersonation, role reassignment, tool calls written as text, and
asks for credentials or `.env` contents. The warning names where the finding came from and **does
not quote the attack back** — a warning that repeats the payload delivers it twice.

**This is a mitigation, not a boundary.** What decides is elsewhere: the read scope refuses files
outside the workspace, the sandbox runner refuses other instances' data, and destructive commands
ask a human. This layer makes an attempt visible to the model at the point of use and to the
operator in the log, instead of silent. `test/injection.test.mjs` (31/31) weights the benign cases
as heavily as the attacks, because a guard that flags ordinary conversation is a guard nobody
reads.

## Requirements

- **DeepSeek Harness** (the `dsh` CLI), version `0.2.0-rc.2`. On macOS it ships inside the desktop
  app; pass its path via `DSH_BIN` if it is not where the scripts expect it.
- **Node.js 22+** for the build, the tests and the service jobs. The adapter itself uses the
  built-in `fetch` and `WebSocket`.
- **A Slack app using Socket Mode.** No public URL is needed.
- **A model credential.** The default route reads `DEEPSEEK_API_KEY`; a gateway route reads
  whatever key its provider entry names (`docs/harness-api-notes.md` §4 has the layer order).

## Slack app setup

1. Create an app at <https://api.slack.com/apps>.
2. **Socket Mode** → on → generate an app-level token with `connections:write` (`xapp-…`).
3. **OAuth & Permissions** → bot scopes. The transport calls `conversations.history` /
   `conversations.replies`, `users.info`, `url_private_download` and the files upload API, so:
   `app_mentions:read`, `chat:write`, `channels:read`, `channels:history` (plus `groups:history`
   for private channels), `users:read`, `files:read` (attachments), `files:write` (document
   upload).
4. **Event Subscriptions** → subscribe to `app_mention`.
5. Install to the workspace → bot token (`xoxb-…`).
6. `/invite` the bot into every channel it should serve. **A bot cannot see a channel it has not
   been invited to** — this is the most common silent failure.

> One Socket Mode connection per app. Opening a second one makes Slack split events across them,
> and both clients start dropping messages. If you are migrating from another bot, stop the old
> process before starting this one.

## Install

The sources are TypeScript and the profile loads `dist/index.js`, so a checkout without `dist/`
cannot start.

```bash
pnpm install                 # typescript and @types/node
pnpm run build               # tsc -> dist/
pnpm run typecheck           # no emit; CI gates on this and on pnpm test
```

```bash
# 1) create the agent home (persona files) and the gateway profile
./init.sh                    # add --dry-run to see what it would do first
#    ~/dsh-agent/            <- SOUL.md AGENTS.md USER.md MEMORY.md, memory/ state/
#    $DSH_HOME/profiles/agent/  <- the profile, with this repo registered as a bundle
#    Re-running it keeps every file that already exists.
#    Flags: --home <dir>, --profile <name>, --port <n>, --skip-profile, --dry-run

# 2) provide credentials (resolved by the harness credential service, never by this code)
cat >> "$DSH_HOME/.env" <<'EOF'
SLACK_BOT_TOKEN=xoxb-<your-bot-token>
SLACK_APP_TOKEN=xapp-<your-app-token>
EOF
chmod 600 "$DSH_HOME/.env"

# 3) set the channels this agent may answer in
$EDITOR /absolute/path/to/deepbot/cordis.patch.yml   # targetChannels, replyMode

# 4) run it
dsh --profile agent --port 19500 --no-open
```

`targetChannels` accepts explicit channel IDs or `'*'` for *every channel the bot was invited
to*. **The plugin refuses to start with an empty list**, so a misconfiguration cannot turn the bot
loose everywhere. `replyMode: 'mention'` answers `@`-mentions in channels (DMs are always
answered); `'all'` answers every human message in the allowed channels.

To make it survive logout and reboot:

```bash
service/install-service.sh            # launchd; auto-start + restart on exit
service/install-service.sh --status   # state, HTTP port, recent plugin log
service/install-service.sh --uninstall

service/install-health.sh             # 5-minute health probe (DEEPBOT_ALERT_TO=U123 to DM on failure)
node service/health-check.mjs --status

recall/install-refresh.sh             # launchd backstop that rebuilds the recall index
watch/install-watch.sh                # evaluates due watches every minute
```

The service wrapper rebuilds TypeScript when `dist/` is missing or older than the sources, and if
a build fails it starts with the existing `dist/` rather than taking a working bot down — refusing
only when there is nothing to load. It also strips inherited `DSH_PROFILE` / `DSH_SESSION_ID`
variables and fixes the working directory, because both of those silently break a gateway started
from inside another DSH session.

## Tests and scenarios

```bash
pnpm test                     # 20 suites, no harness, no network, no account
pnpm test:profile             # the composed posture of the installed profiles
node test/run-scenario.mjs    # default: test/scenarios/recall.json (needs a model credential)
```

`pnpm test:profile` reads what the harness actually composes for the profiles you name (default
`agent` and `agent-test`) with `dsh --dump-config`, and checks the posture rather than the file:
the destructive-command gate, the confined runner and its failure signature, `api-remotes`, the
approval policy, read isolation. 24/24 on this machine. It needs the profiles installed and the
`dsh` path the test file names.

A scenario is a JSON file of steps executed against the real services in an isolated instance —
its own profile, its own fresh agent home, its own index and port, and it never connects to Slack.
`node test/run-scenario.mjs test/scenarios/<name>.json` exits 0 when every step passed, 1 when a
step failed, 2 on setup problems. Flags: `--timeout <s>`, `--seed <file>`, `--dump <file>`,
`--keep`.

| Scenario | What it asserts |
|---|---|
| `recall.json` | a fact stated in one conversation is recalled in another, with its date; a fact never stated is not invented |
| `recall-immediate.json` | the index already holds a fact from a turn that just happened, and holds the user's words — not the adapter's injected preamble |
| `recall-decision.json` | recall ends in a decision ("here is what happened, therefore this") rather than a dump of passages |
| `restart-1.json` + `restart-2.json` | a second process resumes the first's session and still knows what was said (`pnpm test:restart`) |
| `notes-hygiene.json` | the consolidation advice reaches the prompt when `MEMORY.md` is over budget |
| `persona.json` | the model answers as the persona in `SOUL.md`, knowing a fact only that file holds, without opening it |
| `vision.json` | the model answers with a colour that only the attached image reveals |
| `browser.json` | a fact and its source URL come from a fetched page, not the prompt |
| `document.json` | a produced `.docx` / `.pptx` is a real ZIP with the expected OOXML parts and text |
| `injection.json` | an instruction in an attachment and in channel history never gets a canary file read out |
| `isolation.json` | another instance's home and a retired bot's data stay unreadable |
| `tenant.json` | one tenant cannot read another's file, by name or by path traversal |
| `approval.json` | a turn that needs an approval ends instead of hanging |
| `approval-gate.json` | the destructive-command gate — **left failing on step 3 as the record** of an open gap |
| `interrupt.json` | a running turn stopped mid-flight ends as `cancelled` |
| `reminder.json` | a reminder fires on the wall clock and wakes the agent by itself |

Named shortcuts exist for the common ones (`pnpm test:doc`, `test:vision`, `test:isolation`,
`test:approval-gate`, `test:interrupt`, `test:immediate`, ...; the full list is in
`package.json`). `service/run-scenarios.sh` runs the set unattended, writes
`$DSH_HOME/slack-state/scenario-report.txt`, takes a lock so two runs cannot share state, and runs
`--quick` (interrupt and approval-gate) when asked. `test/dist-fresh.mjs` guards the scenario
runner too, so a scenario can never run a stale build.

## Changing the voice

The tone is a file, not a setting. `agent/SOUL.md` holds the identity and the default register and
`agent/AGENTS.md` holds the rules that apply on top of it; `init.sh` copies both into the agent
home from this repository, and after that they are yours to edit. The shipped copies are neutral
templates that tell the agent to answer in the language its users write in — one deployment sets a
plain 반말 register there, and that is a file edit, not a code change.

Two things worth knowing before editing them:

- The bot's **own** messages — approvals, stops, progress notes — sit in the conversation, and the
  model copies the voice around it: one polite string pulls replies toward that register no matter
  what the persona file says. Those strings live in `index.ts`, and the core suite reads that file
  and fails if an honorific ending comes back (`test/core.test.mjs`, its last check).
- The persona files are read on every turn, so a rule added there takes effect immediately — but a
  *contradictory* rule does not win by being newer. It wins by being specific.

## What it is not

- **Not a coding agent.** It edits files and runs commands; it is not competing with your editor.
- **Not a chat toy.** Single-turn Q&A is a side effect; remembering across conversations is the
  point.
- **Not semantic.** Recall ranking is lexical: it matches shared words, so a differently-worded
  question can miss, and the block says so where the model reads it.
- **Not a browser.** Link reading is an HTTP fetch; no JavaScript, no clicking.
- **Not multi-tenant by default, and not voice or video.** One instance is one memory unless you
  turn tenant isolation on. Images are supported; audio, video and computer use are not.
- **Not safe by construction, everywhere.** Read confinement is a policy boundary; the
  destructive-command gate does not resolve end to end yet; and the harness itself is a release
  candidate whose session API can change.

`docs/limitations.md` is the fuller list, including the design risks and the operational caveats
(non-public harness APIs, `installModelSelection`, one FTS index owner per path, TCC). Note that
parts of its "Not implemented" table predate 0.2.0 — Slack attachments, progress and cross-session
recall are built now, and the tests above are the current record. `docs/harness-api-notes.md` is
the other half: the harness contracts this plugin relies on, marked verified, code-read or
uncertain.

## Layout

```
index.ts                       the adapter: orchestration, policy gates, prompt assembly
transports/                    the platform seam: slack.ts, telegram.ts, discord.ts, attachments.ts
recall/                        the host-side indexer (deepbot-recall.ts) + its refresh job
recallContext.ts               the block injected when a message points at the past
notes.ts                       when to ask the model to tidy up the notes
progress.ts                    one message per turn, created once and edited
usage.ts                       token totals that survive a restart
injection.ts                   detecting instruction-like text in fetched material
watch/                         the watch runner and its installer
profile/                       the gateway profile: bundle list, memory switch, office rows
service/                       runner, launchd installers, health probe, log rotation
agent/                         SOUL.md / AGENTS.md / USER.md / MEMORY.md templates
tools/                         persona-check, the secret scanner, the live Slack QA runner
test/                          unit suites, scenarios, fixtures
docs/                          harness API notes, limitations, the logo
cordis.patch.yml               the bundle patch that inserts the adapter row
```

## Gotchas worth knowing before you debug for an hour

- `apps.connections.open` needs the **app-level** token (`xapp-`) and is **POST-only**. A bot
  token gives `not_allowed_token_type`; a GET gives `insecure_request`.
- A user message needs a stable `id`. Without it the persisted log fails validation on the next
  read (`lacks an identified message`) and resume breaks — which only shows up on the *second*
  turn.
- Session resume is bound to the recorded working directory. Change the gateway's cwd and old
  threads stop resuming; they look like amnesia, not like an error.
- A patch row's `config` **replaces the whole config** — there is no deep merge. Adding
  `approvalPatterns` without restating `targetChannels` has already kept this bot from booting.
- `launchd` does not inherit your shell's privacy permissions. A job whose script lives under
  `~/Documents` dies with `getcwd: Operation not permitted`, which is why the installers copy the
  wrappers under `$HOME`.
- The FTS index has **one owning process per path**. Do not point two gateways at the same index
  file.
- State is pruned by age (`stateRetentionDays`, 30): a conversation's session mapping, standing
  digest, history cursor and usage total are dropped after that, so a very old thread starts fresh.
- The harness ships no `.d.ts`; `types/dsh.ts` is hand-written from the shipped implementation and
  verified by running. Treat a harness upgrade as a change to re-check, starting from
  `docs/harness-api-notes.md`.

## License

MIT — see [LICENSE](LICENSE).
