# dsh-context redesign — use the harness natively

Status: **implemented** (v0.9.0). The analysis below documents the review and
the target architecture; the **Data path (host + client), the modern slot
registration, and the removal of the custom RPC / polling / client cache are
fully landed**. Remaining future work is scoped at the end of §5.

Scope: review the plugin (v0.8.0) against the current DeepSeek Harness
(master @ `47f943859b`, ~0.1.0-rc.5; npm `next` dist-tag at 0.1.0-rc.6), and
define a target architecture that leans on the harness's native services,
client framework, and data pipeline instead of re-implementing them.

The rule of thumb the redesign follows (from the harness's own docs —
`docs/subsystems/session-projection.md`):

> The framework drives, the domain computes: the registry subscribes to
> `session/event` once and folds every committed event through every unit;
> domains hold no subscriptions and clients never fold domain events — they
> receive finished values.

---

## 1. What the plugin does today (v0.8.0)

Two halves shipped in one package:

- **Host half** (`src/host/`, bundled to `lib/index.js`): a plain Cordis plugin
  (`inject: ['connection']`) that
  1. folds a session's durable event log into a per-request context timeline
     (`fold.ts` — incremental per-session `FoldState`),
  2. prices messages with its own copy of the harness's token-meter heuristic
     (`pricing.ts`: ~4 chars/token, block/role overhead),
  3. tracks compactions/prunes via the *shadow-price* protocol
     (`pendingShadowedSeqs` armed by `compaction/summary`/`compaction/prune`),
  4. serves the result over a **custom RPC channel** `/dsh-context`
     (`connection.rpc.handle`) — live sessions fold from `sessions.get(id).events`,
     cold sessions from `sessionQuery.readSession`, cached per session in a
     module-level `Map`.
- **Client half** (`src/client/`, bundled to `lib/client.js` as a
  `window.__ModuleLoader__.load({id, factory})` closure): registers the
  `conversation.view` tab ("上下文/Context", order 20) and renders
  1. a stats board (turns/steps/recycled/injects/switches/estimated + actuals),
  2. a current-composition stacked bar + legend (system/tools/user/inject/assistant/tool)
     anchored to provider-reported occupancy,
  3. a per-request stacked-bar history chart (step/turn granularity, ✂ compaction
     markers, hover tooltip, pinned detail),
  4. a context-events list and a model-visible message list.
  Data arrives by **polling the RPC every 2s** (visibility-aware), with a
  per-session stale-while-revalidate cache (`cache.ts`), hand-rolled React
  (`react.ts` `h()` factories), `<style data-plugin>` injection, and
  `ctx.locale.register/bind` dictionaries.

---

## 2. The harness today — capabilities a plugin can rely on

All facts below are from the harness monorepo at `~/dev/deepseek-harness`
(master), cross-checked against the published npm surface where relevant.

### 2.1 Native session services

| Service | Package | What it gives a plugin |
| --- | --- | --- |
| `ctx.sessions` | `@deepseek-ai/dsh-session` | `Session` (`.events`, `.surface.nodes`, `.deriveMessages()`, `.requestHeader()`, `.requestContext()`, `.seq`, `.header`), `SessionStore.get/list/fork`, lifecycle events `session/created` \| `session/event` \| `session/disposed` \| `session/flush` |
| `ctx.sessionQuery` | `@deepseek-ai/dsh-session-query` | `readSession` → `{session, events}`, `listEvents`, `listSessions`, search — for cold/persisted logs |
| `ctx.tokenMeter` | `@deepseek-ai/dsh-token-meter` | `measure(session)` → `TokenMeasurement` (baseline / surface tokens / per-node priced surface), `estimateMessage(message)` — the *official* fixed-density estimator the plugin currently copies. Public surface is the service class; the package root exports only the service and types (pure `estimate.ts` helpers are not re-exported for npm consumers), so price through the injected service. |
| `ctx.sessionProjections` | `@deepseek-ai/dsh-session-projection` | Register pure `ProjectionDefinition` units `{key, schema(zod), init, apply(state,event), view(state), stateVersion}`; eager drive over `session/event`; per-session watermark cells; `snapshot(session)` / `checkpoint(session)` / `onChanged` |
| `ctx.sessionProjectionCache` | `@deepseek-ai/dsh-session-projection-cache` | Persisted `(sessionId, key, ver, seq, val)` rows, throttled write-behind + `turn/end`/disposal checkpoints, cold-read ladder |
| `ctx.connection.rpc` | `@deepseek-ai/dsh-client-connection` | `handle(channel, handler, {authority})` **and** `intercept('/api', matcher, handler, {authority})` — the shared `/api` channel convention (the official gateway registers endpoints via `intercept('/api', …, {authority:'trusted-host'})`; `handle('/api', …)` is itself rejected) |

Config: Cordis plugins read config as the **second argument** of `apply(ctx, config)`
(function plugins; class plugins via constructor). Services declare
`static Config: z<Config> = z.object({...})` with `@deepseek-ai/schemastery` `z` —
defaults on fields, unknown keys rejected. There is no `ctx.config` property;
`apply(ctx, config)` is the mechanism.

### 2.2 The session event vocabulary (current)

`SessionEventMap` (all payloads quoted from `packages/core/session/src/types.ts`):

- `turn/start {turn}`, `turn/end {turn, reason}` — reason is a merge-extensible
  sum type: `completed | aborted | blocked | error | max-tokens | interrupted`.
- `step/start {turn, step}`, `step/end {turn, step}` — the step lifecycle
  authority (one `step/end` per entered step, even on failure/cancel/max-tokens).
- `user/message` — data **is** the `UserMessage` (role user; `source.kind`
  distinguishes human prompt vs plugin/skill injection).
- `assistant/chunk {turn, step, chunk}` (raw stream, incl. `type:'usage'` chunks).
- `assistant/message {turn, step, message, usage?}`.
- `tool/call {turn, step, callId, name, arguments}`.
- `tool/result {turn, step, message, error? {name, code}, meta?}`.
- `todo/write {todos}` — whole-list snapshot.
- `request/header {header, reason}` — reason `initial | resume | change`;
  `header.config {provider, model, ...}`, `header.system`, `header.tools`.
- `request/context` — data **is** `RequestContext {provider, model, contextWindow?}`.
- `session/end-seed` — constructor seed boundary.
- Surface metadata on the three message-producing types only: `surfaceOp:
  'append' | {op:'replace', start, end}` plus `sourceEventSeqs` provenance.
- Compaction family: `compaction/start {compactionId, ...}`,
  `compaction/summary {compactionId, shadowedSeqs, shadowedRange, shadowedTokenCount, summary, provider, model, usage?}`,
  `compaction/end {compactionId, ...}` — the actual surface replacement is the
  **immediately following `user/message`** with `surfaceOp:{op:'replace'}` whose
  `source` is the compact checkpoint (`kind:'plugin', plugin:'compact',
  compactionId`) — the chat already detects it
  (`isCompactCheckpointSource`); `compaction/prune {shadowedRange,
  shadowedSeqs, shadowedTokenCount}` precedes a content-only `tool/result`
  rewrite.

### 2.3 Projections already shipped by the harness (free data)

| Key | Provider | Value |
| --- | --- | --- |
| `contextPressure` | dsh-token-meter | `pressureTokens`, `projectedTokens`, `contextWindow` — exactly the "provider-anchored occupancy" the plugin's overview card re-derives |
| `contextBreakdown` | dsh-token-meter | `systemTokens`, `toolsTokens`, `messageTokens` (heuristic composition) |
| `tokenUsage` | dsh-token-meter | cumulative `uncachedInputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` |
| `sessionStats` | dsh-session-stats | whole-log `turns`, `steps`, `llmMs`, `toolMs`, `ttftMs`, `ttftSteps`, `decodeMs`, `decodeTokens` |

These arrive in the browser with **zero plugin code**: the history tail page
carries a `projections` baseline block (`SessionProjectionsBlock{asOfSeq, values}`)
and live `session/projection` push frames update it under a higher-seq-wins
rule. Client components read them through the framework-standard
`useProjection(key)` seat.

### 2.4 Client framework

- `ctx.slots.register({name, id, order, locale?, label?, inject?, store?, children?}, Component)`
  — the modern registration: `locale:` declares a dictionary namespace and the
  framework synthesizes a typed `t` prop; `inject: (sessionId) => ({...})` is the
  registrant's per-session business face (incl. a `hooks:` compartment that
  becomes `use<Name>` selector hooks).
- `conversation.view` slot contract: `{kind:'list'; scope:'session'; owner:{inspect?, onInspectDone?}}` —
  view components receive the session standard kit: `sessionId`, `useSession`
  (ConversationSnapshot), `useSessions`, `useInput`/`inputActions`, and — via
  the runtime merge — `useProjection`.
- `useProjection(key)` / `useSession(selector)` are delivered to every
  session-scope slot component (`packages/client/web-react/src/scoped-slots.tsx`).
- Native context classification: `contextProvenance(source)` /
  `contextForm(source)` / `KnownContextForm` from `@deepseek-ai/dsh-client-runtime`
  (`sessions/context-provenance.ts`) map a logged `user/message` `source` to a
  role (`inject`/`recall`) and a human-facing producer label; `KnownContextForm =
  'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'` —
  exactly the vocabulary the plugin's `isInjection` + `form.*` i18n keys
  re-implement.
- Live conversation data: `ctx.sessions.binding(sessionId)`, snapshot store,
  `loadOlder()` history paging, `conversationEvents` / `conversationViews`
  registries, and `ConversationNodeDefinition`/`ConversationViewBuilder` — the
  trajectory view (`ui-trajectory`) is the reference implementation of a
  full tab built from the conversation event stream.
- Official context widgets already in the chat: `ContextMeter` ring
  (reads `contextPressure` + `contextBreakdown`) and `StatsLine`
  (reads `tokenUsage` + `sessionStats`).

### 2.5 Packaging / publishing

- `dsh.client` manifest (`inject`, `platform`, `immediately`) is still how a
  package ships a browser bundle (`@deepseek-ai/dsh-client-modules` composes the
  `__DSH_BOOT__` entry graph from `exports['./client']`).
- `dsh.bundle` + `cordis.patch.yml` still load the host row.
- The `@deepseek-ai/dsh-*` packages are now published to npm (`next` dist-tag,
  e.g. `@deepseek-ai/dsh-token-meter@0.1.0-rc.6`); the "broken npm type chains"
  the plugin's `src/host/services.ts` documents as its reason for local type
  declarations are largely resolved.

---

## 3. Verdict — what is still reasonable, what is not

### 3.1 Solid (keep)

- **Packaging**: `dsh.bundle` + `dsh.client` split, esbuild closure bundle, zero
  runtime deps — still the sanctioned way to ship a two-half plugin.
- **Fold design**: per-session incremental state resuming from `st.n`; bounded
  history (`MAX_REQUEST_STEPS`/`MAX_KEPT_TURNS`, trimmed by whole turns) — a
  correct and cheap replay discipline.
- **Defensive decoding** of event payloads (never trusts shapes), structured
  labels + client-side localization (i18n dictionaries exist for zh/en).
- **The shadow-price protocol** (`pendingShadowedSeqs`): the plugin reinvented
  the harness's `ShadowPriceClaim` correctly for the old event vocabulary.
- **Timeline attribution** (turn/step stamps on events, boundary ranges) and the
  chart/detail UX are genuinely additive — nothing in the harness renders a
  per-request context history.

### 3.2 Duplicated / re-implemented harness internals (replace)

| Plugin code | Harness equivalent | Notes |
| --- | --- | --- |
| `pricing.ts` (chars/token heuristic, block/role overhead, tools total, `firstText`, `toolCallNames`, `isInjection`) | `ctx.tokenMeter.estimateMessage` (public method) + the shipped projections | The plugin is *deliberately* a frozen copy of an older estimator; it has already drifted (e.g. source-kind vocabulary, empty-assistant pricing nuances, header delta removal). The six-color overview can reuse `contextBreakdown` (system/tools) and price the four surface categories through the meter. |
| `fold.ts` surface tracking + per-category sums + shadow pricing | `tokenMeter.measure()` + the projection units | The harness folds the same surface with validated `surfaceOp`/`sourceEventSeqs` — including `tool/result` rewrite rules the plugin does not know about. |
| `/dsh-context` custom RPC channel + endpoint | session projections (`tail-page baseline` + `session/projection` push frames) + the official `/api` session endpoints | A dedicated channel is no longer the idiomatic read path for derived session data; the projection pipeline is push, checkpointed, and cold-session-safe. |
| Client 2s polling + `cache.ts` stale-while-revalidate | browser projection store + `useProjection`; host `sessionProjectionCache` | Polling re-fetches unchanged state; the cache duplicates what the harness already persists/streams. |
| Hand-rolled locale wiring (`ctx.locale.bind`) + label thunk | `locale:` registration field → framework `t` prop | Same dictionaries, less plumbing; typed keys at registration time. |
| Hand-rolled `h()` React factories | shared `web-react`/slots component machinery + `ui-primitives` (Tooltip etc.) | Works today (the loader supplies React), but every official view is a real functional component; hooks (useProjection/useSession) can't be called from `h()` factories. |

### 3.3 Obsolete / drifted against the current event model

- **One real bug (found by the audit)**: `fold.ts:157` reads `block.callId` on
  the tool-result content block to attribute a node to its tool; the field is
  `toolCallId` (`ToolResultBlock.toolCallId`, also available as
  `message.source.callId`). Consequence: per-node tool labels for tool/result
  surface nodes never render. One-line fix — token math and bookkeeping are
  unaffected.
- `fold.ts` handles `user/message | tool/result | assistant/message |
  request/header | request/context | tool/call | assistant/chunk |
  compaction/summary | compaction/prune` — it **misses** `turn/start`,
  `turn/end` (+ reasons), `step/start`, `step/end`, `todo/write`,
  `session/end-seed`, `compaction/start`, `compaction/end`.
- `compaction/summary`/`prune` payloads now carry `compactionId`/`shadowedRange`
  (plus provider/model/usage); the plugin ignores them (works, but a compaction
  is better detected by its replacement `user/message` source
  `kind:'plugin', plugin:'compact'` — the chat's `isCompactCheckpointSource`).
- `tool/result` results can now be **rewritten** by later replace ops
  (`assertToolResultRewrite`) — the plugin's surface fold would double-count a
  pruned tool result's content if it ever meets a rewrite.
- The plugin's model/provider/contextWindow tracking duplicates
  `session.requestHeader()`/`session.requestContext()`.
- `sessionQuery.listEvents` now returns lightweight `SessionEventRecord[]`
  (metadata, not raw events); the plugin only probes `.length`, so it still
  works, but any future fold-from-listEvents would break.
- `ctx.connection.rpc.handle('/api', …)` is now rejected (reserved for
  `intercept`); the plugin's `/dsh-context` channel is unaffected.

### 3.4 Missed native data & mechanisms

- `contextPressure`/`contextBreakdown`/`tokenUsage`/`sessionStats` projections —
  free, exact-official figures for the overview card and stats board.
- `useProjection` / `useSession` framework seats — push instead of poll.
- Native injection classification (`contextProvenance`/`contextForm`/
  `KnownContextForm`) — replaces the plugin's own `isInjection` + `form.*`
  vocabulary with the harness's, so injection labels stay in sync with the chat.
- `turn/end` reasons (`max-tokens`, `error`, `aborted`) — valuable timeline
  annotations the plugin has no way to see today.
- `step/start`/`step/end` — precise per-step lifecycle (the plugin infers steps
  from `assistant/message`, so cancelled/failed steps are invisible).
- Compaction brackets (`compaction/start`/`compaction/end`, incl. `error`) and
  the compact-checkpoint source marker — richer compaction records than the
  plugin's summary-only view.
- Plugin configuration — the plugin has no `Config` at all; Cordis plugins read
  it as `apply(ctx, config)` with `static Config: z<Config>` (schemastery).

---

## 4. Target architecture (native-first)

```
┌─ Host half (install-time plugin row) ───────────────────────────────┐
│  inject: ['sessionProjections', 'tokenMeter']                        │
│                                                                     │
│  ctx.inject(['sessionProjections'], ctx => {                        │
│    ctx.sessionProjections.register(contextTimelineDefinition)       │
│    ctx.sessionProjections.register(contextStatsDefinition)          │
│  })                                                                 │
│                                                                     │
│  • pricing via ctx.tokenMeter.estimateMessage (no local copy)       │
│  • timeline/events/nodes = bounded state of pure projection units   │
│    (plain JSON, deterministic apply, stateVersion-bumped)           │
│  • aggregate stats reuse the shipped units (sessionStats,           │
│    tokenUsage); add only what they lack (recycled, injects,         │
│    switches)                                                        │
│  • optional Config read as apply(ctx, config) (schemastery):        │
│    caps, granularity, colors                                        │
└──────────────────────────────────────────────────────────────────────┘
                          │  session/projection push frames (+tail-page
                          │  baseline; persisted by sessionProjectionCache)
                          ▼
┌─ Client half (dsh.client bundle) ───────────────────────────────────┐
│  ctx.effect(() => ctx.locale.register(NS, { zh, en }))               │
│  const t = ctx.locale.bind(NS)                                       │
│  ctx.slots.inject('conversation.view', () => ctx.slots.register({    │
│    name: 'conversation.view', id: 'context', order: 20,              │
│    locale: NS,                                                       │
│    label: () => t('tab'),                                            │
│    inject: (sessionId) => ({ per-session hooks / verbs }),           │
│  }, ContextView))                                                    │
│                                                                     │
│  ContextView receives the session standard kit:                      │
│  • useProjection('contextPressure' | 'contextBreakdown' |            │
│                  'tokenUsage' | 'sessionStats' | 'contextTimeline'   │
│                  | 'contextStats', selector?, eq?)                   │
│  • useSession(conversation snapshot) for anything event-live         │
│  • sessionId, t (framework-synthesized)                              │
│  No polling, no custom RPC, no client-side cache, no manual locale.  │
└──────────────────────────────────────────────────────────────────────┘
```

Concrete projection units (one per concern, mirroring the harness's own split):

1. **`contextTimeline`** — bounded per-request records (`turn/step/time/seq` +
   the six category totals + provider prompt/output), the surface node list
   (capped, e.g. 200, preview text capped), and compaction/prune markers. View
   is exactly today's `Snapshot.requests/events/nodes` section. State is plain
   JSON and bounded exactly like `fold.ts` today (1500 steps / 300 turns).
2. **`contextStats`** — recycled tokens (compaction+prune sums), injection and
   model-switch counts, estimated totals, and the per-category current sums the
   six-color overview needs (the shipped `contextBreakdown` only splits
   system/tools/messages — the unit prices the four surface categories through
   `ctx.tokenMeter.estimateMessage` captured in its registration closure, and the
   client merges system/tools from `contextBreakdown`).
3. Keep `contextPressure`/`contextBreakdown`/`tokenUsage`/`sessionStats` from
   the harness — do not re-derive them.

Why projections win over a client-side conversation view for this plugin:

- The plugin's whole value is *full-session* analytics; a browser-side
  `ConversationViewBuilder` (the trajectory pattern) only folds the *loaded
  window* and must `loadOlder()` page by page — for very long sessions the
  whole log ends up shipped to the browser anyway.
- Projections are checkpointed per session on the host (survive resume, no
  re-fold), pushed as a baseline with the tail page (cold sessions need no
  extra read), and incremental (apply per committed event).
- The client stays a pure renderer of finished values — the exact division the
  harness documents.

The conversation-view route remains a valid *alternative* for a lighter,
window-scoped component (recipe: `ctx.conversationEvents.register(definition)`
per event family → `ctx.conversationViews.register({target, create})` →
component reads `useSession(s => s.views.get('context'))` and calls the injected
`loadOlder()`); it is the right choice if a future feature needs per-event
interactivity rather than whole-session analytics.

---

## 5. Migration plan (minimal-change, keep the UI green)

> **Status: Phases 0–3 landed (v0.9.0); Phases 4–5 open.**
> What shipped: the `toolCallId` tool-name fix; the fold moved into one
> `contextTimeline` session-projection unit (`src/host/timeline.ts` +
> `src/host/fold.ts`) registered on `ctx.sessionProjections` — the custom
> `/dsh-context` RPC channel, `src/host/snapshot.ts`, the per-session cache
> and the client 2s polling are deleted. The client reads the finished value
> through the framework standard `useProjection` seat, registered the modern
> way (`conversation.view` entry with `locale`). `zod` is now the plugin's one
> runtime dependency (wire schema); the `@deepseek-ai/*` types come from the
> published npm packages as devDeps. Retention was tightened to trim by whole
> turn-runs deterministically (bounded state, no 1200↔1500 oscillation).

Keep `docs/` screenshots semantics and tests passing at every step.

**Phase 0 — baseline (done)**: fix the one verified bug now (`fold.ts:157`:
`block.callId` → `block.toolCallId`, with `message.source.callId` as the
authoritative fallback) — one line, restores per-node tool labels. Bump the
dependency floor (Cordis/`@deepseek-ai/*` types as devDeps now resolve from npm
`next`); update `src/host/services.ts` type stubs to the current contracts (new
`SessionEventMap`, `surfaceOp`, `sessionProjections`, `listEvents` record
shape). Should otherwise be pure type-level work.

**Phase 1 — data path on host (done, merged with Phases 2–3)**: the fold now
*is* a projection unit (`contextTimeline`), so the "compatibility RPC reader"
was never needed — host and client shipped the new path together.

**Phase 2 — client reads projections (done)**: `ContextView` reads
`useProjection('contextTimeline')`; registration moved to the modern shape
(`locale:`); `cache.ts` and the poll effect deleted.

**Phase 3 — drop the channel (done)**: `/dsh-context` RPC + `connection` inject
removed from both halves; tests drive the projection units directly.

**Phase 4 — reclaim native data (open)**: annotate the timeline with `turn/end`
reasons, use `step/start`/`step/end` for true step lifecycle (failed/cancelled/
max-tokens steps), pocket `compaction/start`/`compaction/end` (incl. error) and
the compact-checkpoint `user/message` marker, classify injections through
`contextProvenance`/`contextForm`/`KnownContextForm`, and optionally surface
`todo/write`.

**Phase 5 — polish & config (open)**: add a `Config` read as `apply(ctx, config)`
(schemastery) for caps/colors; evaluate moving charts onto shared
`ui-primitives` (Tooltip), real functional components, and pricing through
`ctx.tokenMeter.estimateMessage`.

---

## 6. Risks / open questions

- **Projection payload size**: `contextTimeline` pushes its whole bounded view on
  each relevant event (like today's poll payloads, but event-driven). Bounds
  (steps/turns/nodes) should be configurable; per-turn aggregation on the host
  can shrink the default.
- **`stateVersion` discipline**: once persisted rows exist, every fold-semantics
  change must bump `stateVersion` (cache invalidation).
- **Token pricing parity**: replacing `pricing.ts` with the official estimator
  changes displayed numbers slightly (that is the point — reuse the same
  heuristic as the chat ring). The pure `estimate.ts` helpers are not a stable
  npm surface — price through `ctx.tokenMeter.estimateMessage` (and read
  system/tools from `contextBreakdown`) rather than importing internal subpaths.
- **Interaction with official context ring/StatsLine**: the chat already shows
  occupancy; the tab should stay additive (full timeline + events + messages),
  not repeat the ring.
- **Version floor**: projections and the `locale:`/`inject:` slot kit require a
  recent harness (`0.1.0-rc.6` era); state the minimum version in the README.

---

## 7. Sources

- Harness monorepo `~/dev/deepseek-harness` @ `47f943859b` (master) — all
  signatures quoted in §2; the companion audit `docs/CLIENT_SURFACE.md` is the
  full client-side surface report (compat table with all 14 client assumptions
  marked compatible; rows 3/4/7/9 recommended for upgrade).
- The host-side audit (services, event vocabulary, compaction protocol, host
  compat table incl. the one verified `(c)` bug) is incorporated into §2–§3.
- Published npm surface (`@deepseek-ai/dsh-*`, `next` dist-tag) cross-checked
  via the registry.