#!/usr/bin/env bash
# Restarts the dsh web server: kills the running `dsh web` first, then starts a fresh one.
set -euo pipefail

pids="$(pgrep -f "dsh web" 2>/dev/null || true)"
if [[ -n "$pids" ]]; then
  echo "killing existing dsh web (pid: $(echo "$pids" | tr '\n' ' '))"
  echo "$pids" | xargs kill 2>/dev/null || true
  for _ in {1..50}; do
    pgrep -f "dsh web" >/dev/null 2>&1 || break
    sleep 0.1
  done
fi

exec dsh web --no-open
