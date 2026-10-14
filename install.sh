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
# A profile written by this installer lists the terminal beside it: platform: ['slack', 'local'].
profile_platform() {
  local found
  found="$(sed -n -E "s/^    platform: \[?'?(slack|telegram|discord)'?(, 'local'\])?$/\1/p" "$1" 2>/dev/null | head -1 || true)"
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

# ── The model provider ──────────────────────────────────────────────────────
# DeepSeek's own API is dsh-base's default route and needs no rows. OpenGateway and any other
# OpenAI-compatible endpoint go through llm-pi-ai, whose route has to be written out in full: a
# profile row's `config` replaces the bundle's, and the image input is read from `input` only.

# A custom endpoint's answers go into the profile's YAML: nothing that could leave a quoted value, or
# start a new key, gets through.
valid_endpoint() {   # valid_endpoint <baseURL> <model> <keyRef> <contextWindow>
  local url_re='^https://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$' model_re='^[A-Za-z0-9._:/@+-]+$' ref_re='^[A-Z][A-Z0-9_]*_KEY$'
  # Plain http only to this machine: anywhere else the key would cross the network in clear text.
  local here_re='^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]*)?$'
  { [[ $1 =~ $url_re ]] || [[ $1 =~ $here_re ]]; } && [[ $2 =~ $model_re ]] && [[ $3 =~ $ref_re ]] && [[ $4 =~ ^[0-9]+$ ]] && [ "$((10#$4))" -gt 0 ] || return 1
  # A key of its own: one the deployment reads for something else would be sent to this endpoint.
  case "$3" in DEEPSEEK_API_KEY|OG_API_KEY|SLACK_*|TELEGRAM_*|DISCORD_*) return 1 ;; esac
}

route_rows() {   # route_rows <id> <displayName> <keyRef> <baseURL> <model> <window> <images yes|no> [deepseek]
  local input='[text]'; [ "$7" = yes ] && input='[text, image]'
  printf '\n# ── Model route (written by install.sh) ─────────────────────────────────────\n'
  printf -- "- id: llm-pi-ai\n  config:\n    providers:\n      %s:\n        displayName: %s\n        apiKeyEnv: %s\n        api: openai-completions\n        baseURL: '%s'\n" "$1" "$2" "$3" "$4"
  # A DeepSeek model behind the endpoint: its thinking comes in DeepSeek's format, with these efforts.
  [ "${8:-}" = deepseek ] && printf '        compat:\n          thinkingFormat: deepseek\n'
  printf "        models:\n          - id: '%s'\n            name: '%s'\n            contextWindow: %s\n            input: %s\n" "$5" "$5" "$((10#$6))" "$input"
  [ "${8:-}" = deepseek ] && printf '            reasoningEfforts:\n              off:\n              low: low\n              medium: medium\n              high: high\n'
  printf "\n- id: agent-default-model\n  config:\n    provider: %s\n    model: '%s'\n" "$1" "$5"
  [ "${8:-}" = deepseek ] && printf '    reasoningEffort: medium\n'
  return 0
}

provider_rows() {   # provider_rows deepseek | opengateway | custom <keyRef> <baseURL> <model> <window> <images>
  case "$1" in
    deepseek) return 0 ;;
    opengateway) route_rows og OpenGateway OG_API_KEY https://apis.opengateway.ai/v1 deepseek/deepseek-v4.1-flash-ultrafast 1000000 yes deepseek ;;
    custom) route_rows custom 'Custom endpoint' "$2" "$3" "$4" "$5" "$6" ;;
    *) return 1 ;;
  esac
}

# ── Credentials ─────────────────────────────────────────────────────────────
# The harness resolves a key from the launch environment, then its own store (~/.dsh/.credentials.yaml,
# where the DeepSeek Harness app saves keys, under `refs`), then <cwd>/.env, then ~/.dsh/.env. A key a
# harness user already has is theirs: it is used where it is, never asked for again, and the app's store
# is never written. (<cwd> is the agent home for the gateway, whose launcher sets any .env there aside.)

key_source() {   # key_source <NAME>: env, store or dotenv — where it is set — or nothing. Names only.
  local name="$1" home="${DSH_HOME:-$HOME/.dsh}"
  if [ -n "${!name:-}" ]; then echo env; return 0; fi
  if [ -f "$home/.credentials.yaml" ] && awk -v k="$name" '
      /^refs:[[:space:]]*$/ { inrefs = 1; next }
      /^[^[:space:]#]/      { inrefs = 0 }
      inrefs && $0 ~ ("^[[:space:]]+" k ":") { found = 1 }
      END { exit !found }' "$home/.credentials.yaml" 2>/dev/null; then echo store; return 0; fi
  if grep -q "^$name=" "$home/.env" 2>/dev/null; then echo dotenv; return 0; fi
  return 0
}

has_key() { [ -n "$(key_source "$1")" ]; }

put_key() {     # put_key <name> <question>: asked only when the harness cannot already resolve it
  local value='' home="${DSH_HOME:-$HOME/.dsh}"
  case "$(key_source "$1")" in
    store) note "$1 is in DeepSeek Harness's own store (~/.dsh/.credentials.yaml) — used as it is"; return 0 ;;
    dotenv) note "$1 already set"; return 0 ;;
    env)
      # The gateway runs under launchd, which does not see this shell: the value goes where it will.
      printf '%s=%s\n' "$1" "${!1}" >>"$home/.env"
      note "$1 taken from this shell's environment into $home/.env, for the gateway"; return 0 ;;
  esac
  ask_secret value "$2"
  if [ -n "$value" ]; then printf '%s=%s\n' "$1" "$value" >>"$home/.env"; note "$1 saved"; else note "$1 skipped — add it to $home/.env later"; fi
}

provider_key() {   # provider_key <provider> [keyRef]: the credential the provider's route reads
  case "$1" in opengateway) echo OG_API_KEY ;; custom) echo "$2" ;; *) echo DEEPSEEK_API_KEY ;; esac
}

# The credential an existing profile's default model reads, for a rerun: the provider agent-default-model
# names, then that route's apiKeyEnv under llm-pi-ai — whatever the comments, the indent or the other
# routes. DeepSeek's when the profile names no route of its own.
profile_key() {
  local found
  found="$(awk '
    function bare(s) { sub(/[[:space:]]*#.*$/, "", s); gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); gsub(/^["\047]|["\047]$/, "", s); return s }
    function indent(s) { match(s, /^[[:space:]]*/); return RLENGTH }
    FNR == NR {
      if ($0 ~ /^- id: /) dm = ($0 ~ /^- id: agent-default-model[[:space:]]*(#.*)?$/)
      else if (dm && $0 ~ /^[[:space:]]+provider:/) { v = $0; sub(/^[[:space:]]+provider:/, "", v); want = bare(v) }
      next
    }
    /^- id: / { pi = ($0 ~ /^- id: llm-pi-ai[[:space:]]*(#.*)?$/); prov = -1; route = ""; next }
    pi && /^[[:space:]]+providers:[[:space:]]*(#.*)?$/ { prov = indent($0); next }
    pi && prov >= 0 && indent($0) == prov + 2 && $0 ~ /^[[:space:]]+[A-Za-z0-9_.-]+:[[:space:]]*(#.*)?$/ { route = bare($0); sub(/:$/, "", route); next }
    pi && route != "" && route == want && $0 ~ /^[[:space:]]+apiKeyEnv:/ { v = $0; sub(/^[[:space:]]+apiKeyEnv:/, "", v); print bare(v); exit }
  ' "$1" "$1" 2>/dev/null || true)"
  printf '%s\n' "${found:-DEEPSEEK_API_KEY}"
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
  ask provider "model provider: deepseek (DeepSeek's own API, the default), or opengateway / custom?" deepseek
  case "$provider" in
    deepseek|opengateway) ;;
    custom)
      ask base_url "the endpoint's base URL (OpenAI-compatible, https://…/v1)?"
      ask model_id "the model id it serves?"
      ask key_ref "the name to keep its API key under?" CUSTOM_API_KEY
      ask window "the model's context window, in tokens?" 128000
      ask images "does the model read images (yes / no)?" no
      valid_endpoint "$base_url" "$model_id" "$key_ref" "$window" \
        || die "the endpoint, model id, key name or context window has a character a profile cannot hold"
      case "$images" in yes|no) ;; *) die "images: yes or no (got: $images)" ;; esac ;;
    *) die "unknown provider: $provider (deepseek, opengateway or custom)" ;;
  esac
  list="$(channel_list "$channels")" || die "channel ids are letters, digits, - and _ (got: $channels)"
fi
DEEPBOT_INSTALLER=1 DSH_BIN="$DSH_BIN" "$DEEPBOT_DIR/init.sh" --home "$DEEPBOT_HOME" --profile "$DEEPBOT_PROFILE" | sed 's/^/    /'

step "platform and credentials"
note "a key the harness already has (its store, ~/.dsh/.env, or this shell) is used as it is; a new one goes to $DSH_HOME/.env (mode 600)"
mkdir -p "$DSH_HOME"; touch "$DSH_HOME/.env"; chmod 600 "$DSH_HOME/.env"
case "$platform" in
  slack)    put_key SLACK_BOT_TOKEN "Slack bot token (xoxb-…):"; put_key SLACK_APP_TOKEN "Slack app-level token (xapp-…):" ;;
  telegram) put_key TELEGRAM_BOT_TOKEN "Telegram bot token:" ;;
  discord)  put_key DISCORD_BOT_TOKEN "Discord bot token:" ;;
esac
# The model's key: the provider chosen now, or the one an existing profile's route reads.
if [ "$new_profile" -eq 1 ]; then model_key="$(provider_key "$provider" "${key_ref:-}")"; else model_key="$(profile_key "$profile_dir/cordis.patch.yml")"; fi
case "$model_key" in
  DEEPSEEK_API_KEY) put_key DEEPSEEK_API_KEY "DeepSeek API key:" ;;
  OG_API_KEY) put_key OG_API_KEY "OpenGateway API key:" ;;
  *) put_key "$model_key" "API key for the model endpoint ($model_key):" ;;
esac
# web_search goes through DeepSeek's API whatever answers the chat (dsh-base's web-search-deepseek row).
if [ "$model_key" != DEEPSEEK_API_KEY ] && ! has_key DEEPSEEK_API_KEY; then
  if [ "$new_profile" -eq 1 ]; then put_key DEEPSEEK_API_KEY "DeepSeek API key, for web search (enter to skip):"
  else note "web search uses DeepSeek's API: add DEEPSEEK_API_KEY to $DSH_HOME/.env to turn it on"; fi
fi

if [ "$new_profile" -eq 1 ]; then
  patch="$profile_dir/cordis.patch.yml"
  list="$(with_terminal "$list")"
  sed -i '' -e "s/^    platform: slack$/    platform: ['$platform', 'local']/" -e "s/^    targetChannels: \['\*'\]$/    targetChannels: $list/" "$patch"
  set_profile_language "$patch" "$language"
  provider_rows "$provider" "${key_ref:-}" "${base_url:-}" "${model_id:-}" "${window:-}" "${images:-}" >>"$patch"
  note "profile: platform $platform and the terminal, channels $list, language $language, model provider $provider"
else
  note "profile $DEEPBOT_PROFILE already existed — its settings are kept"
  grep -q "^    platform: .*'local'" "$profile_dir/cordis.patch.yml" 2>/dev/null \
    || note "to use dsh, add 'local' to the deepbot row's platform (see docs/how-it-works.md, The terminal)"
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
    Update later by running the same curl line again.
NEXT
}

# The last line, so a download cut short defines functions and runs nothing.
[ "${DEEPBOT_INSTALL_SOURCED:-0}" = 1 ] || main "$@"
