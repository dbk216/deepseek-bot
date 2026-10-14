#!/usr/bin/env bash
# deepbot — install or update, in one line (macOS):
#
#   curl -fsSL https://raw.githubusercontent.com/rlaope/deepseek-bot/master/install.sh | bash
#
# Fetches deepbot into ~/.deepbot, builds it, creates the agent's home and the gateway profile, stores
# the platform tokens in the harness's credential file, and installs the services that keep it running.
# Run it again to update: every file you have edited is kept, and no token is asked for twice.
#
# Optional environment:
#   DEEPBOT_DIR      where the source lives               (default ~/.deepbot)
#   DEEPBOT_HOME     the agent's home                     (default ~/dsh-agent)
#   DEEPBOT_PROFILE  the gateway profile                  (default agent)
#   DEEPBOT_REPO     the git repository to install from   (default this project on GitHub)
#   DEEPBOT_REF      branch or tag                        (default master)
#   DSH_BIN          the dsh CLI                          (default: inside DeepSeek Harness.app)
#   DEEPBOT_SKIP_SERVICES=1   build and configure only; install no launchd jobs
set -euo pipefail

# Helpers at the top level, so a test can source this file (DEEPBOT_INSTALL_SOURCED=1) and call them.

# The channels as a YAML list, from what a person typed: ids separated by spaces or commas, or * alone.
# It goes into the profile through sed, so nothing but an id's characters gets through; and it is split
# with globbing off, since an unquoted * expanded to the files in the directory.
channel_list() {
  local input="$1" ids=() id out=''
  if [ "$input" = '*' ]; then printf "['*']\n"; return 0; fi
  local IFS=$' \t,'
  set -f; read -r -a ids <<< "$input"; set +f
  [ "${#ids[@]}" -gt 0 ] || return 1
  for id in "${ids[@]}"; do
    [[ "$id" =~ ^[A-Za-z0-9_-]+$ ]] || return 1
    out="${out:+$out, }'$id'"
  done
  printf '[%s]\n' "$out"
}

# The platform an existing profile names, so a rerun asks for that platform's tokens; slack if none.
# A profile written by this installer lists the terminal beside it — platform: ['slack', 'local'] — and
# `dsh gateway setup` adds others after it, so it is the first messenger on the line.
profile_platform() {
  local line found
  line="$(grep -m1 -E '^    platform: ' "$1" 2>/dev/null || true)"
  found="$(printf '%s\n' "$line" | grep -o -E 'slack|telegram|discord' | head -1 || true)"
  printf '%s\n' "${found:-slack}"
}

# The channels with the terminal's added: its conversations are in a channel named tui.
with_terminal() {
  if [ "$1" = "['*']" ]; then printf '%s\n' "$1"; else printf '%s\n' "${1%]}, 'tui']"; fi
}

# The language a new profile starts in: the environment's, read in the POSIX order (LC_ALL, LC_MESSAGES,
# LANG), the first one set deciding. English when it names none of the three. The plugin reads the same way.
env_language() {
  local v
  for v in "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
    case "$v" in ''|C|POSIX) continue ;; esac
    v="$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')"
    case "$v" in
      ko|ko[_.@-]*|kor|kor[_.@-]*|korean|korean[_.@-]*) echo ko ;;
      zh|zh[_.@-]*|chi|chi[_.@-]*|zho|zho[_.@-]*|chinese|chinese[_.@-]*) echo zh ;;
      *) echo en ;;
    esac
    return 0
  done
  echo en
}

set_profile_language() {   # set_profile_language <patch> <en|ko|zh>
  sed -i '' -e "s/^    language: en$/    language: $2/" "$1"
}

# The first line after the shebang marks a launcher this installer wrote, so a rerun knows it may
# replace it, and harness_cli knows not to take it for the harness.
LAUNCHER_MARK='# deepseek-bot terminal launcher'

# `dsh` in ~/.local/bin, running the checkout's build. A dsh already there that is not ours — the
# harness CLI, say — is left as it was.
install_terminal() {   # install_terminal <checkout>
  local launcher="$HOME/.local/bin/dsh"
  if [ -e "$launcher" ] && ! grep -q "^$LAUNCHER_MARK" "$launcher" 2>/dev/null; then
    printf '%s is not this project'"'"'s; run the terminal as: node %s/dist/tui/main.js\n' "$launcher" "$1"
    return 1
  fi
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\n%s (install.sh writes it; a rerun replaces it)\nexec node "%s/dist/tui/main.js" "$@"\n' "$LAUNCHER_MARK" "$1" >"$launcher"
  chmod +x "$launcher"
  printf '%s\n' "$launcher"
}

# The harness CLI: a dsh on the PATH unless it is this project's terminal, else the one in the app.
harness_cli() {
  local found
  found="$(command -v dsh 2>/dev/null || true)"
  if [ -n "$found" ] && ! grep -q -e "^$LAUNCHER_MARK" -e 'dsh: the bot in a terminal' "$found" 2>/dev/null; then
    printf '%s\n' "$found"
  else
    printf '%s\n' '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
  fi
}

# The services, the runner and the health probe read the harness's home at ~/.dsh. A DSH_HOME elsewhere
# would put the tokens and the profile where nothing running looks.
check_dsh_home() {
  [ -z "${DSH_HOME:-}" ] || [ "${DSH_HOME%/}" = "$HOME/.dsh" ] || {
    printf 'error: DSH_HOME=%s is not supported by this installer; the services read %s\n' "$DSH_HOME" "$HOME/.dsh" >&2
    return 1
  }
}

step() { printf '%s==>%s %s\n' "${blue:-}" "${off:-}" "$*"; }
note() { printf '    %s%s%s\n' "${dim:-}" "$*" "${off:-}"; }
die()  { printf '%serror:%s %s\n' "${red:-}" "${off:-}" "$*" >&2; exit 1; }

# A line that may carry a credential: the web UI's ?token=, a Slack token, a bearer header, an API key.
# Only those are held back — a sentence that merely says "token" is not one, and used to be cut in half.
without_secrets() { grep -v -i -E 'token=|token:|xox[a-z]-|xapp-|bearer |sk-[a-z0-9]' || true; }

SERVICES_FAILED=0
service_install() {   # service_install <what> <installer> [show]: one service; a failure is said and counted
  local status=0
  if [ "${3:-}" = show ]; then
    "$2" 2>&1 | without_secrets | sed 's/^/    /' || status=${PIPESTATUS[0]}
  else
    "$2" >/dev/null 2>&1 || status=$?
  fi
  if [ "$status" -eq 0 ]; then note "$1 installed"
  else note "$1: $(basename "$2") failed — run it by hand to see why"; SERVICES_FAILED=$((SERVICES_FAILED + 1)); fi
}

services_done() {     # the end of the services step: a failed one fails the install
  [ "$SERVICES_FAILED" -eq 0 ] && return 0
  step "done, but $SERVICES_FAILED service(s) did not install"
  note "the bot is not running as a service until they do; rerun the line above after fixing what they said"
  return 1
}

main() {

DEEPBOT_DIR="${DEEPBOT_DIR:-$HOME/.deepbot}"
DEEPBOT_HOME="${DEEPBOT_HOME:-$HOME/dsh-agent}"
DEEPBOT_PROFILE="${DEEPBOT_PROFILE:-agent}"
DEEPBOT_REPO="${DEEPBOT_REPO:-https://github.com/rlaope/deepseek-bot.git}"
DEEPBOT_REF="${DEEPBOT_REF:-master}"
check_dsh_home || exit 1
DSH_HOME="$HOME/.dsh"
DSH_BIN="${DSH_BIN:-$(harness_cli)}"
export DSH_HOME DSH_BIN DEEPBOT_HOME DEEPBOT_PROFILE

blue=$'\033[38;5;33m'; dim=$'\033[2m'; bold=$'\033[1m'; red=$'\033[31m'; off=$'\033[0m'
[ -t 1 ] || { blue=''; dim=''; bold=''; red=''; off=''; }

cat <<BANNER
${blue}
        ▄▄████▄▄            ▄▄
      ▄██████████▄▄▄     ▄▄██
     ████▀ ▀████████████████▀     ${bold}deepbot${off}${blue}
     ████▄▄▄█████████████▀▀      ${off}${dim}an always-on agent on DeepSeek Harness${off}${blue}
      ▀████████████▀▀▀
         ▀▀▀▀▀▀
${off}
BANNER

# Prompts read the terminal, not stdin: under `curl … | bash` stdin is this script.
TTY=''
if [ -r /dev/tty ] && [ -w /dev/tty ] && (exec </dev/tty) 2>/dev/null; then TTY=/dev/tty; fi
ask() {         # ask <var> <question> [default]
  local answer=''
  if [ -n "$TTY" ]; then printf '    %s%s%s ' "$bold" "$2${3:+ [$3]}" "$off" >"$TTY"; IFS= read -r answer <"$TTY" || true; fi
  printf -v "$1" '%s' "${answer:-${3:-}}"
}
ask_secret() {  # ask_secret <var> <question> — never echoed
  local answer=''
  if [ -n "$TTY" ]; then printf '    %s%s%s ' "$bold" "$2" "$off" >"$TTY"; IFS= read -rs answer <"$TTY" || true; printf '\n' >"$TTY"; fi
  printf -v "$1" '%s' "$answer"
}

step "checking what this needs"
[ "$(uname -s)" = "Darwin" ] || die "macOS only: the services are launchd jobs and the sandbox runner is Seatbelt."
command -v git >/dev/null || die "git is not installed (xcode-select --install)."
command -v node >/dev/null || die "Node.js 22 or newer is needed (brew install node)."
command -v npm >/dev/null || die "npm is needed (it ships with Node.js)."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || die "Node.js 22 or newer is needed; this is $(node -v)."
[ -x "$DSH_BIN" ] || die "DeepSeek Harness was not found at $DSH_BIN — install the app, or set DSH_BIN."
note "node $(node -v) · git · dsh at $DSH_BIN"

step "fetching deepbot into $DEEPBOT_DIR"
if [ -d "$DEEPBOT_DIR/.git" ]; then
  git -C "$DEEPBOT_DIR" fetch --quiet --depth 1 origin "$DEEPBOT_REF"
  git -C "$DEEPBOT_DIR" checkout --quiet -B "$DEEPBOT_REF" FETCH_HEAD
  note "updated to $(git -C "$DEEPBOT_DIR" rev-parse --short HEAD)"
elif [ -e "$DEEPBOT_DIR" ]; then
  die "$DEEPBOT_DIR exists and is not a git checkout; move it aside or set DEEPBOT_DIR."
else
  git clone --quiet --depth 1 --branch "$DEEPBOT_REF" "$DEEPBOT_REPO" "$DEEPBOT_DIR"
  note "cloned $(git -C "$DEEPBOT_DIR" rev-parse --short HEAD)"
fi

step "building"
( cd "$DEEPBOT_DIR" && npm install --no-audit --no-fund --loglevel=error >/dev/null && npm run --silent build )
[ -f "$DEEPBOT_DIR/dist/index.js" ] || die "the build produced no dist/index.js"
note "dist/ ready"

step "agent home and gateway profile"
profile_dir="$DSH_HOME/profiles/$DEEPBOT_PROFILE"
new_profile=0; [ -e "$profile_dir" ] || new_profile=1
# Asked, and checked, before init.sh writes the profile: a refused answer used to leave a profile behind
# that a rerun then kept as it was.
platform="$(profile_platform "$profile_dir/cordis.patch.yml")"; channels='*'
if [ "$new_profile" -eq 1 ]; then
  ask platform "platform (slack / telegram / discord)?" slack
  case "$platform" in slack|telegram|discord) ;; *) die "unknown platform: $platform" ;; esac
  if [ "$platform" != telegram ]; then ask channels "channels to answer in (* = every channel it is invited to, or ids separated by spaces)?" '*'; fi
  ask language "language of the bot's own messages and of dsh (en / ko / zh)?" "$(env_language)"
  case "$language" in en|ko|zh) ;; *) die "unknown language: $language (en, ko or zh)" ;; esac
  list="$(channel_list "$channels")" || die "channel ids are letters, digits, - and _ (got: $channels)"
fi
DEEPBOT_INSTALLER=1 DSH_BIN="$DSH_BIN" "$DEEPBOT_DIR/init.sh" --home "$DEEPBOT_HOME" --profile "$DEEPBOT_PROFILE" | sed 's/^/    /'

step "platform and credentials"
note "tokens go to $DSH_HOME/.env (mode 600); the harness reads them, this code never stores them"
mkdir -p "$DSH_HOME"; touch "$DSH_HOME/.env"; chmod 600 "$DSH_HOME/.env"
has_key() { grep -q "^$1=" "$DSH_HOME/.env" 2>/dev/null; }
put_key() {     # put_key <name> <question> — only when it is not there yet
  local value=''
  if has_key "$1"; then note "$1 already set"; return; fi
  ask_secret value "$2"
  if [ -n "$value" ]; then printf '%s=%s\n' "$1" "$value" >>"$DSH_HOME/.env"; note "$1 saved"; else note "$1 skipped — add it to $DSH_HOME/.env later"; fi
}
case "$platform" in
  slack)    put_key SLACK_BOT_TOKEN "Slack bot token (xoxb-…):"; put_key SLACK_APP_TOKEN "Slack app-level token (xapp-…):" ;;
  telegram) put_key TELEGRAM_BOT_TOKEN "Telegram bot token:" ;;
  discord)  put_key DISCORD_BOT_TOKEN "Discord bot token:" ;;
esac
put_key DEEPSEEK_API_KEY "DeepSeek API key:"

if [ "$new_profile" -eq 1 ]; then
  patch="$profile_dir/cordis.patch.yml"
  list="$(with_terminal "$list")"
  sed -i '' -e "s/^    platform: slack$/    platform: ['$platform', 'local']/" -e "s/^    targetChannels: \['\*'\]$/    targetChannels: $list/" "$patch"
  set_profile_language "$patch" "$language"
  note "profile: platform $platform and the terminal, channels $list, language $language"
else
  note "profile $DEEPBOT_PROFILE already existed — its settings are kept"
  grep -q "^    platform: .*'local'" "$profile_dir/cordis.patch.yml" 2>/dev/null \
    || note "to use dsh, add the terminal to the profile: dsh gateway setup local"
  grep -q "^    language: " "$profile_dir/cordis.patch.yml" 2>/dev/null \
    || note "the bot speaks English; for Korean or Chinese add language: ko or zh to the deepbot row"
fi

step "the terminal"
if launcher="$(install_terminal "$DEEPBOT_DIR")"; then
  note "dsh: $launcher"
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) note "add ~/.local/bin to your PATH to run it as dsh" ;; esac
else
  note "$launcher"
fi

if [ "${DEEPBOT_SKIP_SERVICES:-0}" = "1" ]; then
  step "services skipped (DEEPBOT_SKIP_SERVICES=1)"
  note "start it by hand: \"$DSH_BIN\" --profile $DEEPBOT_PROFILE --no-open"
  return 0
fi

step "services"
export DEEPBOT_REPO="$DEEPBOT_DIR" DEEPBOT_NODE="$(command -v node)"
service_install "gateway service" "$DEEPBOT_DIR/service/install-service.sh" show
service_install "health probe" "$DEEPBOT_DIR/service/install-health.sh"
service_install "watch runner" "$DEEPBOT_DIR/watch/install-watch.sh"
service_install "recall index job" "$DEEPBOT_DIR/recall/install-refresh.sh"
services_done || return 1

step "done"
node "$DSH_HOME/service/health-check.mjs" --status 2>/dev/null | sed 's/^/    /' || true
cat <<NEXT

    Next: invite the bot to a channel and mention it, or talk to it here: ${bold}dsh${off}
    Your agent's persona is ${bold}$DEEPBOT_HOME/SOUL.md${off} — edit it, it is yours.
    Another messenger, or a new token, later: ${bold}dsh gateway setup <slack|telegram|discord>${off}
    Update later by running the same curl line again.
NEXT
# A direct message always reaches a Telegram or Discord bot, so with no allowedUsers anyone who finds it may use it.
case "$platform" in telegram|discord) note "anyone who finds the bot on $platform can message it; to limit who: dsh gateway setup $platform --users <your id>" ;; esac
}

# The last line, so a download cut short defines functions and runs nothing.
[ "${DEEPBOT_INSTALL_SOURCED:-0}" = 1 ] || main "$@"
