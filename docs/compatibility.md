# Compatibility

dsh-context declares per-release compatibility with `@deepseek-ai/dsh` in its package manifest (`dsh.compatibility.dshReleases`). This page records what is actually verified for each declared release, and how.

Last verified: **2026-09-25** (plugin `dsh-context@0.56.0` source tree, dsh `0.1.7-rc.2`).

## Supported dsh releases

| dsh release | Session log | Declared | Automated seam matrix | Disposable-profile install / uninstall |
| --- | --- | --- | --- | --- |
| `0.1.5-rc.1` | V3 | compatible | ✅ baseline `v0.1.5-rc.1` | ✅ install OK → 1 composed row → uninstall OK → 0 rows (verified 2026-09-10) |
| `0.1.7-rc.2` | V4 | compatible | ✅ baseline `v0.1.7-rc.2` | — (not yet performed manually) |

The automated seam matrix runs for every row on every `pnpm test`. The disposable-profile column is a manual, per-release check: each release's CLI was installed from npm into a temporary `DSH_HOME` (the real `~/.dsh` is never touched) — `0.1.5-rc.1` on 2026-09-10 against the official npm registry (a stale mirror can 404 the harness's own dependency closure before the plugin is even considered).

The supported range is the two lines above: the `0.1.5` line from `rc.1` and the `0.1.7` line from `rc.2` (the first release of that line with a complete npm dependency closure; `rc.2` adds `startsSeries` to the first `request/header` of a resumed series and the `developer/message` tool-registry events, both inert to the fold). Everything older — the `0.1.2`/`0.1.3` generations, the `0.1.1` line, and the alpha previews — was supported through `dsh-context@0.55.x` and is no longer in the support matrix; on such a harness the plugin's baseline gate composes the fallback units and shows the upgrade prompt instead of folding.

## Harness-side compatibility admission (0.1.7+)

From `0.1.7` the harness enforces a plugin's own `peerDependencies` at startup and install: a bundle whose `@deepseek-ai/dsh*` peer ranges do not satisfy the running version (semver, `includePrerelease: true`) is skipped at composition, refused at install, and only loads with an exact-version exemption (`dsh plugin allow-version`). This plugin's dsh peers are all `>=0.1.5-rc.1`, which every supported release — both prerelease lines included — satisfies, so the plugin composes normally with no exemption.

## Baseline gate

The declared floor is enforced at runtime, not only documented. At startup the host resolves the running harness's version — first from the module tree the plugin is bound to, then from the `$DSH_HOME/profiles/node_modules` mirror — and compares it against `0.1.5-rc.1` (channel order: release > rc > beta > alpha):

- **Below the floor** — fallback projection units that fold nothing and serve zeroed data: the Context tab keeps its (empty) cards while a modal names both versions and urges the update.
- **At or above the floor** — the real projection units.
- **Undetectable or unparseable** — **fails open** into the real units, so a probe misfire never blanks a working deployment.

The mirror reflects whichever installation last booted a CLI profile, which need not be the running one (a packaged desktop client never refreshes it), so it never outranks the running module tree. Implementation: `src/host/version.ts`, `src/host/fallback.ts`, `src/shared/version.ts`.

## Session-log generations

The supported range spans two durable-log generations, and the plugin folds both from one shape-driven code path (`src/host/logShapes.ts`):

| Seam | V3 (`0.1.5-rc.1+`) | V4 (`0.1.6/0.1.7+`) |
| --- | --- | --- |
| System prompt | `system/message` surface node (a `request/header` carrying `header.system` is rejected outright) | same as V3 |
| First token | embedded `assistant/message.data.stream` (also `assistant/attempt.data.stream`) — packed delta runs plus raw `chunk` records | same as V3 |
| Replacement endpoints | `{ startSeq, endSeq }` | same as V3 |
| Nested PTC dispatch | `tool/ptc-dispatch` | same as V3 |
| Tool result | `tool-result` wrapper block, `role: 'user'` | `role: 'tool'`, lifted `message.toolCallId`/`message.isError`, direct content (no wrapper block) |

**Legacy logs never reach the fold.** The running harness migrates every historical log to its own generation on EVERY read path the plugin rides — live open, persistence read handles, `sessionQuery.observeSession` (the detail/backfill cold reads) — in memory on read opens and as a published successor file on write opens; the fork-inherited prefix migrates with the rest. A log the migration chain cannot convert is refused entirely (`SessionFormatUnsupportedError`): the session is unavailable, never served raw. So on any supported harness the events the fold sees are V3/V4-shaped by construction, and the pre-V3 spellings (`header.system` envelopes, `assistant/chunk` floods, `{ start, end }` endpoints, `tool/code-dispatch`) exist nowhere in the code.

The fold never branches on a detected harness version. The version probe is best-effort — it reports the module tree the embedding shell resolves plugin imports to, which a packaged client may redirect — so it decides which units register and nothing more.

### Known V4 deltas

- **Tool-result error mark**: V4 made the event-level `data.error` identity optional while lifting `isError` onto the message, so the fold reads the flag from BOTH spellings (`src/host/fold.ts`); a V4 result carrying only `message.isError` still flags its surface node and file-op row.
- **Image offload accounting (deferred)**: when a route rejects with `IMAGE_OFFLOAD_REQUIRED`, the harness offloads images out of the context through a message projection. The plugin's fold reads raw durable events, so an offloaded message keeps its pre-offload image count and price until compaction removes it — an over-count on a rare recovery path, not a crash. Revisit alongside the harness's own token-meter treatment if it shows up in practice.
- **User preferences (shipped)**: the V4 line (first shipped in `0.1.6-alpha.2`) retired the `settings.register` host face and the `settings.plugin.item` browser slot — plugin configuration moved to the Plugins page, derived from each loader entry's own Config schema. The plugin serves both generations from one entry schema:
  - The entry `Config` (`src/host/config.ts`) is schemastery. Cordis still validates the `config:` block through its Standard Schema face on every supported line; on V4+ the SAME schema is what the settings `describe` projects — the namespace is the entry id (`dsh-context`) and the six preference fields (`.volatile()`-marked) are the served, live-editable form; the fold bounds stay ordinary entry config (their edit remounts the entry, a preference edit commits volatile-only and never remounts).
  - The browser half registers its card on the seat the running line declares, by service presence: `settingsScope` + `settings.plugin.item` on V3, `configForms` + the Plugins page's keyed `plugins.bundle.config` on V4+ (`ctx.configForms.whileServed` keeps the card alive only while the Host serves the namespace). Both seats render the same six preference rows.
  - The `.volatile()` modifier exists only on the Config-form generations' schemastery; the schema builder feature-detects it, so the same bundle serves both lines.
  - Deliberate relaxations against the replaced zod schema: schemastery objects merge unknown keys through instead of failing the load, and only whole-value edits are rejected by range/step checks (bounds remain `min 1, step 1`).
  - Preference values persisted on the V3 line live in the settings document (`settings.yaml` section `dsh-context`); the V4 harness's own legacy import moves that section into the profile entry of the same name on first boot, so existing values carry into the new surface.

## Web client seams

The browser half rides generation-specific seats, each reached through an optional seam so a deployment without the service simply goes without the capability. Both supported lines ship the right Sidebar and the keyed `main` conversation panel; the plugin contributes to whichever face the running line serves:

| Seam | V3 (`0.1.5-rc.1`) | V4 (`0.1.7-rc.2`) |
| --- | --- | --- |
| Conversation panel root | keyed `main` panel's `main.conversation` (the plugin's `conversation.view` seat hangs under it) | same as V3 |
| Right Sidebar tab + guide entry | `sidebarRightTabs` registry, `sidebar.right.pane.tab`(+`.title`) seats, guide capsule with `order`/`title`/`description`/`icon` | same as V3 (`0.1.7-rc.2` adds an optional `commandId` to guide entries and `bindCommands` to tab actions — additive, unused by the plugin) |
| Preferences card seat | `settings.plugin.item` over the `settingsScope` transport | `plugins.bundle.config` over the `configForms` transport |
| Session jump | `uiWorkspace.openSession` — the sidebar row click's own verb; the retired `sessions.open(id)` spelling is still served as a fallback | `uiWorkspace.openSession(target: SessionTarget)` — same verb, parameter re-spelled by the 0.1.6 selection refactor; the sessions service carries no selection verb any more |

The guide capsule carries `order`, `title`, `description`, and `icon`; `0.1.5-rc.1+` renders the description line (the `guideEntry` probe in `tests/baselines.ts` pins the fields of both supported generations).

The File Activity card's file-name affordance is an optional-column story: on a line with the right Sidebar it opens the file's preview tab through `ctx.sidebarRight.openResource` (the built-in Files sidebar's own path), building the `dsh-resource://file/…` address with the harness's browser-safe `fileAddressFor` (inlined by the client bundle, exactly as the Sidebar's own file types inline it). Where the preview face is absent (or refuses the address), the name keeps its original system-open behavior; the `sidebar.nav` probe pins the navigation face's spelling.

The session jump — a Context Dashboard session card or an Agent network node bringing its session forward — rides the harness's own selection verb (`openSessionVia` in `src/client/services.ts`): `uiWorkspace.openSession`, the verb the built-in sidebar's row click uses on every supported line, with the sessions service's retired `open(id)` spelling kept as the degradation path for a composition without the workspace module. Both faces are re-proved per call and a deployment serving neither (or a hostile face) swallows silently — the panel still closes, the jump just does not land. Issue #90 was exactly the retired-spelling trap: the plugin called `sessions.open` alone, which the 0.1.6 selection refactor removed from the service (the click then did nothing on `0.1.7-rc.2`), so the jump now follows the view owner first and the per-baseline `sessionNav` probe pins both spellings presence-as-declared.

The Context Dashboard's DeepSeek balance capsule is an all-optional stack, so it arms nowhere it cannot: the host reaches the `settings` and `credentials` services only inside a deferred `ctx.inject` (and re-reads them per request, so a key added while the host runs is picked up on the next open), mounts `/api/dsh-context/balance` through the same Connection exact-route registry as the detail and backfill routes, and the outbound `/user/balance` read carries the key only inside the host process. The provider's settings row is read through whichever face the running line serves: the `get(ns)` registered-section read through V3 (the `llm-deepseek` namespace), the Config-form `describe()` projection on V4+ — there the row is the entry whose served value declares the top-level `apiKeyEnv` credential ref, preferred under the settings ids the generations have served it as (`llm-deepseek` on product profiles, `llm-deepseek-api-key` elsewhere). The capsule appears only on a live, well-formed answer; a deployment whose DeepSeek API-key provider is not composed (no settings row on either face), whose credentials service cannot resolve the key, whose connection service lacks the exact-route registry, or whose platform read fails (network, non-2xx, malformed payload, a third-party endpoint that does not serve the balance path) answers a typed `null` and the browser renders nothing — no pill, no spinner, no error state. The `balance` probe pins the settings face and the provider row's sources per baseline.

## What each check means

- **Automated seam matrix** — part of this repository's `pnpm test` (the `compat` vitest project). For every baseline tag it stages the harness's REAL sources at that tag, boots the plugin's built host entry into that tag's actual `SessionProjectionRegistry` on the cordis release the line vendors, and probes the tag's client seams (slots, finalized-nodes seat, image loader, history face/envelope, markdown chrome, platform module table, that generation's durable-event vocabulary, the right Sidebar tab seam, its guide-entry contract and its resource-navigation face, the session-jump seam, the preferences card seat and settings transport). Definitions live in `tests/baselines.ts`; the release workflow fetches the pinned baseline tags before testing. Preferences seats and transports are asserted BOTH ways: each slot exists on exactly one supported generation, so the plugin's deferred registrations pick their side and never pend.
- **Statistics against the harness's own folds** — the plugin's figures were verified differentially against the harness's OWN projection values (`sessionStats`, `contextBreakdown`, `contextPressure`, `tokenUsage`) over real session logs: system/tools/message tokens, per-request counts, turns/steps, TTFT, generation, tool time, and every billed cost bucket match exactly.
- **Disposable-profile install / uninstall** — for each release, that exact `dsh` CLI version was installed from npm into a temporary `DSH_HOME` (the real `~/.dsh` is never touched), then:
  1. `dsh plugin --profile <disposable> add dsh-context` — install OK;
  2. `dsh --profile <disposable> --dump-config` — the bundle's `- id: dsh-context` row composes into the effective configuration (exactly 1 row);
  3. `dsh plugin --profile <disposable> remove dsh-context` — uninstall OK, dump-config back to 0 rows.

## Scope

These checks prove source-level seam compatibility, statistical parity with the harness's own folds, and disposable-profile install/start-composition/uninstall per release. They are not a claim of full web-app runtime acceptance on a real Profile — visible UI behavior depends on the harness generation and the browser half, which the seam matrix approximates from the tag's sources.

## Upgrading from an older plugin build

The skill-injection category (issue #66) bumps the timeline projection's `stateVersion` (18 → 19): skill content — the `<available_skills>` catalog digest, a user-explicit `/name` invocation's instructions message, and the content a `skill`-tool load returns — now folds into its own `skill` composition bucket instead of `inject`/`tool`. The re-bucketing changes the fold's per-category sums, so on upgrade every cached per-session row is invalidated and re-folded from the durable log, which rebuilds them under the new categories. The bump orphans the `contextTimeline` key for idle sessions, which have no refresh channel until they go live again — such a session re-folds when its log receives its next event. New sessions are exact from their first event.

The Agent network card covers the orphaned relatives without waiting for a visit: a session listed without a `contextTimeline` row (composition absent, occupancy only) fetches its slim head from the plugin's `/api/dsh-context/detail` fetch route (mounted through Connection's exact-route registry, behind the same authenticated `/api` fence), which folds the durable log on demand — the node's ring renders the full composition the first time the card opens. The same backfill serves sessions whose cache predates the plugin's installation entirely. Where the route is unavailable (the baseline gate, a connection service without the exact-route registry), the card degrades to the pressure-only occupancy ring as before.

The session cards' last-user-message preview (`lastUser` on the `contextTimeline` head) bumps the timeline projection's `stateVersion` (19 → 20): a stale row can never gain the field while its session is idle (it only lands when a user message folds), so on upgrade every cached timeline row is invalidated and refolded from the durable log. To keep the bump from orphaning idle sessions' rows, the warm-up (`src/host/backfill.ts`) probes BOTH dashboard rows — `contextActivity` AND `contextTimeline` — and cold-refolds every session whose either row is missing or version-stale, so previews (and every other head figure) are exact for the whole session list the first time the dashboard opens after the upgrade. A deployment without the cold-path services — or whose client cannot mount the warm-up's trigger route — degrades to the per-session refold on the session's next activity, the same as pre-warm-up upgrades.

The Context Dashboard (the sidebar-foot panel) reads its `contextActivity` projection — a per-day ledger of billed tokens and completed requests, `stateVersion` 1 — off every session-list row's projection column. A new key is purely additive: no existing cached row is invalidated, but sessions folded before the unit existed (and sessions that predate the plugin entirely, whose `contextTimeline`/`contextHeaders` rows are missing too) have nothing to serve until they next go live. The plugin therefore runs a one-pass warm-up on demand (`src/host/backfill.ts`): the dashboard is the rows' only reader, so its panel POSTs the plugin's `/api/dsh-context/backfill` fetch route (the same authenticated `/api` fence as the detail route) the first time it opens, and only then does the host walk the corpus — for every stored session missing the row it cold-reads the durable log once through the projection cache's own cold-read ladder (`coldSnapshot`), which seeds each unit from its cached rows, folds the remainder, and writes the refreshed checkpoint back. The pass runs once per host process (later opens and later POSTs are no-ops); live sessions are skipped (they fold for themselves); a legacy log the running harness refuses to migrate is permanent — its per-session detail logs at debug and the pass ends with one summary info line, so an unmigratable corpus costs one line per dashboard-open process, not one warn per session per boot; and a deployment whose client never opens the dashboard never cold-reads a thing. A deployment without the sessionQuery/sessionProjectionCache/sessionPersistence/sessions services — or whose connection service lacks the exact-route registry — simply never arms the pass (such a client could not open the dashboard to read the rows anyway).

To force a full refold of an existing session sooner, delete its cached projection row — it is a derived cache and is rebuilt from the durable log:

```bash
rm ~/.dsh/storages/session_projcache/sessions/<session-id>.json
```
