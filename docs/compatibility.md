# Compatibility

dsh-context declares per-release compatibility with `@deepseek-ai/dsh` in its package manifest (`dsh.compatibility.dshReleases`). This page records what is actually verified for each declared release, and how.

Last verified: **2026-09-10** (plugin `dsh-context@0.48.0` source tree).

## Supported dsh releases

| dsh release | Session log | Declared | Automated seam matrix | Disposable-profile install / uninstall |
| --- | --- | --- | --- | --- |
| `0.1.2-rc.1` | V0 | compatible | ✅ baseline `v0.1.2-rc.1` | ✅ install OK → 1 composed row → uninstall OK → 0 rows (verified 2026-09-05) |
| `0.1.3-alpha.2` | V2 | compatible | ✅ baseline `v0.1.3-alpha.2` | ✅ install OK → 1 composed row → uninstall OK → 0 rows (verified 2026-09-09) |
| `0.1.5-rc.1` | V3 | compatible | ✅ baseline `v0.1.5-rc.1` | ✅ install OK → 1 composed row → uninstall OK → 0 rows (verified 2026-09-10) |

The automated seam matrix runs for every row on every `pnpm test`. The disposable-profile column is a manual, per-release check: each release's CLI was installed from npm into a temporary `DSH_HOME` (the real `~/.dsh` is never touched) — `0.1.2-rc.1` on 2026-09-05, `0.1.3-alpha.2` on 2026-09-09, and `0.1.5-rc.1` on 2026-09-10, against the official npm registry (a stale mirror can 404 the harness's own dependency closure before the plugin is even considered).

Releases older than `0.1.2-rc.1` — the `0.1.1` line and the `0.1.2-alpha.*` previews — were supported and verified through `dsh-context@0.41.x` and are no longer in the support matrix.

## Session-log generations

The supported range spans three durable-log generations, and the plugin folds all of them from one shape-driven code path (`src/host/logShapes.ts`):

| Seam | V0 (`0.1.2-rc.x`) | V2 (`0.1.3-alpha.x`) | V3 (`0.1.5-alpha.x+`) |
| --- | --- | --- | --- |
| System prompt | `request/header.header.system` | same as V0 | `system/message` surface node |
| First token | `assistant/chunk` events | embedded `data.stream` (also `assistant/attempt`) | same as V2 |
| Replacement endpoints | `{ start, end }` | same as V0 | `{ startSeq, endSeq }` |
| Nested PTC dispatch | `tool/code-dispatch` | same as V0 | `tool/ptc-dispatch` |

The fold never branches on a detected harness version: a log carries exactly one generation, and the spellings are mutually exclusive. This matters because a deployment's version probe can be wrong — a healed profile mirror may name a different release than the running harness.

## Web client seams

The browser half rides generation-specific seats, each reached through an optional seam so an older line simply goes without the capability. The V3 line moved two of them, and the newest release moved one back:

| Seam | V3 before `0.1.5-alpha.2` | `0.1.5-alpha.2` | `0.1.5-rc.1+` |
| --- | --- | --- | --- |
| Conversation panel root | flat `conversation` slot | keyed `main` panel's `main.conversation` (the plugin's `conversation.view` seat is unchanged and hangs under it) | same as `0.1.5-alpha.2` |
| Right Sidebar guide entry | glyph + title + required description line | glyph + title (the description line was dropped) | glyph + title + optional description line (restored; the plugin contributes it) |

The plugin contributes to whichever face the running line serves: the guide capsule carries `order`, `title`, and `icon` on every generation and adds the `description` thunk, which `0.1.5-alpha.1` required, `0.1.5-alpha.2` ignored, and `0.1.5-rc.1+` renders. The `guideEntry` probe in `tests/baselines.ts` pins the fields of the newest supported generation.

## What each check means

- **Automated seam matrix** — part of this repository's `pnpm test` (the `compat` vitest project). For every baseline tag it stages the harness's REAL sources at that tag, boots the plugin's built host entry into that tag's actual `SessionProjectionRegistry` on the cordis release the line vendors, and probes the tag's client seams (slots, finalized-nodes seat, image loader, history face/envelope, markdown chrome, platform module table, that generation's durable-event vocabulary, the right Sidebar tab seam and its guide-entry contract where the line ships one, settings namespace). Definitions live in `tests/baselines.ts`; the release workflow fetches the pinned baseline tags before testing. Optional seams are asserted BOTH ways: the right Sidebar tab registers only on the generation that serves it, and every older line is proven to have no such service, so the plugin's deferred registration stays inert instead of pending.
- **Statistics against the harness's own folds** — the plugin's figures are differentially checked against the harness's OWN projection values (`sessionStats`, `contextBreakdown`, `contextPressure`, `tokenUsage`) over real V0 and V3 session logs: system/tools/message tokens, per-request counts, turns/steps, TTFT, generation, tool time, and every billed cost bucket match exactly, and a migrated V0→V3 log reproduces the same figures as its V0 original.
- **Disposable-profile install / uninstall** — for each release, that exact `dsh` CLI version was installed from npm into a temporary `DSH_HOME` (the real `~/.dsh` is never touched), then:
  1. `dsh plugin --profile <disposable> add dsh-context` — install OK;
  2. `dsh --profile <disposable> --dump-config` — the bundle's `- id: dsh-context` row composes into the effective configuration (exactly 1 row);
  3. `dsh plugin --profile <disposable> remove dsh-context` — uninstall OK, dump-config back to 0 rows.

## Scope

These checks prove source-level seam compatibility, statistical parity with the harness's own folds, and disposable-profile install/start-composition/uninstall per release. They are not a claim of full web-app runtime acceptance on a real Profile — visible UI behavior depends on the harness generation and the browser half, which the seam matrix approximates from the tag's sources.

## Upgrading from an older plugin build

The plugin keeps its projection `stateVersion` unchanged, so cached per-session projection rows stay usable: bumping it would invalidate every row and orphan the `contextTimeline` key for idle sessions, which have no refresh channel until they go live again.

One consequence: a session whose row was folded by an older build keeps serving that older figure set until its log receives a new event (the registry seeds the cached state and replays only the tail). New sessions are exact from their first event. To force a full refold of an existing session, delete its cached projection row — it is a derived cache and is rebuilt from the durable log:

```bash
rm ~/.dsh/storages/session_projcache/sessions/<session-id>.json
```
