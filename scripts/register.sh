#!/usr/bin/env bash
# Registers dsh-context as the dsh web profile plugin (local development).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Removal may fail when the plugin is not installed yet — that is fine.
dsh plugin --profile web remove dsh-context || true
dsh plugin --profile web add .
