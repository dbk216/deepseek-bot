# AGENTS.md — working in this repository

For an agent about to change this deployment. Four principles, adapted from
[andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills) (MIT), each one
followed by what it cost to learn here.

## 1. Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- **State the assumption you are about to act on.** An anchor you have not read, a symbol you have
  not grepped, a behaviour you believe exists. Three rounds were spent editing a function whose name
  was guessed; `grep -n` found it in one command.
- **Do not build on a claim you have not checked.** Two features were "done" because the code
  typechecked, and neither ran: one block sat after a `throw`, another inside a branch that never
  executes. A typecheck does not catch dead code.
- **Push back with the simpler option.** "No per-conversation serialization exists; collisions are
  absorbed by the adapter's retry" was found by reading rather than by assuming the design was wrong.
- **Say when something is unverified** — in the commit message, in `PLAN.md`, or as a `TODO` printed
  by the suite that would otherwise check it. Never leave it implied.

## 2. Simplicity first

Minimum that solves the problem. Nothing speculative.

- **No new runtime dependencies.** The plugin imports nothing from `node_modules`; adding one is a
  decision, not an implementation detail. Semantic recall was solved as lexical scoring for this
  reason, and the limitation is written down instead of hidden.
- **No knob that does not work.** A per-tenant `permission` key was read and never used, so it was
  removed rather than documented as supported. A half-working option is worse than a missing one.
- **Prefer the smaller change.** A one-line ranking fix beat a new search subsystem; a directory per
  tenant beat a new storage layer.

## 3. Surgical changes

Touch only what you must. Clean up only your own mess.

- **Replace whole lines, found by substring.** A partial replacement truncated a call and crashed a
  suite; a blanket `policy.permission` → `permissionName` replace rewrote a *declaration* and two
  commits left with a type error.
- **Do not improve adjacent code.** The scan rewrote an unrelated `permissionName` line, and adding
  the rotation call put an import above a shebang, breaking a job this deployment depends on.
- **Remove what your change orphans, and nothing else.** Dead code found earlier stays until asked.

## 4. Goal-driven execution

Define success criteria. Loop until verified.

- **Write the check before the fix.** The third-party-approval gap was *proved* by a failing test
  before any code changed; the state-growth defect was proved by seeding 400 stale conversations.
- **Never pipe a suite into `head` in a gate.** `node test/x.mjs | head -3` closes the pipe, node dies
  of EPIPE, and the exit status says 1 for a suite that passed. Four rounds went into chasing a
  "flaky guard" that was this. Run suites with output to a file and read the exit code.
- **Gate on both: `pnpm run typecheck` and `pnpm test`.** One commit reached `origin` with a type
  error because only the tests were checked. Assert the shape, edit, gate, and restore on failure —
  six mistakes were caught this way, and the only one that escaped was the one with a single gate.
- **A test that passes for the wrong reason is worse than a failing one.** Three were found here: a
  fixture whose winner was also the newest row, a stub that accepted any id so a refusal path was
  never entered, and a scenario asserting a tool *choice* rather than the artifact. Make the fixture
  unable to satisfy the claim by accident.
- **Verify where it runs.** `node test/run-scenario.mjs test/scenarios/<name>.json` against a real
  model (not in CI; `service/run-scenarios.sh` runs the set daily), then restart the live bot and
  read `node ~/.dsh/service/health-check.mjs --status`.

## Facts worth knowing

- The harness ships **no `.d.ts`**; `types/dsh.ts` is hand-written from the READMEs and verified by
  running. DSH packages cannot be imported from this plugin — service calls only.
- Session logs are `session.v4.jsonl.zstd`, one zstd frame per write, split on `28 B5 2F FD`.
- Profiles live outside the repository (`~/.dsh/profiles/`); a `config:` block **replaces the whole
  config**, so a new `- id: deepbot` row must restate every setting it means to keep.
- `test/profile.test.mjs` checks the composed posture, because profile edits have silently changed
  it three times.

## Map

| path | what |
|---|---|
| `index.ts` | the adapter: orchestration, policy gates, prompt assembly |
| `transports/` | Slack, Telegram, Discord, attachments — the platform seam |
| `recall/` | the session index (JavaScript today; the TypeScript port is in `PLAN.md`) |
| `service/` | runner, gateway, health, rotation, scenario schedule |
| `test/` | unit suites, scenarios, fixtures |
| `docs/` | API notes, limitations |
| `PLAN.md` | what is done, what is next, and what is unverified |
