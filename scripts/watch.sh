#!/usr/bin/env bash
# Starts tsdown --watch, killing the previous watch instance (pid tracked in .tmp/watch.pid) first.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PID_FILE="$ROOT/.tmp/watch.pid"
mkdir -p "$ROOT/.tmp"

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "killing previous watch (pid $old_pid)"
    kill "$old_pid" 2>/dev/null || true
    for _ in {1..50}; do
      kill -0 "$old_pid" 2>/dev/null || break
      sleep 0.1
    done
  fi
  rm -f "$PID_FILE"
fi

tsdown --watch &
child=$!
echo "$child" > "$PID_FILE"

cleanup() {
  kill "$child" 2>/dev/null || true
  if [[ "$(cat "$PID_FILE" 2>/dev/null)" == "$child" ]]; then
    rm -f "$PID_FILE"
  fi
}
trap cleanup EXIT INT TERM

wait "$child"
