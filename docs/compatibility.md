# Compatibility

The rules dsh-context must hold on every supported `@deepseek-ai/dsh` release, and the evidence for each. Supported releases are declared in `package.json` (`dsh.compatibility.dshReleases`); baselines and their per-line seam faces are pinned in `tests/baselines.ts`.

**Grammar.** Entries are numbered **rules** (the bold lead is the invariant), plus **Limitation** (an accepted gap), **Check** (how a claim is proven), and **Procedure** (how to run a compatibility task). Evidence rides in trailing parens — paths in this repo, or `dsh:` paths in the harness tree read at the baseline tag — or as a table directly beneath the rule it maps. A rationale appears only where code cannot show it.

**Law.** Record only what no other artifact carries; delete what code, tests, or git history already say. Verify against the dsh sources before acting — source wins over this page. Less is ALWAYS better.

Last verified: **2026-10-31** (dsh-context `0.78.2`, dsh `0.2.0-rc.2` / `0.2.1-rc.2` tag trees).

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
5. **The command log folds `tool/call` + `tool/result` on every line and `job/registered` / `job/settled` only where they exist** — the `0.2.0` line logs no job events, so timing/exit derive from the event envelopes and result-text markers (`derived: true`); the `0.2.1` line's job events then refine them. A background hand-off ack (`started background job …` / `[still running …; moved to background job …]` plus its fixed guidance sentence) is no outcome: without job events the run stays `running` forever (dispatched, outcome unrecorded), and its runs/ms tallies wait for the terminal transition (the `bg` dispatch tally lands when the dispatch becomes known). (dsh: the `job/*` `SessionEventMap` declarations in `packages/jobs/jobs/src/types.ts` exist only at the `0.2.1` tags; `packages/shell/tool-bash/src/render.ts` and `packages/shell/tool-bash-persistent/src/index.ts` marker vocabularies; `src/shared/commands.ts`, `src/host/fold.ts`)

**Totality**

5. **Folds are TOTAL** — unknown event types return state unchanged; a malformed event drops whole (no partial state); no `undefined`-valued property is ever materialized into persisted state. The projection registry drives `apply` with no error boundary: one throw stalls the unit's cells and push feed forever, and one `undefined` property fails EVERY projection-cache write for the session.

- **Limitation — image offload (deferred):** on `IMAGE_OFFLOAD_REQUIRED` the harness offloads images via a message projection; the fold reads raw durable events, so an offloaded message keeps its pre-offload image count and price until compaction removes it. Revisit only if it shows in practice.

## 4 · Metering parity

*Figures the plugin prints that the harness also prints.*

1. **Mirror, don't import.** Re-fit when a supported line moves an implementation; verify differentially against the harness's own projections (§8). Right-hand paths are `dsh:` tree paths.

| Plugin site | dsh source mirrored |
| --- | --- |
| `src/shared/estimate.ts` | `packages/llm/token-meter/src/estimate.ts` — `estimateSystemMessage` and its per-block text arm |
| `src/host/pricing.ts` `estimateReasoningTokens` / `estimateAnswerTokens` / `estimateCallTokens` | `packages/llm/token-meter/src/estimate.ts` — the reasoning-, text- and tool-call-block arms of `estimateContent` |
| `src/shared/fileTokens.ts` | `packages/llm/llm/src/content.ts` `fileHandleText` — a `file` block costs its request handle text, never its bytes (priced via `packages/llm/token-meter/src/route-pricing.ts`); price the pathless arm |
| TPS chip first-token anchor | `packages/llm/llm/src/assistant-stream.ts` `assistantStreamFirstTokenTime` |
| `src/client/headline.ts` `occupancyPercent` | `packages/client/ui-conversation/src/client/context-occupancy.ts` — internal to the kernel bundle, no package export, hence mirrored |
| `src/client/reserve.ts` | `packages/compaction/compaction-basic/src/config.ts` — only the shipped defaults (`thresholdRatio` 0.8, `headroomTokens` 65536): preset realms make a deployment's policy unreadable; when `contextWindow − reservedOutput − headroomTokens` is non-positive the backend refuses (`TargetPressureConfigError`), so the bar paints no masks |

- **Limitation — thinking / answers / tool-call splits (estimate):** no supported DeepSeek route reports those buckets (`llm-deepseek`'s `updateUsage` maps only input/output/cache), so the three slices follow the meter's own block prices: the live assistant share and the generated output split by their reasoning/reply/tool-call content ratios, with a provider `reasoningTokens` count winning for thinking. The `deepseek-messages` route does replay assistant thinking blocks on every request. (dsh: `packages/llm/llm-deepseek/src/translate.ts` `updateUsage`, `packages/llm/llm-deepseek/src/serialize.ts` `assistant`; `src/client/categories.ts` `billedParts`)
- **Limitation — declared divergence:** the timing card's wait/generation boundary opens at the first OBSERVABLE instant (the first token, or an earlier `block-start` marker the token packing could not stamp), not at the meter's first-token anchor — so marker-tiled decode buckets and the split never double-count one window.
- **Limitation — timing-card tool slice:** the card attributes the per-step busy UNION (`toolBusyMs`, clipped into each step's window) so its rows partition the active wall and a parallel batch prices once; a run outside every step window therefore prices no busy time. The harness's own `sessionStats.toolMs` stays the per-call sum and remains the tooltip's figure when the two differ. (dsh: `packages/session/session-stats/src/projection.ts` `toolMs`; `src/host/fold.ts`, `src/shared/types.ts`)
- **Limitation — idle carve:** the card's active figure is step wall minus idle windows — eventless gaps ≥ 2 min in the step's un-painted residue plus user-wait windows (approvals, `ask_user_question`) of the same length, taken only after the step's model response because a sent request stays active; a quiet running tool stays busy by the same rule, and a step past the heartbeat-stamp cap skips the carve conservatively. Idle paints no span: the strip packs active time only. (`src/host/fold.ts`, `src/host/foldMetering.ts`, `src/client/services.ts` `activeMsOf`)
- **Limitation — daily-ledger attribution:** `contextTimeline.cost` prices at the settlement instant while the daily ledger prices at the step-initiation instant, so a tariff-boundary step can split its peak/off buckets differently between the lifetime total and the KPI band; the ledger also retains 400 days (`MAX_KEPT_DAYS` in `src/host/activity.ts`). Its per-day tool table books a paired tool result, and its per-day command table books the head program of a parseable command dispatch (`tool/call`, `tool/ptc-dispatch-start`); both cap at 64 names a day. A command counts on dispatch here, where the Command Executions card's settled-run tally waits.
- **Limitation — statutory holidays:** no holiday calendar is maintained (by decision), so a holiday-weekday request inside the peak windows prices at peak where the platform bills off-peak; the tooltip states the weekday/weekend rule. (`src/host/foldMetering.ts` `isBeijingPeak`)

## 5 · Client surface

*What the browser half may rely on.*

**Seams**

1. **Every capability rides an OPTIONAL seam** — deferred `ctx.inject` (never a hard `inject`), the face re-proved before use, the registration guarded, the module declared in `dsh.client.inject` where the capability must be live at mount; a one-shot command read is `ctx.get` per call and adds neither a fiber nor a boot-order edge (rules 3 and 5). No service → no capability: no pending fiber, no throw. Per-line faces are pinned in `tests/baselines.ts` and probed by §8's matrix.
2. **Mount at most once per page** (issue #137) — the client-plugin runner force-assigns a fresh shadowing priority to every registration, so the slot registry's same-priority duplicate guard never fires across a double mount. Read the raw ledger; mount nothing when `context-jump` is already seated; the read fails open. (dsh: `packages/client/ui-renderer/src/client/registry.ts` `SlotRegistry.entries`; probe `ledger`)
3. **Session jump uses the sidebar's own verb**, `uiWorkspace.openSession(SessionTarget)` — never the sessions service's `open(id)`, removed by the `0.1.6` selection refactor (issue #90). (dsh: `packages/client/ui-workspace/src/client/navigation.ts`; probe `sessionNav`)
4. **The member card's open prefers the right Sidebar's subagent chat**, addressed by the row's own direct parent — a face that is absent or leaves the address unclaimed keeps rule 3's whole-view jump. (dsh: `packages/client/ui-subagent/src/client/sidebar-chat/index.tsx`, `packages/client/ui-sidebar-right/src/client/service.ts`)
5. **The member card's enter pre-seeds the entered session's view** — the conversation shell re-reads its per-session persisted `view` preference on EVERY session binding, so merge-writing `dsh.conversation.<sessionId>` (the draft rides along; a malformed stored state is replaced whole) before rule 3's whole-view jump lands the entered session on this bundle's `context` view; an unregistered id (sidebar/hide placement) resolves to the shell's chat fallback. (dsh: `packages/client/ui-conversation/src/client/stores.ts` `readConversationViewPreference`, `apply.ts` `restoreView`; `src/client/services.ts` `seedConversationViewVia`)
6. **The settings jump uses the Plugins panel's own navigator**, `pluginNavigation.openBundle(packageName)` — never a DOM walk over its chrome: `0.2.1`'s contributed `plugins.tab` slot remembers its selection, so the card the walk seeks is absent while another tab is open, and the navigator resets that tab to Installed (the `0.2.0` line ships no contributed tabs). (dsh: `packages/client/ui-plugin-manager/src/client/index.ts`; probe `pluginsNav`)
7. **Locale switches reach memoized cards through the LocaleFace `subscribe`/`getLocale` pair** — the kit's `useLocaleTick` subscribes when the face exists and degrades to the boot locale when it does not (an old face simply never fires). (dsh: `packages/client/locale/src/client/index.ts` `LocaleFace`; `src/client/viewkit.ts`)

**Boundary**

8. **Re-prove everything at the boundary** — collections re-proven, scalars zeroed, whole-value absence stays `null` (the loading screen); structural narrowing over blind casts; skip elements that fail the shape instead of throwing. (`src/client/timelineSource.ts`)
9. **Isolate per-item work over hostile objects**; every async read resolves to data or a retryable failure note — never an eternal spinner. (`src/client/timelineSource.ts`)
10. **A pushed revision decrease resets the detail ledger** — stale reads never merge into the new head. (`src/client/timelineSource.ts`)
11. **Fetch routes ride browser-relative spellings** (issue #159) — the client never issues a root-absolute `/api/...` URL: fetch resolves the relative form against the page's document base, so a deployment behind a path-prefixed reverse proxy (page at `/app/dsh/`) keeps its prefix, where a root-absolute spelling 404s at the gateway. (`src/client/apiRoutes.ts`)
12. **Only a `'subagent'`-origin row draws a family edge** — a list row's `parentId` is subagent lineage only when its `origin` says so; a fork seed records the source session as `parentSession` with no `origin` (dsh forks an ordinary Session), so the fork roots its own family and never joins the source's graph, boards, comms, or cost folds. (dsh: header lineage in `packages/api/session-controller/src/list.ts` `listFields`; the row rename in `packages/api/session-controller/src/client/sessions/service.ts`; fork meta in `commands.ts`; `src/client/agentTree.ts` `familyParentOf`)
13. **Every history read carries that session's own durable address** (issue #193) — the host refuses a subagent child read under a plain `session` address (`session/agent-busy`), so a child read names its DIRECT parent. `sessions.subagentAddress(id)` answers first; its listed-summary fallback exists only on the `0.2.1` line, so the `'subagent'`-origin list row's `parentId` is the second source with mode `unknown` (accepted unchecked). Resolution runs PER READ, so an address learned after a refused attempt heals its retry. (dsh: `packages/api/session-controller/src/history.ts` `validateAddress`, `.../client/sessions/manager.ts` `subagentAddress`; `src/client/services.ts` `sessionAddressOf`, `src/client/historyPage.ts`; probe `subagentAddress`)
14. **The command panel's coloring rides the primitives' own lazy shiki highlighter** — `useCodeHighlighter` on `bash` (the pre-warmed `shellscript` boot grammar: the first render is already colored) and `pwsh` (the lazy `powershell` grammar: plain until it registers, then the hook's store tick recolors); `run_code` stays plain — a code-mode program names no language (TypeScript or Python per runtime), so no grammar colors it truthfully. Any line past 1,000 UTF-16 units renders its whole text plain, the plugin's own guard for the JavaScript regex engine's per-line cost (the harness's own cap starts only at `0.2.1`). (dsh: `packages/client/ui-primitives/src/code-highlighting.ts`, `.../markdown/highlight.ts` `LANGS` + the shellscript warmup + the PowerShell lazy entry, `packages/client/ui-theme/src/styles/shiki.css`; `src/client/commandHighlight.ts`; probe `codeHighlight`)
15. **The right Sidebar's body gates on the seat's optional `useTabInfo` hook** — its `tab.visible` already accounts for a floating pane and the collapsed track; an invisible tab mounts no cards and parks its detail subscription, and without the hook the body keeps its IntersectionObserver fallback. (dsh: `packages/client/ui-sidebar-right/src/client/tab-info.ts` `tabInfoFactory`; `src/client/components/contextView.tsx`)

- **Limitation — complete prompt sections:** a deployment registering a `complete` system-prompt section keeps ONLY that section (registry design); `promptPrefix`/`promptSuffix` are dropped there. (dsh: `packages/core/system-prompt`)
- **Limitation — settlement report split:** the Fleet comms detail recognizes dsh's fixed English settlement summaries and the `Its closing message:` / `Structured result:` markers. A provider diagnostic appended after the closing text without a structured payload has no marker, so it stays inside the closing report; an unknown/future summary renders raw rather than localized. (dsh: `packages/subagent/subagent/src/continuation-messages.ts` `createSettlementMessage`; `src/host/fleet.ts`)

## 6 · Projection cache

*How fold-state changes reach existing installations.*

1. **Bump a unit's `stateVersion` iff later events cannot backfill the change** — running totals, per-step collections flushed at `step/end`, materialized envelopes. Serve-time-derivable fields need no bump, and new wire fields are additive-optional: a pre-field row serves without them and the client degrades per §5's boundary rules. Current versions sit at each unit's `stateVersion` site; past bumps live in git history.
2. **Stale rows refold from the durable log**; the warm-up probes BOTH `contextActivity` and `contextTimeline` and cold-refolds missing or stale rows on first page open, so idle sessions rebuild exactly. (`src/host/backfill.ts`)
3. **Every cold read passes the host-wide gate** (issue #121) — FIFO, one at a time, only while the V8 heap sits below two-thirds of its ceiling; a skipped read takes the caller's designed no-data path, never a failure. (`src/host/coldRead.ts`)
4. **The warm-up folds sessions over 2,000 events in in-memory slices** (issue #145) through `sessionProjections.restore`/`hydrate`, `sessions.prepare`, and `sessionProjectionCache.write`, with one write-back at the log end and byte-identical rows to a single-shot `coldSnapshot`; any face absent → the session stays on the single-shot path (the faces exist on every supported line, §8's matrix probes them). (`src/host/backfill.ts`)
5. **`contextTimeline` checkpoints its head only** (issue #217) — the persisted state carries the aggregates, the per-turn/per-event windows (bounded by `maxKeptTurns`/`maxRequestSteps`/`maxEvents`), the newest request record (the `last` anchor) and a compact surface index (no request history, context events, file ops, command log, spans, or archive). The framework checkpoints every registered unit, so the row itself is the only lever; the detail collections are folded on demand by the detail route (live events first, cold observation second) with a four-entry cap. The wire value is always the head, gate or no gate: a deployment without the detail route keeps the counters and headline and shows the detail note. (`src/host/timeline.ts`, `src/host/fold.ts` detail guards, `src/host/detail.ts`; dsh: `packages/session/session-projection/src/index.ts` `checkpoint()`)
6. **Legacy full rows stay readable** — the state schema compacts a full row of the same `stateVersion: 36` on parse (derives the counters, strips the detail arrays, compacts the surface), so cold heads survive the upgrade and the next checkpoint writes the compact form. No bump: the counters are derivable from the durable log and a row is only a fold shortcut. (`src/host/foldState.ts` `compactTimelineState`, `src/host/timeline.ts`)
7. **A one-shot sweep compacts the existing rows** — once the cache domain is open, the plugin walks its `sessions` table and rewrites each legacy `contextTimeline` value **at the current `stateVersion`** through the same schema via the table's atomic `update`; identity and the other rows are preserved, parse failures and other generations are skipped, and every write is fail-soft. This delivers the startup win to idle sessions without a refold. The sweep runs after boot, so only the first boot after the upgrade still loads the old payload. (`src/host/cacheCompact.ts`; dsh: `packages/storage/storage-domain/src/index.ts` `get()` / `table()`, `packages/storage/storage-domain/src/domain.ts` `KvTable.update`)

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
