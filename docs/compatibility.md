# Compatibility

The rules dsh-context must hold on every supported `@deepseek-ai/dsh` release, and the evidence for each. Supported releases are declared in `package.json` (`dsh.compatibility.dshReleases`); baselines and their per-line seam faces are pinned in `tests/baselines.ts`.

**Grammar.** Entries are numbered **rules** (the bold lead is the invariant), plus **Limitation** (an accepted gap), **Check** (how a claim is proven), and **Procedure** (how to run a compatibility task). Evidence rides in trailing parens — paths in this repo, or `dsh:` paths in the harness tree read at the baseline tag — or as a table directly beneath the rule it maps. A rationale appears only where code cannot show it.

**Law.** Record only what no other artifact carries; delete what code, tests, or git history already say. Verify against the dsh sources before acting — source wins over this page. Less is ALWAYS better.

Last verified: **2026-10-22** (dsh-context `0.74.0`, dsh `0.2.0-rc.2` / `0.2.1-rc.2` tag trees).

## 1 · Supported set

*What the plugin declares it works on.*

1. **Support exactly `0.2.0-rc.2` and `0.2.1-rc.2`** — the `0.2.0` line from rc.2 and the `0.2.1` line from rc.2, both the V4 durable-log generation (declared in `dsh.compatibility.dshReleases`, baselined in `tests/baselines.ts`). The runtime-gate floor is the single `0.2.0-rc.2` release, and its published npm dependency closure is verified complete (a fresh `npm install @deepseek-ai/dsh@0.2.0-rc.2` in a disposable project exits 0 with the full `@deepseek-ai/*` closure). The `0.1.7` line is dropped; its users must move to a supported release. Releases older than the floor are refused by the harness gate where it runs (§2), or get §2's fallback composition with an upgrade prompt where it does not — never a fold.

- **Limitation — preview admission:** the single floor admits semantically newer releases the matrix never stages (a supported line's pre-rc.2 previews, or a later line); by design they get the real folds forward-compatibly, while the exact `dsh.compatibility.dshReleases` records — not the range — carry the store's install evidence.

## 2 · Admission

*Whether the plugin loads at all.*

**Harness-side**

1. **The harness refuses an unmet manifest before install and before profile import** — the gate landed in the `0.1.7` line at tag `dsh-v0.1.7-rc.1`; no earlier build has one. Which declaration it reads is line-specific: from `0.2.1-alpha.4` (announced by the `v0.2.1-alpha.3` upgrade guide for the next release) a declared `engines.dsh` decides alone and peers are ignored; the `0.2.0` line, the gated `0.1.7` builds, and `0.2.1` before alpha.4 read only the `@deepseek-ai/dsh*` peers (semver, `includePrerelease: true`). Both declarations must stay: each is the sole gate on one supported line, so together they admit every supported release and refuse the `0.1.7` line wherever the gate runs — no exact-version exemption is needed. (dsh: `packages/boot/app-boot/src/plugin-compatibility.ts`, `packages/boot/app-boot/src/compatibility-preflight.ts`, `packages/boot/plugin-manager/src/operations.ts`, `apps/cli/src/plugin.ts`)

**Plugin-side**

2. **Enforce the floor again at runtime** — the fallback stays as defense for loads the harness gate cannot stop: a build that predates the gate has none, and an exact-version exemption force-loads a gated harness below the floor. Below `0.2.0-rc.2`: zeroed fallback units plus an upgrade modal. Version undetectable: FAIL OPEN into the real units — a probe misfire must never blank a working deployment, and the home mirror (last-booted profile) never outranks the running module tree. (`src/host/version.ts`, `src/host/fallback.ts`, `src/shared/version.ts`)
3. **Feature-detect `.volatile()` at schema build time**, so the same bundle loads — preferences inert — on a below-floor harness whose schemastery predates it. (`src/host/config.ts`)

## 3 · Fold

*Durable events → projection state, host-side.*

**Shapes**

1. **One shape-driven path; never branch on a detected harness version.** (`src/host/fold.ts`, `src/host/logShapes.ts`)
2. **Trust the migration guarantee; carry no legacy readers.** Every read path the plugin rides (live open, persistence handles, `sessionQuery.observeSession`) migrates pre-V4 logs to V4; an unconvertible log is refused with `SessionFormatUnsupportedError`, never served raw. Pre-V4 spellings exist nowhere in this repo. (dsh: `packages/session/session-format-v3-to-v4`, `packages/session/session-format-catalog`, `packages/session/session-persistence/src/errors.ts`, `packages/session-query/session-query/src/documents.ts`)
3. **`developer/message` folds into injected context** — request composition, live surface, archives; never human inputs; an empty-content event keeps its surface node at zero tokens where the harness's `deriveEventMessage` projects null. (`src/host/fold.ts`)
4. **Read tool-result errors from `message.isError` alone** — the generation admits event-level `data.error` only alongside it; a hostile envelope-only row degrades to unflagged, never a throw. (`src/host/fold.ts`)

**Totality**

5. **Folds are TOTAL** — unknown event types return state unchanged; a malformed event drops whole (no partial state); no `undefined`-valued property is ever materialized into persisted state. The projection registry drives `apply` with no error boundary: one throw stalls the unit's cells and push feed forever, and one `undefined` property fails EVERY projection-cache write for the session.

- **Limitation — image offload (deferred):** on `IMAGE_OFFLOAD_REQUIRED` the harness offloads images via a message projection; the fold reads raw durable events, so an offloaded message keeps its pre-offload image count and price until compaction removes it. Revisit only if it shows in practice.

## 4 · Metering parity

*Figures the plugin prints that the harness also prints.*

1. **Mirror, don't import.** Re-fit when a supported line moves an implementation; verify differentially against the harness's own projections (§8). Right-hand paths are `dsh:` tree paths.

| Plugin site | dsh source mirrored |
| --- | --- |
| `src/shared/estimate.ts` | `packages/llm/token-meter/src/estimate.ts` — `estimateSystemMessage` and its per-block text arm |
| `src/shared/fileTokens.ts` | `packages/llm/llm/src/content.ts` `fileHandleText` — a `file` block costs its request handle text, never its bytes (priced via `packages/llm/token-meter/src/route-pricing.ts`); price the pathless arm |
| TPS chip first-token anchor | `packages/llm/llm/src/assistant-stream.ts` `assistantStreamFirstTokenTime` |
| `src/client/headline.ts` `occupancyPercent` | `packages/client/ui-conversation/src/client/context-occupancy.ts` — internal to the kernel bundle, no package export, hence mirrored |
| `src/client/reserve.ts` | `packages/compaction/compaction-basic/src/config.ts` — only the shipped defaults (`thresholdRatio` 0.8, `headroomTokens` 65536): preset realms make a deployment's policy unreadable; when `contextWindow − reservedOutput − headroomTokens` is non-positive the backend refuses (`TargetPressureConfigError`), so the bar paints no masks |

- **Limitation — declared divergence:** the timing card's wait/generation boundary opens at the first OBSERVABLE instant (the first token, or an earlier `block-start` marker the token packing could not stamp), not at the meter's first-token anchor — so marker-tiled decode buckets and the split never double-count one window.
- **Limitation — daily-ledger attribution:** `contextTimeline.cost` prices at the settlement instant while the daily ledger prices at the step-initiation instant, so a tariff-boundary step can split its peak/off buckets differently between the lifetime total and the KPI band; the ledger also retains 400 days (`MAX_KEPT_DAYS` in `src/host/activity.ts`).
- **Limitation — statutory holidays:** no holiday calendar is maintained (by decision), so a holiday-weekday request inside the peak windows prices at peak where the platform bills off-peak; the tooltip states the weekday/weekend rule. (`src/host/foldMetering.ts` `isBeijingPeak`)

## 5 · Client surface

*What the browser half may rely on.*

**Seams**

1. **Every capability rides an OPTIONAL seam** — deferred `ctx.inject` (never a hard `inject`), the face re-proved before use, the registration guarded, the module declared in `dsh.client.inject` where the capability must be live at mount; a one-shot command read is `ctx.get` per call and adds neither a fiber nor a boot-order edge (rules 3 and 5). No service → no capability: no pending fiber, no throw. Per-line faces are pinned in `tests/baselines.ts` and probed by §8's matrix.
2. **Mount at most once per page** (issue #137) — the client-plugin runner force-assigns a fresh shadowing priority to every registration, so the slot registry's same-priority duplicate guard never fires across a double mount. Read the raw ledger; mount nothing when `context-jump` is already seated; the read fails open. (dsh: `packages/client/ui-renderer/src/client/registry.ts` `SlotRegistry.entries`; probe `ledger`)
3. **Session jump uses the sidebar's own verb**, `uiWorkspace.openSession(SessionTarget)` — never the sessions service's `open(id)`, removed by the `0.1.6` selection refactor (issue #90). (dsh: `packages/client/ui-workspace/src/client/navigation.ts`; probe `sessionNav`)
4. **The member card's open prefers the right Sidebar's subagent chat**, addressed by the row's own direct parent — a face that is absent or leaves the address unclaimed keeps rule 3's whole-view jump. (dsh: `packages/client/ui-subagent/src/client/sidebar-chat/index.tsx`, `packages/client/ui-sidebar-right/src/client/service.ts`)
5. **The settings jump uses the Plugins panel's own navigator**, `pluginNavigation.openBundle(packageName)` — never a DOM walk over its chrome: `0.2.1`'s contributed `plugins.tab` slot remembers its selection, so the card the walk seeks is absent while another tab is open, and the navigator resets that tab to Installed (the `0.2.0` line ships no contributed tabs). (dsh: `packages/client/ui-plugin-manager/src/client/index.ts`; probe `pluginsNav`)

**Boundary**

6. **Re-prove everything at the boundary** — collections re-proven, scalars zeroed, whole-value absence stays `null` (the loading screen); structural narrowing over blind casts; skip elements that fail the shape instead of throwing. (`src/client/timelineSource.ts`)
7. **Isolate per-item work over hostile objects**; every async read resolves to data or a retryable failure note — never an eternal spinner. (`src/client/timelineSource.ts`)
8. **A pushed revision decrease resets the detail ledger** — stale reads never merge into the new head. (`src/client/timelineSource.ts`)
9. **Fetch routes ride browser-relative spellings** (issue #159) — the client never issues a root-absolute `/api/...` URL: fetch resolves the relative form against the page's document base, so a deployment behind a path-prefixed reverse proxy (page at `/app/dsh/`) keeps its prefix, where a root-absolute spelling 404s at the gateway. (`src/client/apiRoutes.ts`)
10. **Only a `'subagent'`-origin row draws a family edge** — a list row's `parentId` is subagent lineage only when its `origin` says so; a fork seed records the source session as `parentSession` with no `origin` (dsh forks an ordinary Session), so the fork roots its own family and never joins the source's graph, boards, comms, or cost folds. (dsh: header lineage in `packages/api/session-controller/src/list.ts` `listFields`; the row rename in `packages/api/session-controller/src/client/sessions/service.ts`; fork meta in `commands.ts`; `src/client/agentTree.ts` `familyParentOf`)

- **Limitation — complete prompt sections:** a deployment registering a `complete` system-prompt section keeps ONLY that section (registry design); `promptPrefix`/`promptSuffix` are dropped there. (dsh: `packages/core/system-prompt`)

## 6 · Projection cache

*How fold-state changes reach existing installations.*

1. **Bump a unit's `stateVersion` iff later events cannot backfill the change** — running totals, per-step collections flushed at `step/end`, materialized envelopes. Serve-time-derivable fields need no bump, and new wire fields are additive-optional: a pre-field row serves without them and the client degrades per §5's boundary rules. Current versions sit at each unit's `stateVersion` site; past bumps live in git history.
2. **Stale rows refold from the durable log**; the warm-up probes BOTH `contextActivity` and `contextTimeline` and cold-refolds missing or stale rows on first page open, so idle sessions rebuild exactly. (`src/host/backfill.ts`)
3. **Every cold read passes the host-wide gate** (issue #121) — FIFO, one at a time, only while the V8 heap sits below two-thirds of its ceiling; a skipped read takes the caller's designed no-data path, never a failure. (`src/host/coldRead.ts`)
4. **The warm-up folds sessions over 2,000 events in in-memory slices** (issue #145) through `sessionProjections.restore`/`hydrate`, `sessions.prepare`, and `sessionProjectionCache.write`, with one write-back at the log end and byte-identical rows to a single-shot `coldSnapshot`; any face absent → the session stays on the single-shot path (the faces exist on every supported line, §8's matrix probes them). (`src/host/backfill.ts`)

- **Procedure — force one session's refold:** `rm ~/.dsh/storages/session_projcache/sessions/<session-id>.json` — a derived cache, rebuilt from the durable log.

## 7 · Packaging

*Dependency declarations that look dead and are not.*

1. **Declare `@deepseek-ai/dsh-client-ui-primitives`' bare imports as this plugin's own build/test requirements** — its `lib/index.js` imports `shiki`, `@shikijs/langs/*`, `katex`, the `mdast-util-*`/`micromark-*` chain, `anser`, `clsx`, `diff`, and `simple-icons` while listing them as its own devDependencies. The client bundle never carries them (`deps.onlyBundle` + the `dsh-client-bundle-purity` plugin, `tsdown.config.ts`). If a primitives release starts inlining them, drop the matching entries in the same change.
2. **Declare `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-util-code-language`, and the store's own `zustand` + `immer`** — same reason, reached only through the primitives dist.
3. **Never add `tailwindcss` as a direct dependency** — `@tailwindcss/node` pins it at the same version; a second resolving copy breaks the napi native binding (`src/client/styles/tailwind.css`).

## 8 · Verification

*How every claim above is proven.*

- **Check — seam matrix** (the `compat` vitest project, every `pnpm test` in CI): stages the harness's REAL sources per baseline tag, boots the BUILT plugin into the tag's actual registries on its vendored cordis, probes the host and client seams, asserts retired seams ABSENT (`settings.register`, settings `get(ns)`, sessions `open(id)`), and asserts every event family `src/host/fold.ts` switches on is declared by every baseline. Requires a dsh checkout (`DSH_REPO`, default `~/dev/deepseek-harness`) and `pnpm run build` first; CI fails on a missing tag, a dev box skips with a printed reason.
- **Check — differential statistics:** figures verified equal to the harness's own projections (`sessionStats`, `contextBreakdown`, `contextPressure`, `tokenUsage`) over real session logs — tokens, request counts, turns/steps, TTFT, generation, tool time, billed cost buckets.
- **Check — install (manual, per release):** install the exact CLI into a disposable `DSH_HOME` (never the real `~/.dsh`); `dsh plugin add dsh-context` → `--dump-config` shows exactly 1 composed row → `dsh plugin remove` → 0 rows. Pin an exact plugin version for a just-published build — the profile's package-manager release-age policy can lag.
- **Check — hostile fixtures:** every guard branch carries them (wrong types, missing fields, throwing accessors) — an untested guard is an unverified promise.
- **Procedure — add a baseline:** one `Baseline` entry in `tests/baselines.ts` (tag, vendored cordis, faces) plus the tag in both workflows' fetch step; run `pnpm test` and re-fit whichever seam a failing probe names.
- **Limitation — scope:** these checks prove source-level seam compatibility, statistical parity, and install/uninstall per release — not full web-app runtime acceptance on a real profile.

## 9 · Terminal surface

*What the dsh-TUI half may rely on. `dsh-TUI:` paths are in the [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) tree. It needs the dsh-TUI release with the plugin UI kit, `tuiSessionData` and multi-command admission — they ship together.*

1. **Load only where `tuiSessionData` exists** — a deferred `ctx.inject`, so web and desktop never import `lib/tui.js`; the chart kit is feature-detected per render, never by version. (`src/host/terminal.ts`, `src/tui/detect.ts`; dsh-TUI: `docs/plugin-ui-kit-design.md`)
2. **Register through the executing activation** — dsh-TUI admits a service call only from the activation whose callback is running, and nested fibers inherit the plugin's `dsh-plugin.json` Component identity, so each registration goes through its own inject's context. (`src/tui/mount.ts`; dsh-TUI: `src/dsh-adapter/host-access.ts`, `src/dsh-adapter/component-identity.ts`)
3. **Cover the commands with one namespace permission** — the component projection keys permissions by name, so a facet carries one `commands.invoke`, scoped `dsh-context.*` over `context` and `ctx`; dsh-TUI's built-in `/context` shadows the bare `context`, reached as `/dsh-context:context`. (`dsh-plugin.json`; dsh-TUI: `src/adapter/standard/permission-scope.ts`)

- **Limitation — content:** the Browser shows the fold's one-line previews; full message text needs a history read with no non-deprecated in-process face (`Session.eventAt` is deprecated).
- **Limitation — release:** `scripts/publish.sh`'s auto-bump does not rewrite `dsh-plugin.json`; bump both together (`tests/shared/packageMeta.spec.ts` fails on drift).
