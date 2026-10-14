# Setup and operations

Creating the chat app for each platform, and running the services once deepseek-bot is installed.
The install itself is one line, in the [README](../README.md).

## Connecting a messenger: `dsh gateway`

The installer sets up one platform. `dsh gateway setup` adds another, or replaces a token, at any time:

```bash
dsh gateway setup discord                  # asks for the token, then who may talk to it
dsh gateway manifest slack                 # a Slack app manifest, to create the app from
dsh gateway status                         # the service, the platforms, the tokens, the connection
```

`setup` saves the tokens to `~/.dsh/.env` (mode 600), asks the platform whether they work and whose
bot they belong to (for Slack, that both tokens are from one app), adds the platform to the profile's
deepbot row — nothing else in the file changes — and restarts the gateway, waiting until it is
connected. With several platforms the health file keeps one flag for all of them, so "connected"
means one did: `setup` then watches a few seconds more for another reporting an error, and says it
cannot tell which. Message the one you set up to see it answer.

Every question has an answer that needs no terminal, so an agent such as Claude Code can run it too:
a token comes from the environment variable of its own name (`SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`,
`TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`), the channels from `--channels`, the people from `--users`.
Without a terminal a missing answer is exit 2 and nothing is written. A token is never an argument:
arguments show in `ps` and in shell history.

```bash
TELEGRAM_BOT_TOKEN=… dsh gateway setup telegram --users 123456789
```

| Command | What it does |
|---|---|
| `setup <platform>` | tokens, the platform in the profile, `--channels`, `--users`; `--no-verify`, `--no-restart`. The channel list is shared too: `--channels '*'` opens every platform the profile serves, so with another one served it needs `--yes` |
| `remove <platform>` | takes it out of the profile; its tokens stay in `~/.dsh/.env` |
| `start` / `stop` / `restart` | the gateway's launchd job. `stop` stops the health probe too, which would otherwise alert that the gateway is down; both come back at login or with `start` |
| `status [--json]` | exit 0 when the gateway runs, is connected and has its tokens. Token values are never shown |
| `manifest slack` | the Slack app manifest: Socket Mode, the scopes and events below, interactivity |

`platform` is `slack`, `telegram`, `discord` or `local` (the terminal). Exit status: 0 done; 1 failed,
not connected, or a platform that could not be reached; 2 a missing or invalid answer, with nothing
written; 130 cancelled. The bot itself cannot set up or remove a platform: its commands run in a
sandbox that cannot write `~/.dsh`. That sandbox confines writes only, so `start`, `stop` and
`restart` — calls to launchd, as `launchctl` itself is — are not kept from it.

**Who may talk to it.** `allowedUsers` in the deepbot row lists user ids; `--users` adds to it.
Empty — the default — means anyone who can reach the bot in an allowed channel. On Telegram and
Discord a direct message always reaches it, so there that is anyone who finds it: list yourself. The
list is shared by the platforms, so once it holds ids, the people on every platform must be in it. The
terminal's user is always allowed. Someone not listed starts no turn and gets no reply, and their
approval button presses are ignored too. What they wrote can still reach the model as part of a
thread or channel's history, when a listed person asks in that thread or channel. Write ids quoted
(`'123456789'`): unquoted, YAML reads a number, and a long Discord id loses digits on the way.

## Platform setup

### Slack

The quickest way is a manifest: `dsh gateway manifest slack`, then <https://api.slack.com/apps> →
Create New App → From a manifest, and paste it. It sets steps 2 to 4 except the app-level token;
generate that under Basic Information → App-Level Tokens. By hand:

1. Create an app at <https://api.slack.com/apps>.
2. **Socket Mode** → on → generate an app-level token with `connections:write` (`xapp-…`). No public
   URL is needed.
3. **OAuth & Permissions** → bot scopes: `app_mentions:read`, `chat:write`, `channels:read`,
   `channels:history` (plus `groups:history` for private channels and `im:history` for DMs),
   `users:read`, `files:read` (attachments) and `files:write` (document uploads).
4. **Event Subscriptions** → subscribe to `app_mention` (and `message.im` for DMs).
   **Interactivity & Shortcuts** → on (no request URL is needed in Socket Mode), for the approval
   buttons; without it a press does nothing and the person types allow / deny (or 허용 / 거부, 允许 / 拒绝) instead.
5. Install it to the workspace and copy the bot token (`xoxb-…`). Give both tokens to the installer,
   or to `dsh gateway setup slack`. A member id for `--users` is under a profile → ⋮ → Copy member ID.
6. `/invite` the bot into every channel it should serve. **A bot cannot see a channel it has not
   been invited to** — the most common silent failure.

The working status ("Working…", in the deployment's `language`) uses `agents.sessions.setStatus`, or
`assistant.threads.setStatus` where the workspace has not turned agent sessions on; both need only
`chat:write` (Slack's method reference, checked 2026-10-13; the second also accepts `assistant:write`
for now). If both are refused, a `⏳ … is working…` message stands in and the reply replaces it. Not yet
observed in a live workspace: no turn has run on this code there.

> One Socket Mode connection per app. A second one makes Slack split events across them and both
> start dropping messages: stop any other process using the same app first.

### Telegram

Create a bot with [@BotFather](https://t.me/BotFather) and give the installer, or
`dsh gateway setup telegram`, its token. In groups, mention the bot or reply to it; for it to see group
messages at all, turn off privacy mode in BotFather (`/setprivacy`). Anyone on Telegram who finds the
bot can message it: list who may with `--users` — your numeric id is what
[@userinfobot](https://t.me/userinfobot) replies.

### Discord

Create an application at <https://discord.com/developers/applications>, add a bot, turn on the
**Message Content** privileged intent, and invite it with the `bot` scope and the *Send Messages*,
*Read Message History* and *Attach Files* permissions. Give the installer, or
`dsh gateway setup discord`, the bot token. For `--users`: Developer Mode on, then right-click a name →
Copy User ID.

## Running it

The installer leaves four launchd jobs; each script also takes `--status` and `--uninstall`.

```bash
dsh gateway status                                # the gateway, its platforms, tokens and connection
dsh gateway restart                               # after editing the profile by hand
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
`allowedUsers` narrows who, as above.
