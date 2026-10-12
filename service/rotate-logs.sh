#!/bin/bash
# Rotate the gateway's logs, in place.
#
# The launchd captures (`watch.out.log` at 598 KB and `health-probe.out.log` at 85 KB when
# this was written) and the plugin's own log have no cap, and nothing rotates them: an
# agent that runs for months would fill the disk one line at a time.
#
# Truncation rather than rename, deliberately: launchd holds an open descriptor on its stdout
# capture, and renaming the file leaves it writing to a file nothing can find. Compressing a
# copy and emptying the original keeps the descriptor valid.
#
# Usage: rotate-logs.sh [--dir <dir>] [--max-bytes <n>] [--keep <n>] [--dry-run]
set -uo pipefail

DIR="${HOME}/.dsh/slack-state"
MAX=$((5 * 1024 * 1024))
KEEP=2
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --max-bytes) MAX="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "rotate-logs: unknown argument $1" >&2; exit 64 ;;
  esac
done

[ -d "$DIR" ] || { echo "rotate-logs: no such directory: $DIR" >&2; exit 1; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
rotated=0
for file in "$DIR"/*.log; do
  [ -e "$file" ] || continue
  size=$(wc -c < "$file" | tr -d ' ')
  if [ "$size" -le "$MAX" ]; then continue; fi
  target="${file}.${stamp}.gz"
  if [ "$DRY" = 1 ]; then
    echo "  would rotate $(basename "$file") ($(( size / 1024 )) KB → $(basename "$target"))"
    rotated=$((rotated + 1))
    continue
  fi
  gzip -c "$file" > "$target" || { echo "  failed to compress $file" >&2; continue; }
  : > "$file"                       # truncate: the writer's descriptor stays valid
  echo "  rotated $(basename "$file") ($(( size / 1024 )) KB → $(basename "$target"))"
  rotated=$((rotated + 1))
done

# Keep the newest $KEEP compressed copies of each log.
for base in "$DIR"/*.log; do
  [ -e "$base" ] || continue
  old=$(ls -1t "$base".*.gz 2>/dev/null | tail -n +$((KEEP + 1)))
  for file in $old; do
    [ "$DRY" = 1 ] && { echo "  would delete $(basename "$file")"; continue; }
    rm -f "$file" && echo "  deleted old $(basename "$file")"
  done
done

echo "  rotate-logs: ${rotated} file(s) over $(( MAX / 1024 / 1024 )) MB in ${DIR}"
