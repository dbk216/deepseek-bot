# Setup and operations

Creating the chat app for each platform, and running the services once deepseek-bot is installed.
The install itself is one line, in the [README](../README.md).

## Platform setup

### Slack

1. Create an app at <https://api.slack.com/apps>.
2. **Socket Mode** → on → generate an app-level token with `connections:write` (`xapp-…`). No public
   URL is needed.
3. **OAuth & Permissions** → bot scopes: `app_mentions:read`, `chat:write`, `channels:read`,
   `channels:history` (plus `groups:history` for private channels), `users:read`, `files:read`
   (attachments) and `files:write` (document uploads).
4. **Event Subscriptions** → subscribe to `app_mention` (and `message.im` for DMs).
   **Interactivity & Shortcuts** → on (no request URL is needed in Socket Mode), for the approval
   buttons; without it a press does nothing and the person types 허용 / 거부 instead.
5. Install it to the workspace and copy the bot token (`xoxb-…`).
6. `/invite` the bot into every channel it should serve. **A bot cannot see a channel it has not
   been invited to** — the most common silent failure.

The working status ("앱이 작업 중") uses `agents.sessions.setStatus`, or
`assistant.threads.setStatus` where the workspace has not turned agent sessions on; both need only
`chat:write` (Slack's method reference, checked 2026-10-13; the second also accepts `assistant:write`
for now). If both are refused, a `⏳ … 작업 중…` message stands in and the reply replaces it. Not yet
observed in a live workspace: no turn has run on this code there.

> One Socket Mode connection per app. A second one makes Slack split events across them and both
> start dropping messages: stop any other process using the same app first.

### Telegram

Create a bot with [@BotFather](https://t.me/BotFather) and give the installer its token. In groups,
mention the bot or reply to it; for it to see group messages at all, turn off privacy mode in
BotFather (`/setprivacy`).

### Discord

Create an application at <https://discord.com/developers/applications>, add a bot, turn on the
**Message Content** privileged intent, and invite it with the `bot` scope and the *Send Messages*,
*Read Message History* and *Attach Files* permissions. Give the installer the bot token.

## Running it

The installer leaves four launchd jobs; each script also takes `--status` and `--uninstall`.

```bash
~/.deepbot/service/install-service.sh --status    # the gateway: state, port, recent plugin log
node ~/.dsh/service/health-check.mjs --status     # what the bot itself reports
~/.deepbot/service/install-health.sh --uninstall  # remove the health probe (likewise the others)
```

| Job | Script | What it does |
|---|---|---|
| gateway | `service/install-service.sh` | runs the harness with this profile; restarts on exit |
| health | `service/install-health.sh` | probes every 5 minutes, restarts a disconnected bot, rotates logs |
| watch | `watch/install-watch.sh` | evaluates due watches every minute |
| recall index | `recall/install-refresh.sh` | rebuilds the recall index every 10 minutes (it is also rebuilt after every turn) |

Runtime copies (the launcher, the sandbox runner, the probe) live in `~/.dsh/service`, outside the
agent's home, and their logs in `~/.dsh/service/logs`: nothing the agent can write is ever run
unconfined. To change where a deployment's own private data is protected from the agent's commands,
set `DEEPBOT_DENY_READ` (colon-separated paths) before installing the services.

`targetChannels` in the profile's `cordis.patch.yml` accepts channel ids or `'*'` for every channel
the bot was invited to; **the plugin refuses to start with an empty list**. `replyMode: mention`
answers @-mentions in channels (DMs always); `'all'` answers every human message in them.
