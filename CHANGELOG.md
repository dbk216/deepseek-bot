# Changelog

Notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the caveat about version numbers is at the bottom.

## Unreleased

### Security

- **The agent's commands could read most of the harness home.** The sandbox runner denied a list of
  names in `~/.dsh` — credentials, sessions, the recall index, profiles, the gateway's logs — and the
  harness keeps more there: its session index (every conversation's text, with its WAL), the
  adapter's state and log, reminders, a session cache, attachments, the terminal's input history,
  the watch list. Measured with the deployed runner: those were readable. The runner now denies the
  harness home as a whole and allows only its runtimes (`dsh-runtimes`, where the office skill's node
  is), and an agent home or workspace placed inside it.

### Changed

- **`dsh gateway setup` is a guided setup, and the installer no longer does messengers.** Connecting
  Slack took a skipped installer prompt, a manifest to copy, three pages in the browser and a second
  command with flags. Now the installer asks only for the model's key (when the harness has none) and
  leaves a bot that talks in the terminal (`platform: ['local']`, every channel). `dsh gateway setup` at
  a terminal shows each messenger with where it stands, and is chosen with ↑↓ and Enter: it opens the
  browser where a token is made (Slack's create-from-manifest page, filled in; @BotFather; Discord's
  Developer Portal), checks each token as it is pasted (shown as `*`) and asks again when it is wrong,
  asks who may talk to it, and offers one restart at Done; a token already saved is offered again
  instead of asked for. Discord's step reads the
  application from the token: it warns while the Message Content intent is off, opens an invite link
  with the permissions the bot needs, and offers "only me" as the application's owner. Without a
  terminal `setup` asks nothing, as before: a platform, tokens from the environment, flags. The
  installer's channel, platform and messenger-token prompts and their helpers are gone.
- **One messenger at a time.** The composite transport sends every conversation the terminal does not
  claim to the first messenger, so a second one set up beside it was never answered. `setup` now
  replaces the messenger there (the guided setup asks first); the old one's tokens stay, its channel
  ids give way to every channel and its people to the ones given. `--yes`, which guarded a `*` that
  opened several messengers at once, is gone.
- **The terminal uses its bottom as Claude Code does.** On a short conversation the input box sat at
  the last rows with the conversation at the top, so `/model`'s list appeared far from where one types.
  The box now follows the conversation and stays at the bottom once the screen is full. `/model` and
  `/sessions` open a picker just above it (`↑↓`, a digit, `↵` or a click; `←→` sets the highlighted
  model's effort) instead of printing a list into the transcript.
- **`shift+tab` steps the reasoning effort**, shown at the left of the status line where `▸▸ ask` used
  to be. That label was never sent by the gateway: it was a default the terminal drew. The model the
  conversation runs on is at the right of the status line. A click on the effort steps it too.
- **The mouse works where the keys do**: a click in the input box puts the cursor there, a click on a
  completion runs or inserts it as `↵` would, and the wheel over a picker or a completion list moves
  its highlight.

### Fixed

- **After a reminder, every message in that conversation failed.** The harness resumes a session for a
  reminder with an agent of its own and keeps it, holding the session, so the conversation's next turn
  was refused ("could not take the session after retries") until the gateway restarted. That turn now
  runs in the agent the harness keeps, with the identity section a turn's own agent gets.
- **A reminder ran on the model a conversation had before `/model` or shift+tab.** The harness routes its
  agent by the session's last request, which knows nothing of the adapter's choice. The adapter now adds
  an `agent/request` listener to each agent the harness makes on a conversation's session, so its
  requests go on the conversation's route as it is at each request. Scenario runs also start each
  conversation on the deployment's model: a choice an earlier run left in the state file made the next
  run's turns take it, and a check passed for that reason.
- **`/model` listed routes with no key.** Every model a registered provider advertises was listed, and a
  conversation moved to a route whose key is set nowhere the harness looks failed every turn. Such a
  route is now left out, read the way the harness's own Models page reads it, and one asked for by name
  is refused with the key it lacks. The DeepSeek account, which signs in, stays.
- **A custom endpoint's context window could be written as another number.** Shell arithmetic wraps at
  2^64, so the installer took `18446744073709551716` and wrote `contextWindow: 100`. A window is now a
  whole number from 1 to 999999999, and one outside that is refused with what was typed.
- **One rare Chinese word was recalled unprompted.** A Chinese word is matched by its overlapping
  pairs of characters, and all of them matched a passage that has it, so one word counted as the two
  distinctive words unprompted recall needs. A span of pairs the passage has side by side now counts
  once (a word said twice is still one, a common pair inside does not split it), a span with four
  rare pairs or more as two, and pairs matched apart still count apart. Known limit: one word of five
  characters or more (a place name) also counts as two; without word segmentation it cannot be told
  from a phrase.
- **In the terminal, a stop or the usage word waited behind the running turn.** The core answers them
  at once, without a turn; queued above the input, the usage word was shown as the next turn's message,
  and the next real message's turn started under it. The gateway now names those words in `ready`, the
  terminal says them at once, and a typed stop puts what waited back in the box, as esc does. (An
  approval's yes or no is answered with its buttons in the terminal.)
- **A model moved to another route was not told.** After `/model` (or a tenant's or the deployment's
  model changing), the model took the turns above for its own. The first turn on another route now
  opens with a `[model changed]` line naming both; an effort step is not a change of model.
- **The instruction root is kept where the agent works.** The harness reads `AGENTS.md` and
  `CLAUDE.md` from a session's directory up to the nearest `.git`. The `.deepbot-root` marker the
  setup and tenant code wrote was never read by it, so a tenant under a home with a `.git` got the
  home's files, and a home under a repository got that repository's. When a directory above has a
  `.git`, the adapter now keeps an empty one in the home and each tenant directory, on every turn (git
  passes over it); with none above it makes none. The sandbox runner refuses removing or moving the
  workspace's `.git`, and a tenant whose directory is not its own, or cannot be kept the root, is
  refused its turn.
- **A gateway serving only the terminal is connected once it has started.** Only a messenger set the
  health file's `connected`, so a terminal-only gateway read as down, and the health probe restarted
  it every five minutes. `install-service.sh` likewise looked for Slack's "Socket Mode connected" in
  the log; it now reads the health file.
- **A `/model` switch reached only the terminal that made it.** Every terminal on the conversation is
  told now; an effort step updates their status lines without a line in the transcript. Two steps sent
  together are taken one after the other.
- **A `dsh` newer than its gateway showed "unknown frame type …".** It now says the gateway is older
  and how to update it; a gateway refuses an unknown frame with its own code, `unknown-frame`.
- **`dsh gateway` sees a harness that was set up before it.** It read only `~/.dsh/.env`. A key
  entered in the DeepSeek Harness app sits in the app's store (`~/.dsh/.credentials.yaml`), which
  the harness reads first. So `status` called the model key missing on a working deployment, and
  `setup` asked again for a token the harness already had. A token written to `.env` under a name the
  store holds would never have been read. Now `status` says where each key is (the app, or `.env`;
  `--json` gives `store`, `dotenv` or `null`) and takes the model's key from the profile's
  `llm-pi-ai` route, else DeepSeek's own. `setup` uses the app's tokens as they are (the same token
  given again is fine), refuses a different one under a name the store holds, checks Slack's two
  tokens against the app-level token the harness will actually read, and never writes the store or
  prints a value from it.

### Added

- **A first step on Windows.** It builds, checkouts are LF everywhere (`.gitattributes`), and CI runs
  the suites that pass on `windows-latest`. The terminal's local transport listens on a named pipe,
  named anew at every start: that namespace is shared by every user of the machine, and a name worked
  out from the path could be taken first. So `dsh` looks its gateway up through the discovery file on
  every reconnect, on every platform; with none registered it dials the last path again, except on
  Windows. When all 16 terminal places are taken, a connection that has sent nothing gives way, so
  read-only opens of the pipe cannot keep the owner out. The installer, services, sandbox and the tool
  gate's link checks are not ported. The health probe's path to `rotate-logs.sh` no longer breaks on a
  path with spaces or non-ASCII characters (`fileURLToPath`).
- **The installer can set up another model provider.** DeepSeek's own API stays the default and needs
  nothing new: the installer's provider question defaults to it, and an existing install keeps its
  `DEEPSEEK_API_KEY` and route. As options it offers OpenGateway or a custom OpenAI-compatible
  endpoint, and for those writes the whole `llm-pi-ai` route and the default model row into the new
  profile (OpenGateway's as the running deployment has it: images,
  DeepSeek's thinking format, four efforts, `medium` by default). It asks for the route's key, offers
  `DEEPSEEK_API_KEY` for web search, and checks what a custom endpoint's answers put into the YAML. A
  rerun asks only for the key the existing route names. A key the harness already resolves — in the
  launch environment, in the DeepSeek Harness app's own store (`~/.dsh/.credentials.yaml`), or in
  `~/.dsh/.env` — is not asked for again, the platform tokens included; it used to look in `.env` only,
  so a harness user was asked for a key the app already had. The store is never written.
- **The agent knows what it is and which settings are its own.** Every session's setup adds a
  system-prompt section: it is deepseek-bot on DeepSeek Harness; this conversation's platform (or the
  terminal) and the language of its notices; what it may change in its home (persona files, notes,
  watches, skills in `.dsh/skills/`); and what only the operator can (model, provider, platforms,
  channels, language, keys, approvals, sandbox), which it points to instead of trying. It was told only
  that it is "a coding agent". The sandbox runner now also denies reading `~/.dsh/profiles`, which
  that section says the agent cannot read.
- **`/model` in the terminal.** It lists the models the registered providers advertise, numbered,
  with this conversation's marked and the reasoning efforts it takes; `/model <n>` or
  `/model <provider>/<model> [effort]` moves this conversation to another from its next turn (the same
  session), and `/model default` moves it back. Unlisted models and unsupported efforts are refused.
  The choice is kept per conversation; nothing else changes. The status line shows the effort.
- **`/exit` in the terminal**, the same as `/quit`.
- **`dsh gateway`: connecting a messenger, and running the service.** The installer set up one
  platform, once; adding another meant editing the profile by hand, and starting or stopping meant
  `launchctl`. `dsh gateway setup <slack|telegram|discord|local>` saves the tokens to `~/.dsh/.env`
  (mode 600), checks them with the platform (`auth.test` and `apps.connections.open`, `getMe`,
  `users/@me`; for Slack, that both tokens are from one app), adds the platform, channels and people
  to the profile's deepbot row without touching any other line, restarts the gateway and waits for
  it to connect. `remove`,
  `start`, `stop` (with the health probe, which would otherwise alert), `restart`, `status [--json]`
  and `manifest slack` (an app manifest) go with it. Every answer can come without a terminal — a
  token from the environment variable of its name, `--channels`, `--users` — so an agent can run it;
  a missing one is exit 2 with nothing written. `dsh gateway` alone still boots a harness profile
  named gateway: only `gateway` followed by one of these commands is taken.
- **`allowedUsers`: who may talk to it.** A Telegram private chat always reaches the bot and the
  installer answers in every Telegram chat, so anyone who found the bot could run turns in the
  agent's workspace; Discord direct messages likewise. The deepbot row now takes a list of user ids;
  someone not in it is ignored without a reply, their button presses too. Empty, the default, keeps
  the old behaviour. The terminal's user is always allowed, in the terminal's own channel. An id
  written unquoted, which YAML reads as a number, is a config error that says to quote it. The
  installer says so for Telegram and Discord, and `dsh gateway setup` asks.
- **English, Korean and Chinese.** A `language` setting in the deepbot row (`en` by default, `ko`,
  `zh`) sets what the bot itself says on every platform (approvals and their buttons, stops,
  failures, the working message, Slack's status, the usage report) and everything `dsh` draws; `dsh`
  starts in its environment's language and takes the gateway's once connected. Stop, usage, allow and
  deny are understood in all three whatever the setting, recall reads Chinese by pairs of
  characters, and the injection check knows Chinese shapes. The installer asks, offering the
  environment's language; an existing profile is told how to set it. An unknown value is a config
  error. The model's answers still follow the persona.

### Changed

- **The bot no longer loads the operator's own skills.** The harness also lists the skills in
  `~/.agents/skills`, where an operator's coding agents keep theirs; the launcher now gives the
  gateway an empty agents home of its own (`DSH_AGENTS_HOME=~/.dsh/deepbot/agents-home`). Takes effect
  when `install-service.sh` is run again. The agent template points skills at `.dsh/skills/`, the
  directory the harness reads, instead of `skills/`, which it never did, and names the terminal.
- **The deployment's reasoning effort reaches a turn.** `agent-default-model`'s `reasoningEffort` was
  read and dropped: only the provider and model were passed to the session. It is passed now, for the
  deployment's own model and only when that model declares the effort — the harness refuses a call
  with one it does not, so it is left out and logged instead. A conversation's `/model` choice carries
  its own; a tenant's model takes none.
- **The health file says when a platform fails to start, and when a Telegram poll recovers.** A
  startup failure was only in the log, so with another platform connected the file read healthy;
  it now carries the error as `lastError`, and the start that works after it clears it. A Telegram
  poll error stayed in `lastError` after polling worked again; the next poll that works clears it.
  The platforms share that field, so each clears only the error it wrote, never another's.
- **`docs/setup.md` asks for `im:history`.** The Slack steps subscribed to `message.im` for direct
  messages without the scope that event needs; the manifest and the steps now include it.
- **A service that fails to install fails the install.** On an account with no
  `~/Library/LaunchAgents`, all four installers failed to write their plist and `install.sh` still
  said "done" and exited 0. The installers make the directory; `install.sh` says which service failed,
  counts the gateway too (its failure was swallowed), and ends with an error when any did. Its output
  now holds back only lines that carry a credential (`token=`, a Slack token, a bearer header, an API
  key), not every line with the word "token", which had cut the web UI's sentence in half.
- **The terminal shows a turn's parts apart.** What the person said is on a band; answers start at
  a `●`; a tool call's `●` blinks while it runs and turns green or red with its result, and stops
  blinking when the turn ends without one; thinking is sky blue, its label swept by a light while it
  streams; a blank line separates a turn's steps and a rule separates exchanges; the status line
  names what is happening (thinking, the running tool, working). A message sent during a turn waits
  above the input, tagged queued, until its turn starts, and `esc` gives what waited back to the
  input, since the gateway withdraws it.
- **The bot's own words default to English.** They were Korean. A Korean deployment keeps them by
  setting `language: ko`; the Korean wording is unchanged.
- **The terminal speaks English.** Its status line, hints, notices, `/help`, usage and exit line were
  Korean in a project whose README and docs are English. The `/interview` instructions to the model
  are English too and ask it to question in the topic's language. The adapter's own messages on the
  platforms (approvals, the working message) are unchanged. When no gateway is running, the terminal
  now says to start one rather than only to add `'local'`, which a new install already has.
  `docs/demo.gif` is recorded again, in English.
- **The terminal is `dsh`.** The command was `deepbot-tui`. It shares its name with the DeepSeek
  Harness CLI, so given anything but its own flags (`--name`, `--socket`, `--tenant`, `--resume`,
  `--help`) it runs that CLI (`DSH_BIN`, or the one inside the app) with them and exits with its status.
  The banner reads DEEPSEEK BOT, and the header shows a workspace under the home directory as `~`. The
  discovery and history paths under `$DSH_HOME` keep their `deepbot-tui` names. `docs/demo.gif` is a
  recording of it.
- **`install.sh` sets up the terminal.** It writes `~/.local/bin/dsh` (leaving a `dsh` that is not its own
  alone), a new profile serves the terminal beside the platform (`platform: ['slack', 'local']`, and
  `tui` added to a list of channels), and it no longer takes its own `dsh` on the `PATH` for the
  harness CLI. A rerun keeps an existing profile and says how to add the terminal to it.
- **The suites, the tools and the runtime scripts are TypeScript.** The suites run as `.ts` under
  Node's type stripping (Node 22.18 or newer, no flag) and `pnpm run typecheck` checks them with
  `test/tsconfig.json`. The health probe, the watch runner and `tools/` are compiled into `dist/`;
  `install-health.sh` and `install-watch.sh` copy the build under the deployed names
  (`health-check.mjs`, `watch.mjs`) and refuse without one. `pnpm persona` and `pnpm qa:slack` run
  from `dist/tools/`.

### Added

- **Install in one line**: `curl -fsSL …/install.sh | bash` fetches, builds, scaffolds the home and
  the profile, asks for the tokens on the terminal and installs the services; running it again
  updates. The profile template carries the sandbox runner, headless approvals and the deepbot row.
- **The platform's own working indicator**: Slack's thread status ("앱이 작업 중"), typing on
  Discord and Telegram; a working message only where that is refused.
- **Approval buttons on every platform**: Block Kit on Slack (needs Interactivity on), an inline
  keyboard on Telegram, components on Discord. Typing 허용 / 거부 still works.
- **Documents a turn made are uploaded** on Slack, Discord and Telegram.
- **Telegram renders Markdown**: bold, code, links and headings as HTML, plain text when refused.
- **Recall without a trigger word**: two rare words in common with a past conversation of the same
  channel are enough, ranked by how rare each word is, with Korean particles stripped.
- **A restart tells the conversation** its turn was lost and asks to be told again.
- **The health probe alerts** once per daily scenario report that has failures.
- **Usage reporting.** Ask `사용량` / `토큰` / `usage` in a conversation and the bot answers
  from durable totals — turns, input tokens and the cache-read share — without starting a
  turn. Tokens only: the harness exposes no price, and the summary says so rather than
  inventing one.

- **Prompt-injection detection.** Fetched material is scanned for instruction-like text and
  annotated at the point of use, and the finding is logged. A mitigation, not a boundary —
  the read scope, the sandbox and the approval gate are what decide.
- Scenario steps can carry `history` and `attachText`, so an injection can arrive through
  the same channel a platform would deliver it through.

- **Link reading, verified and bounded.** The harness's `fetch` tool opens a URL from the
  conversation; a scenario against a locally served page proves the fact and the citation
  both come from the page and not the prompt. The tool gate bounds it: http(s) only, the
  cloud metadata service refused, and an optional host allowlist. Not a browser: no
  JavaScript, no clicking.
- **Per-tenant workspaces.** `tenantIsolation` gives each conversation group its own
  directory — persona, notes, attachments and recall index — and the read scope follows the
  speaker, so one tenant cannot read another's files.

### Fixed

- **`permissionPreset` is applied, and attaching sessions to their workspace is a setting.** Both
  calls sat after a `throw`, inside the branch for an agent that did not come back, since the emptied
  `index.ts` was restored (a0e847e): `permissionPreset` was a setting that did nothing, and no session
  was ever attached. The branch now closes after its `throw`. Attaching is `attachSessions`, off by
  default: it rewrites `~/.dsh/storages/workspace.json`, which the desktop app writes too (last write
  wins), and it only groups the bot's sessions in the desktop sidebar. An unknown `permissionPreset` is
  refused with its name whether or not an agent preset is named.
- **The persona reaches the model again**: `SOUL.md`, `USER.md` and `MEMORY.md` are sent by the
  adapter (the harness's loader reads only `AGENTS.md`), with the speaker named.
- **One turn at a time per conversation**; a stop withdraws what is waiting, and is reported once.
- **Failures are reported in the bot's voice** (Korean, 반말) without host paths; the last
  honorific messages were found by a widened check.
- **Slack's working status stays** while another message in the same thread is still working.
- **The scenario alert and the outage alert have their own rate limits**; one no longer silences the
  other.
- **A turn begun while restart notices go out is tracked**, and a restart during the notices loses
  none: each record stays until its own notice is out.
- **Recall works for a home reached through a symlink**: the indexer names the home by its resolved
  path, as the adapter does.
- **A refused upload is told to the conversation** (Discord's 10 MiB limit, a Slack app without
  `files:write`).
- **Two homes never share a recall index.** The index directory gains a hash of the home's path; the
  next refresh rebuilds it there, and the old directory can be removed by hand.
- **The installer** reads the platform back on a rerun, validates channel ids before writing the
  profile, runs nothing when the download is cut short, and refuses a `DSH_HOME` other than `~/.dsh`;
  reinstalling a service keeps its settings (alert target, deny list).
- **Telegram's renderer** is not fooled by a NUL in the text or a list marker.
- A debounced state write could be lost when the plugin unloaded. Found by checking a
  five-step scenario for its usage totals and finding one turn instead of two: the pending
  timer never fired. The state is flushed on unload now.

### Security

- **Recall stays in its channel**, and only the adapter reads the index: it lives under the harness
  home, which sandboxed commands cannot read.
- **Confinement**: watches the agent writes run read-only in the sandbox; commands cannot read the
  deployment's credentials (a hard link is no way around it), the session store or the gateway's
  logs, nor reach any agent socket of the user's (ssh-agent, 1Password, gpg-agent); the launcher and
  its logs live outside the agent's home; unconfined writes never follow a link.
- **The home's `.env` cannot replace the deployment's tokens**: the agent may not write one, and the
  launcher moves one aside before the gateway starts.
- **An upload sends the bytes of the file that was checked**, read from one descriptor without
  following a link.
- **A conversation block forged in a standing file** (persona, notes), history, an attachment or a
  recalled passage no longer moves a session into another channel's recall: the adapter's markers are
  marked as quoted there, and its session mapping outranks a channel read from text.
- **An approval button answers only the request it was posted with**; an older button cannot approve
  a newer request.
- **The home's `.env` is refused to the file tools** in any case (`.ENV`) and through any link.
- **The sandbox names the workspace by its resolved path too**, and a `DSH_HOME`'s session store and
  recall index are unreadable like `~/.dsh`'s.
- **Nothing machine-specific in the repository**: paths, ids and names moved to the deployment's
  profile and environment (`DEEPBOT_DENY_READ`, scenario `{HOME}` placeholders).

## 0.2.0 — 2026-10-10

M6 and M7 from [PLAN.md](PLAN.md), plus the release work: TypeScript, three transports,
confined reads, images, interruptible turns, and approvals over chat.

### Added

- **Transports.** Slack behind a seam (`transports/slack.ts`), then Telegram (long polling)
  and Discord (gateway websocket + REST). One core, one transport per platform; the core is
  driven in tests by `test/fake-transport.mjs` with no platform account at all.
- **Vision.** An attached image reaches the model as a picture, admitted through the
  harness's attachment service. Verified by a scenario that asks for the colour of a
  solid-colour fixture — a fact nothing in the prompt reveals.
- **Interrupt.** `그만` / `중단` / `취소` / `stop` cancels a running turn, and the same path
  serves the turn timeout, which until then stopped only the waiting.
- **Progress.** One message per conversation, edited in place with tool names and elapsed
  time, replaced by the answer.
- **Approvals over chat.** A request is posted into the conversation and `허용` / `거부`
  settles it. A transport that can render buttons gets them (`supportsButtons`): Discord
  posts an action row and the decision is made in place, with the interaction acknowledged
  before the decision is handed over. Destructive commands inside the workspace — where the
  sandbox permits deletion — ask first.
- **Read confinement.** Commands run under `service/confined-runner.sh`; the file tools are
  fenced by a `tools/pre-execute` read scope over `read`, `read_image`, `grep` and `glob`.
- **TypeScript.** Build toolchain and CI typecheck, hand-written declarations for the DSH
  services this plugin uses (`types/dsh.ts`), and the transport seam as a type.
- `init.sh` for a one-command persona and profile setup, `tools/persona-check.mjs` for
  checking the injected files before they are silently truncated, `npm run persona`.

### Fixed

- A turn that needs an approval no longer waits forever for an answerer that does not exist.
- Standing context is injected once instead of every turn: the persona files are delegated
  to `dsh-agent-instructions`, which appends them as one durable baseline and is written so
  new content does not invalidate the prompt cache.
- The recall index is refreshed after every turn rather than by a ten-minute timer, and no
  longer indexes the adapter's own injected preamble.
- Reconnection retries forever instead of once, with a watchdog: a single retry that failed
  left the bot alive and silent for 57 minutes.
- The document scenario asserts the document's text rather than its byte size. The size
  floor rejected a valid 1 KB docx that a run had built by hand.
- Defects found by running rather than reading: a missing `readdirSync` import that made the
  note index fail silently, a `fetchHistoryConfig` path returning two different types, a
  `mktemp` template BSD could not expand, a stale `dist` being tested, and a profile edit
  that deleted the sandbox row and switched read confinement off for two rounds without
  saying so.

### Security

- An agent's commands cannot read another instance's home or a retired bot's data.
- The file tools refuse reads outside the workspace, temp and read-only tooling.
- A repository-wide secret scan and a persona check run in CI; both fail the build.

### Known limitations

- The read scope is a policy boundary, not a kernel one: the tool list has to grow with the
  composition. One OS user per instance remains the stronger answer, and is not built.
- Images require the model route to declare `input: [text, image]`; text-only deployments
  degrade to a filename.
- One instance is one memory. Multi-tenancy is not built.
- No voice, video, or browser automation.

## 0.1.0 — 2026-10-06

The starting point: a Slack Socket Mode adapter as a DSH bundle plugin with a gateway
profile and a durable thread→session mapping. M0–M5 — presence, a scenario harness, working
memory, health, autonomy and distribution — were built on top of it during the same week,
before this file existed; [PLAN.md](PLAN.md) is the record of those milestones.

## Versioning

These numbers describe this plugin's own surface. Its dependency is DeepSeek Harness
`0.2.0-rc.2`, and a release candidate can change underneath it: the distribution ships no
`.d.ts`, so `types/dsh.ts` is read from the shipped JSDoc and verified by running the real
services. Expect 0.x while the harness is pre-release.
