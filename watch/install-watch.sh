#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Install the watch runner as a launchd job (evaluates due watches every minute).
#
#   ./install-watch.sh                    install
#   ./install-watch.sh --status | --uninstall
#   INTERVAL_S=120 ./install-watch.sh
#
# Watches come from two places, merged by id:
#   ~/.dsh/watches.json            the operator's own file
#   <agent home>/watches/*.json    watches the agent created with its file tools
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
DIR="$(pwd)"
LABEL="ai.deepbot.watch"
UID_N="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# A setting not given keeps the value the installed job already has: install.sh updates by running this
# again with none of them, and an unset one used to be written empty — dropping the deny list and the
# alert target without a word. Set one to an empty value to clear it.
kept() { [ -f "$PLIST" ] || return 0; /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PLIST" 2>/dev/null || true; }
DEEPBOT_DENY_READ="${DEEPBOT_DENY_READ-$(kept DEEPBOT_DENY_READ)}"
INTERVAL_S="${INTERVAL_S:-60}"
NODE="${DEEPBOT_NODE:-$(command -v node || echo /usr/local/bin/node)}"
RUNTIME_DIR="${DEEPBOT_RUNTIME_DIR:-$HOME/.dsh/service}"
AGENT_HOME="${DEEPBOT_HOME:-$(kept DEEPBOT_HOME)}"; AGENT_HOME="${AGENT_HOME:-$HOME/dsh-agent}"

# The runner is compiled from watch.ts. Its copy keeps the name the plist runs, and .mjs keeps it an ES
# module outside the package. Without a build it refuses, before writing anything: copying nothing, or
# a stale runner, is worse than stopping.
copy_runtime() {
  [ -f "$DIR/../dist/watch/watch.js" ] || { echo "❌ dist/watch/watch.js not found — build first: pnpm run build"; return 1; }
  [ "$DIR/watch.ts" -nt "$DIR/../dist/watch/watch.js" ] && { echo "❌ dist/watch/watch.js is older than watch.ts — build first: pnpm run build"; return 1; }
  mkdir -p "$RUNTIME_DIR" "$AGENT_HOME/watches" "$HOME/.dsh"
  cp "$DIR/../dist/watch/watch.js" "$RUNTIME_DIR/watch.mjs"; chmod +x "$RUNTIME_DIR/watch.mjs"
  echo "✅ runtime copy: $RUNTIME_DIR/watch.mjs"
  # Watches the agent wrote run inside this runner, read-only; without it they do not run at all.
  cp "$DIR/../service/confined-runner.sh" "$RUNTIME_DIR/confined-runner.sh"; chmod +x "$RUNTIME_DIR/confined-runner.sh"
  echo "✅ runtime copy: $RUNTIME_DIR/confined-runner.sh"
}

# Sourced with DEEPBOT_INSTALL_SOURCED=1 (test/install.test.ts), it defines the above and stops here.
if [ "${DEEPBOT_INSTALL_SOURCED:-0}" = 1 ]; then return 0; fi

case "${1:-}" in
--status)
  echo "── watch job: $LABEL"
  launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1 \
    && launchctl print "gui/$UID_N/$LABEL" | grep -E "^\s+(state|runs|last exit code) " | sed 's/^/   /' \
    || echo "   not registered"
  echo "── watches"
  [ -f "$HOME/.dsh/watches.json" ] && echo "   host:  $HOME/.dsh/watches.json" || echo "   host:  (none)"
  ls "$AGENT_HOME/watches"/*.json 2>/dev/null | sed 's/^/   agent: /' || echo "   agent: (none)"
  exit 0 ;;
--uninstall)
  launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null && echo "   stopped" || echo "   (not running)"
  [ -f "$PLIST" ] && rm -f "$PLIST" && echo "   removed $PLIST"
  exit 0 ;;
esac

echo "=== installing the deepbot watch runner ==="
[ -x "$NODE" ] || { echo "❌ node not found: $NODE"; exit 1; }
copy_runtime || exit 1

# A fresh account may have no LaunchAgents directory yet.
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$RUNTIME_DIR/watch.mjs</string></array>
  <key>WorkingDirectory</key><string>$RUNTIME_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>DEEPBOT_HOME</key><string>$AGENT_HOME</string>${DEEPBOT_DENY_READ:+
    <key>DEEPBOT_DENY_READ</key><string>$DEEPBOT_DENY_READ</string>}
  </dict>
  <key>StartInterval</key><integer>$INTERVAL_S</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$HOME/.dsh/slack-state/watch.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/.dsh/slack-state/watch.err.log</string>
</dict>
</plist>
PLIST_EOF
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null 2>&1 || { echo "❌ plist failed plutil -lint"; exit 1; }
if launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null; sleep 1; fi
launchctl bootstrap "gui/$UID_N" "$PLIST" 2>&1 | sed 's/^/   /'
sleep 1
echo "── dry run"
DEEPBOT_HOME="$AGENT_HOME" "$NODE" "$RUNTIME_DIR/watch.mjs" --dry-run | sed 's/^/   /'
echo
echo "evaluates every ${INTERVAL_S}s.  status: ./install-watch.sh --status"
