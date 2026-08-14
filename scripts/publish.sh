#!/usr/bin/env bash
# Publishes dsh-context to the npm registry as the authenticated user.
#
# Usage:
#   NPM_TOKEN=<your npmjs access token> ./scripts/publish.sh        # bump patch if needed
#   NPM_TOKEN=<token> ./scripts/publish.sh minor                    # force a minor bump
#   NPM_OTP=<6-digit code> NPM_TOKEN=<token> ./scripts/publish.sh   # 2FA accounts (non-automation tokens)
#
# The token is read from the environment only — it is never written to a
# file. If your token starts with "npm_", it is an npmjs access token and
# can be passed directly; keep it out of shell history by exporting it.
# Accounts with 2FA "auth and writes" must pass NPM_OTP (or use an
# Automation token, which bypasses the one-time password).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUMP="${1:-patch}"
: "${NPM_TOKEN:?NPM_TOKEN is not set — run with NPM_TOKEN=<token> ./scripts/publish.sh}"

# Keep npm's cache/logs inside the repo when the default location (~/.npm)
# is not writable (sandboxed builds, CI with a read-only home).
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$ROOT/.npm-cache}"
mkdir -p "$NPM_CONFIG_CACHE"

echo "==> building lib/ artifacts"
node scripts/build.mjs

NAME="$(node -p "require('./package.json').name")"
CURRENT="$(node -p "require('./package.json').version")"

# Auto-bump only when the current version is already published, so a plain
# re-run of this script after a successful publish is a no-op (same version
# is not re-published).
PUBLISHED="$(npm view "$NAME" version 2>/dev/null || true)"
if [[ "$CURRENT" == "$PUBLISHED" ]]; then
  echo "==> version $CURRENT already on the registry — bumping ($BUMP)"
  npm version "$BUMP" --no-git-tag-version >/dev/null
  CURRENT="$(node -p "require('./package.json').version")"
fi

echo "==> publishing $NAME@$CURRENT"
PUBLISH_ARGS=(--access public --registry https://registry.npmjs.org \
  --//registry.npmjs.org/:_authToken="$NPM_TOKEN")
if [[ -n "${NPM_OTP:-}" ]]; then PUBLISH_ARGS+=(--otp "$NPM_OTP"); fi
npm publish "${PUBLISH_ARGS[@]}"

echo "==> verifying"
LIVE="$(npm view "$NAME" version --registry https://registry.npmjs.org)"
echo "✔ $NAME@$LIVE is live at https://www.npmjs.com/package/$NAME"
if [[ "$LIVE" != "$CURRENT" ]]; then
  echo "⚠  registry reports $LIVE (expected $CURRENT) — check the publish log above" >&2
  exit 1
fi
