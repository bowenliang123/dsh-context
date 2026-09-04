# Compatibility

dsh-context declares per-release compatibility with `@deepseek-ai/dsh` in its package manifest (`dsh.compatibility.dshReleases`). This page records what is actually verified for each declared release, and how.

Last verified: **2026-09-04** (plugin `dsh-context@0.41.3` source tree).

## Supported dsh releases

| dsh release | npm channel | Declared | Automated seam matrix | Disposable-profile install / uninstall |
| --- | --- | --- | --- | --- |
| `0.1.2-rc.1` | `next` | compatible | ✅ baseline `v0.1.2-rc.1` | ✅ install OK → 1 composed row → uninstall OK → 0 rows |

Releases older than `0.1.2-rc.1` — the `0.1.1` line and the `0.1.2-alpha.*` previews — were supported and verified through `dsh-context@0.41.x` and are no longer in the support matrix.

## What each check means

- **Automated seam matrix** — part of this repository's `pnpm test` (the `compat` vitest project). For every baseline tag it stages the harness's REAL sources at that tag, boots the plugin's built host entry into that tag's actual `SessionProjectionRegistry` on the cordis release the line vendors, and probes the tag's client seams (slots, finalized-nodes seat, image loader, history face/envelope, markdown chrome, platform module table, durable-event vocabulary, settings namespace). Definitions live in `tests/baselines.ts`; the release workflow fetches the pinned baseline tags before testing.
- **Disposable-profile install / uninstall** — for each release, that exact `dsh` CLI version was installed from npm into a temporary `DSH_HOME` (the real `~/.dsh` is never touched), then:
  1. `dsh plugin --profile <disposable> add dsh-context` — install OK;
  2. `dsh --profile <disposable> --dump-config` — the bundle's `- id: dsh-context` row composes into the effective configuration (exactly 1 row);
  3. `dsh plugin --profile <disposable> remove dsh-context` — uninstall OK, dump-config back to 0 rows.

## Scope

These checks prove source-level seam compatibility and disposable-profile install/start-composition/uninstall per release. They are not a claim of full web-app runtime acceptance on a real Profile — visible UI behavior depends on the harness generation and the browser half, which the seam matrix approximates from the tag's sources.
