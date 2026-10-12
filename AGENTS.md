# AGENTS.md — working in this repository

Written for an agent that is about to change this deployment. It is short on purpose: every line
below cost something to learn.

## What this is

`deepbot` is a bundle plugin for DeepSeek Harness that puts an always-on agent in Slack (with
Telegram and Discord behind the same transport seam), plus the profiles, scripts and launchd jobs
that run it. The live deployment is on this machine; the harness is at
`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh`.

## Before you commit anything

1. `pnpm run typecheck` **and** `pnpm test` — both, every time. One commit went out with a type error
   because only the second was checked.
2. If a change can break behaviour a test does not cover, run the scenario for it:
   `node test/run-scenario.mjs test/scenarios/<name>.json`. These need a model and are not in CI;
   `service/run-scenarios.sh` runs the whole set daily.
3. The live bot must keep working. Restart it after a build:
   `launchctl kickstart -k gui/$(id -u)/ai.deepbot.gateway`, then
   `node ~/.dsh/service/health-check.mjs --status`.

## How to edit files here

The failures in this repository have come from editing, not from design:

- **Find by substring, never by guessing an anchor.** `grep -n` first, then edit. Guessed anchors
  matched nothing, or matched a comment instead of the line.
- **Replace whole lines.** A partial replacement once truncated a function call and crashed a suite;
  a blanket `policy.permission` → `permissionName` replace rewrote a *declaration*.
- **Assert before you write, and restore on failure.** Write the shape check, then the edit, then
  gate on typecheck and tests, and if either fails put the file back. Six mistakes were caught this
  way; the one that reached `origin` was the one where only one gate was checked.
- **Typechecking does not catch dead code.** A block inserted after a `throw`, and another inside a
  branch that never runs, both typechecked perfectly and did nothing.

## Writing tests

A test that passes for the wrong reason is worse than a failing one. Three were found here:

- a fixture whose expected winner was also the newest row, so it would pass on recency alone;
- a stub `agentPresets.resolve` that accepted any id, so the refusal path was never entered;
- a scenario that asserted a tool *choice* rather than the artifact.

State the claim, then make the fixture unable to satisfy it by accident.

## What is deliberately not here

- **No runtime dependencies.** The plugin resolves nothing from `node_modules`. Adding one is a
  decision, not an implementation detail.
- **Dist facts are read, not assumed.** The harness ships no `.d.ts`; `types/dsh.ts` is hand-written
  from the READMEs and verified by running. DSH packages cannot be imported from this plugin.
- **Claims are pinned or they are not made.** Anything the README asserts has a test, a scenario, or
  a live check behind it, and anything unverified says so — in `docs/limitations.md`, in `PLAN.md`,
  or printed as a `TODO` by the suite that would otherwise check it.

## Map

| path | what |
|---|---|
| `index.ts` | the adapter: core orchestration, policy gates, prompt assembly |
| `transports/` | Slack, Telegram, Discord, attachments — the platform seam |
| `recall/` | the session index (JavaScript today; see PLAN for the TypeScript port) |
| `service/` | runner, gateway, health, rotation, scenario schedule |
| `test/` | unit suites (`*.test.mjs`), scenarios, fixtures |
| `docs/` | API notes, limitations, research |
| `PLAN.md` | what is done, what is next, and what is unverified |
