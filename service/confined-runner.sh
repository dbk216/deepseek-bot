#!/bin/bash
# A sandbox runner that also confines READS.
#
# Why this exists: the harness sandbox fences writes only. On macOS its Seatbelt
# profile is allow-default with (deny file-write*), so an agent can read anything the
# user can — another instance's home, a retired bot's token file. Measured: unwrapped,
# the agent read a canary from a different agent's directory and answered with it.
#
# The obvious fix — wrapping the whole gateway in a read-denying profile — does not
# work: macOS refuses nested sandbox-exec (`sandbox_apply: Operation not permitted`),
# so the harness's own sandbox probe finds no usable backend, refuses to run bash at
# all, and the agent asks to escalate into a request with no answerer. Verified, then
# reverted. That is why this replaces the runner instead of wrapping the process.
#
# The contract, from dsh-sandbox-local's confine():
#
#   <runner argv...> <bwrapProfileArgs(policy)...> -- <command...>
#
# with the policy expressed as bwrap-shaped arguments. Only two shapes matter here,
# because danger-full-access never reaches the runner:
#
#   --ro-bind / / ... --die-with-parent                        => read-only
#   --ro-bind / / ... --die-with-parent --tmpfs /tmp --bind R R => workspace-write
#
# Usage:  confined-runner.sh [--print-profile] <profile args...> -- <command...>
set -uo pipefail

HOME_DIR="${DEEPBOT_HOME:-$HOME/dsh-agent}"

mode="read-only"
workspace_root=""
command=()
seen_separator=0
print_only=0
args=("$@")
if [ "${#args[@]}" -gt 0 ] && [ "${args[0]}" = "--print-profile" ]; then
  print_only=1
  args=("${args[@]:1}")
fi

i=0
while [ $i -lt ${#args[@]} ]; do
  arg="${args[$i]}"
  case "$arg" in
    --) seen_separator=1; i=$((i+1)); command=("${args[@]:$i}"); break ;;
    --bind) workspace_root="${args[$((i+2))]:-}"; mode="workspace-write"; i=$((i+3)) ;;
    --ro-bind|--dev|--tmpfs|--proc) i=$((i+2)) ;;
    --unshare-pid|--die-with-parent) i=$((i+1)) ;;
    *) i=$((i+1)) ;;
  esac
done

if [ "$seen_separator" -eq 0 ] && [ "$print_only" -eq 0 ]; then
  echo "confined-runner: no -- separator; refusing to guess what to run" >&2
  exit 64
fi

# The writable set mirrors the harness's own intent: the workspace, temp, and the
# null sink. Reads are allowed everywhere except other instances' data.
profile() {
  echo '(version 1)'
  echo '(allow default)'
  if [ "$mode" = "workspace-write" ]; then
    echo '(deny file-write*)'
    [ -n "$workspace_root" ] && printf '(allow file-write* (subpath %s))\n' "$(sbpl "$workspace_root")"
    printf '(allow file-write* (subpath "/tmp") (subpath "/private/tmp") (subpath "/var/folders"))\n'
    printf '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper"))\n'
    # Except the workspace's .env: the harness's credential chain reads <cwd>/.env before the
    # deployment's own, and the gateway runs in this workspace — a .env here would replace the tokens.
    if [ -n "$workspace_root" ]; then
      escaped="$(printf '%s' "$workspace_root" | sed 's/[][\.*^$+?(){}|]/\\&/g')"
      printf '(deny file-write* (regex #"^%s/\\.env(\\..*)?$"))\n' "$escaped"
    fi
  else
    echo '(deny file-write*)'
    printf '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper"))\n'
  fi
  # Reads: everything the harness already allows, minus other instances' data.
  # DEEPBOT_DENY_READ adds a deployment's own (colon-separated) — a retired bot's data, say.
  echo ";; read confinement: other agent homes, and DEEPBOT_DENY_READ"
  extra=()
  IFS=':' read -r -a extra <<< "${DEEPBOT_DENY_READ:-}"
  for candidate in "$HOME"/dsh-agent* ${extra[@]+"${extra[@]}"}; do
    [ -n "$candidate" ] && [ -e "$candidate" ] || continue
    [ "$candidate" = "$workspace_root" ] && continue
    printf '(deny file-read* (subpath %s))\n' "$(sbpl "$candidate")"
  done
  # Reads: the deployment's credentials. No command needs them, and a command's output reaches
  # Slack — as a reply or a watch alert — where nothing redacts a token. Measured before this: a
  # `cat ~/.dsh/.env` inside this runner printed the bot token.
  echo ";; read confinement: credentials"
  for dir in "$HOME/.dsh" ${DSH_HOME:+"$DSH_HOME"}; do
    for candidate in "$dir"/.env "$dir"/.credentials.yaml*; do
      [ -e "$candidate" ] || continue
      printf '(deny file-read* (literal %s))\n' "$(sbpl "$candidate")"
      # Seatbelt matches the resolved path: under a symlinked directory (/var → /private/var) the
      # rule above alone denied nothing, which the runner test caught.
      # An `if`, not `[ … ] && printf`: as the loop's last command a false test made profile() fail,
      # and the runner refused every command with exit 70 — on a home without symlinks, i.e. live.
      resolved="$(cd "$(dirname "$candidate")" && pwd -P)/$(basename "$candidate")"
      if [ "$resolved" != "$candidate" ]; then
        printf '(deny file-read* (literal %s))\n' "$(sbpl "$resolved")"
      fi
    done
  done
  # The gateway's logs: their first lines carry the web UI's auth token, and that opens the
  # harness's HTTP API — outside this sandbox — to whoever reads it. install-service.sh writes them
  # here, outside the agent's home, where they used to be readable and writable by the agent.
  # The session store: every profile's conversations, this agent's and everybody else's. The agent
  # reads its own past through the recall index in its home, never through these files.
  # The recall index too: every channel's history, which the adapter hands out one channel at a time.
  for denied in "$HOME/.dsh/service/logs" "$HOME/.dsh/sessions" "$HOME/.dsh/recall"; do
    [ -d "$denied" ] || continue
    printf '(deny file-read* (subpath %s))\n' "$(sbpl "$denied")"
    resolved="$(cd "$denied" && pwd -P)"
    if [ "$resolved" != "$denied" ]; then
      printf '(deny file-read* (subpath %s))\n' "$(sbpl "$resolved")"
    fi
  done
  # Unix sockets: no agent of the user's — ssh-agent (measured: `ssh-add -l` inside this runner listed
  # the keys), 1Password's, gpg-agent's, docker's. Name resolution goes through mDNSResponder's socket,
  # without which nothing resolves a host, and a workspace may run a local server it talks to.
  echo '(deny network-outbound (remote unix-socket))'
  echo '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))'
  if [ -n "$workspace_root" ]; then
    printf '(allow network-outbound (remote unix-socket (subpath %s)))\n' "$(sbpl "$workspace_root")"
  fi
}

sbpl() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

if [ "$print_only" -eq 1 ]; then
  profile
  exit 0
fi

if [ ! -x /usr/bin/sandbox-exec ]; then
  echo "confined-runner: sandbox-exec is unavailable; refusing to run unconfined" >&2
  exit 70
fi

# The profile goes inline. It used to be a file in TMPDIR — which confined commands may write —
# read back by path, so one running command could rewrite the profile another invocation was
# about to apply. Inline there is nothing to rewrite, and no temp-name collisions to get wrong.
sb_profile="$(profile)" || exit 70
exec /usr/bin/sandbox-exec -p "$sb_profile" "${command[@]}"
