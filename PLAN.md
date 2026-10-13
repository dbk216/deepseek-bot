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

## Open

In order of impact.

- **The agent can rewrite its home's `.env`.** The harness's credential chain reads `<cwd>/.env`
  before `~/.dsh/.env`, and the agent works in that directory.
- **The agent can read the whole recall index with its own tools.** The channel filter applies to
  what the adapter injects, not to what the agent reads.
- **The credential deny is by path.** A hard link elsewhere to the same file is not covered.
- **Recall needs a trigger word** and ranks by plain word overlap.
- **A restart loses a turn in flight** without telling the conversation.
- **Some replies are English** ("Execution failed", "The turn did not complete") in a deployment
  that speaks Korean.
- **The daily scenario run has no alert** when it fails.
- **Platform gaps:** approval buttons only on Discord, uploads and permalinks only on Slack, no
  Markdown rendering on Telegram.
- LOW: a check-then-write window in `writeInside` and before an upload; ssh-agent sockets other
  than launchd's; a stop during preparation reports twice.

## Unverified

- Discord and Telegram typing and uploads: mocked APIs only, no live server.
- Which Slack status method a given workspace accepts; the plugin logs each refusal.
- Whether a Slack app has `files:write` for uploads; a refusal is logged, the answer is unaffected.
