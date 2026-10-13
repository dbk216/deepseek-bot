# deepbot — plan

Companion to [SPEC.md](SPEC.md). Milestones are ordered by dependency, not by enthusiasm: nothing
is built before the thing it stands on. The detailed history of each milestone is in the git log.

## Working rules

1. **Definition before code.** Each milestone states its acceptance criteria first. A change that
   does not serve a criterion does not ship.
2. **Automate the verification before doing the work.** A fix for something observed failing comes
   with a test that failed first.
3. **Two gates, always:** `pnpm run typecheck` and `pnpm test`. A real-model scenario
   (`node test/run-scenario.mjs test/scenarios/<name>.json`) for anything the model has to do.
4. **Say what is unverified** — in the commit, in this file, in the README — in the same change
   that makes the claim.
5. **The live instance stays up.** Changes reach it by reinstalling or restarting a supervised
   service, and every change leaves it working.
6. **Nothing machine-specific in the repository.** Paths, ids, names and credentials belong to a
   deployment's profile and environment, not to the code, the tests or the docs.

## Done

| Milestone | What it gave |
|---|---|
| M0 Presence | Slack Socket Mode adapter, durable session per thread, supervised service, reconnect forever |
| M1 Test harness | scenario runner against a real model in a separate profile and home |
| M2 Memory | persona and notes in the prompt, a recall index over past sessions, notes hygiene |
| M3 Never silently dead | health file, external probe, alerts, log rotation |
| M4 Autonomy | reminders through the schedule bundle, watches ("tell me when this changes") |
| M5 Distribution | one-command install, profile template, CI |
| M6 Transports | one core, Slack / Telegram / Discord, a fake transport for the core's tests, approvals over chat |
| M7 Agent gaps | attachments and vision, read confinement, per-tenant policy, fetch policy, usage totals |
| Round 66 | persona restored to the prompt; the platform's own working indicator; one turn at a time per conversation; recall scoped to its channel; documents uploaded; watches and commands confined (credentials, session store, ssh-agent, the launcher and its logs out of the agent's home; no writes through links) |
| Round 67 | one-line install; the home's `.env` refused; recall read only by the adapter, ranked by rare words and offered without a trigger word; failures in the bot's voice without host paths, a stop reported once; a restart tells the conversation its turn was lost; the probe alerts on failed scenarios; no agent socket of the user's reachable from the sandbox, hard links pinned by a test; uploads send the checked bytes; approval buttons and uploads on every platform; Markdown rendered on Telegram |

## Open

- **A check-then-write window in `writeInside`.** It checks a directory's real path, then writes by
  path; Node has no `openat` to write relative to a checked directory descriptor. Exploiting it needs
  a process inside the agent's sandbox racing the check. Uploads no longer share the window: the
  bytes are read from the descriptor that was checked.
- **The live round trip on Discord and Telegram**: typing, uploads, buttons and Telegram's rendering
  are tested against mocked APIs only (see Unverified).

Decided against:

- **Permalinks on Discord and Telegram.** On Slack a link points at a thread inside a channel; on
  Discord and Telegram the conversation *is* the channel or chat, Discord's `<#channel>` mention is
  already a link, and a private Telegram chat has none. A link to where the person already is would
  be a knob that does nothing.

## Unverified

- Discord and Telegram typing, uploads and approval buttons, and Telegram's HTML rendering: mocked
  APIs only, no live server or bot.
- Slack approval buttons in a real workspace: they need Interactivity turned on in the app's
  settings; without it a press does nothing and the person types the answer, which the request offers.
- Which Slack status method a given workspace accepts; the plugin logs each refusal.
- Whether a Slack app has `files:write` for uploads; a refusal is logged, the answer is unaffected.
