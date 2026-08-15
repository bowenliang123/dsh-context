# CLIENT_SURFACE — DeepSeek Harness client-side plugin surface (audit report)

Primary source: `/Users/bw/dev/deepseek-harness` (monorepo, `main`), read-only. Current-as-of-audit.
Files referenced are package-relative under that tree. The plugin under redesign is `dsh-context`
(`/Users/bw/dev/dsh-context`); its current client assumptions are listed in §7 with a compat verdict.

---

## 1. Client runtime services — `packages/client/runtime/src/client/*`

The browser runtime is mounted by `apply()` in `src/client/index.ts`: it registers `SlotRegistry`,
`ConversationEventRegistry` (`ctx.conversationEvents`), `ConversationViewRegistry`
(`ctx.conversationViews`), `SessionRuntime` (`ctx.sessions`), `WorkspaceRuntime`, and the connection
stream loop. Declared `Context` members (index.ts):

```ts
interface Context {
  slots: SlotRegistry
  conversationEvents: ConversationEventRegistry
  conversationViews: ConversationViewRegistry
  sessions: ISessions
  workspaces: IWorkspaces
}
```

### 1.1 `ctx.sessions` — `SessionRuntime` (service.ts) / `ISessions` (contract/sessions.ts)

The outward face is `ISessions` (`ctx.sessions` is the narrowed face; the concrete class stays internal):

```ts
export interface ISessions {
  /** useSessions standard feed (list rows + current selection). */
  readonly list: ObservableSnapshot<SessionListState>
  /** Atomic current-session provide projection (renderer host's `sessions.provideInfo` feed). */
  readonly currentProvideInfo: HostObservable<SessionMaybeProvideInfo>
  readonly searchResultLimit: number
  open(id: SessionId): void
  openSubagent(address: SubagentAddress): void
  subagentAddress(id: SessionId): SubagentAddress | undefined
  setSubagentCatalogOpen(parentSessionId: SessionId, open: boolean): void
  refreshSubagents(parentSessionId: SessionId): Promise<void>
  noteAgentPreset(sessionId: SessionId, agentPreset: string): void
  clear(): void
  search(query: string, signal: AbortSignal): Promise<RpcResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>>
  fork(opts: { sessionId: SessionId; atSeq?: number; increaseTitle?: boolean }): Promise<SessionId>
  provide(descriptor: SessionProvideDescriptor): () => void
  scope(id: SessionId): AgentContext | undefined
  scopeOf(ctx: Context): SessionId | undefined
  sessionOf(ctx: Context): SessionFace | undefined
  binding(id: SessionId): SessionBinding | undefined
}
```

`SessionListState` shape: `{ ids, byId: Record<SessionId, SessionSummary>, current?: SessionId, phase: 'pending'|'ready', subagentsByParent, jobsBySession, currentAddress }`.

**`binding(sessionId)`** resolves the stable, scope-addressed assembly feed:

```ts
export interface SessionBinding {
  readonly sessionId: SessionId
  /** The outward session face only — feature code never sees the concrete class. */
  readonly session: SessionFace
  readonly ctx: AgentContext
}
```

Resolution is pure (`binding()` does not open the window); scopes are minted lazily when the session is
*listed or current* (`eligible()`), and torn down when it leaves the list (the staged one survives
frozen until the stage moves). `SessionRuntime` is provided via `rootCtx.reflect.provide('sessions', this, undefined)`.

**`session` (SessionFace)** = `ISession & ObservableSnapshot<ConversationSnapshot>` (contract/session.ts).

```ts
export interface ISession {
  readonly sessionId: SessionId
  /** Host-computed projection values by key (the useProjection seat). */
  readonly projections: ProjectionsFace
  prompt(content: PromptContentPart[], mode: 'queue' | 'steer'): Promise<RpcResult<{ accepted: true }>>
  readAttachment(attachmentId: AttachmentIdType): Promise<RpcResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>>
  updateQueue(itemId: MessageId, action: QueueAction): Promise<RpcResult<{ accepted: true }>>
  cancel(): Promise<RpcResult<{ accepted: true }>>
  rename(title: string): Promise<RpcResult<{ title: string; seq: number }>>
  loadOlder(): Promise<void>
  command(line: string): Promise<RemoteResult<{ matched: boolean }>>
}
```

`ObservableSnapshot<ConversationSnapshot>` gives `subscribe(listener)` + `getSnapshot()` (uSES pair;
the `useSession` hook is the React binding, §4.3). The conversation snapshot carries:

- `sessionId`, `views: ConversationNodeAssembler` (a `ConversationViewSnapshotStore` — the per-session,
  per-target snapshots, read as `snapshot.views.get('<target>')`), `chat: ChatSnapshot`,
- `nodes`, `turnTimings`, `turnEnds`, `partial`, `runningCalls` (legacy chat view),
- `pending` (PendingInteraction[]), `queue`, `running`, `subagent`, `composerPhase: 'blank'|'engaging'|'active'`,
- `removed`, `openState: 'cold'|'loading'|'open'|'error'`, `openError`, `hasMore`, `loadingOlder`,
  `promptError`, `blank`, `lastAgentError`.

### 1.2 How live events arrive in the browser (manager.ts + session.ts + projection-store.ts)

Two transports: **history-window paging via unary RPC** (`session.history`, `PAGE_MESSAGES = 50` per
page; subagent sessions route to `subagent.history` through the stored address) and **push frames over
the mux WebSocket** (`/api/events.mux`). The mux frames (apiproxy `api/events.ts`) include
`session/event`, `session/subscribed`, `session/queue`, `session/jobs`, `session/projection`,
`approval/*`, `question/*`.

Tail-page baseline + projections (session.ts):

```ts
private async doOpen(generation: number): Promise<void> {
  ...
  let { result } = await this.history({ maxMessages: PAGE_MESSAGES })
  ...
  this.installWindow(result.value.events, result.value.hasMore, result.value.projections)
  // Gap detection: baseline past the window tail and liveBuffer did not cover it ->
  // pull the tail page once more.
  ...
}

/** Install the history window + stitch the liveBuffer (seq is the sole dedup key). ...
 * A carried projections block seeds the value store (higher seq wins, so a stale
 * baseline cannot overwrite a newer push frame); the window events themselves are
 * never folded — the host is the only computation site. */
private installWindow(entries: HistoryEntry[], hasMore: boolean, projections?: ProjectionsBaseline): void {
  this.events = entries.map(e => e.event)
  this.views = entries.map(e => e.view)
  this.baseSeq = this.events[0]?.seq ?? 0
  this.hasMore = hasMore
  if (this.events.some(event => event.type === 'turn/start')) this.firstPromptPendingTurn = false
  this.conversation.replaceWindow(entries.map(conversationInput), hasMore)
  if (projections !== undefined) this.projections.seed(projections)
  const buffered = this.liveBuffer
  this.liveBuffer = []
  for (const item of buffered) this.appendLive(item.event, item.view)
  this.notifier.markDirty()
}
```

Page-up (older history) with a continuity assertion:

```ts
/** Page up: pull one earlier page with the window's first seq as beforeSeq and prepend. */
async loadOlder(): Promise<void> {
  if (this.openState !== 'open' || !this.hasMore || this.loadingOlder) return
  ...
  const { result } = await this.history({ beforeSeq: this.baseSeq, maxMessages: PAGE_MESSAGES })
  ... // tail.seq + 1 must equal baseSeq; else drop the page fail-soft
  this.events = [...older.map(e => e.event), ...this.events]
  this.views = [...older.map(e => e.view), ...this.views]
  this.baseSeq = older[0]?.event.seq ?? this.baseSeq
  this.hasMore = result.value.hasMore
  this.conversation.prepend(older.map(conversationInput), this.hasMore)
}
```

Live `session/event` handling — buffered during open/stich, seq-deduped, gap-repaired:

```ts
/** Seq-guarded append shared by stitching and the open-state live path. */
private appendLive(event: SessionEvent, view?: ToolEventView): ConversationPublication {
  const tailSeq = this.windowTailSeq()
  if (tailSeq !== null && event.seq <= tailSeq) return 'none' // replay overlap, drop
  this.events.push(event)
  ...
  const publication = this.conversation.append({ event, view })
  return queueChanged ? 'immediate' : publication
}

private acceptLiveEvent(event: SessionEvent, view?: ToolEventView): void {
  if (this.openState === 'loading' || this.stitching) { this.liveBuffer.push({ event, view }); return }
  if (this.openState !== 'open') return
  const tailSeq = this.windowTailSeq()
  if (tailSeq !== null && event.seq > tailSeq + 1) { this.liveBuffer.push({ event, view }); void this.repairGap(); return }
  this.scheduleConversation(this.appendLive(event, view))
}
```

Frame dispatch in the manager — `session/projection` lands in the per-session value store even when
the Session is not instantiated, and `session/subscribed` truncates rows past the host's durable
baseline (manager.ts):

```ts
if (frame.type === 'session/projection') {
  // Finished host-computed value: land it in the resident store whether or
  // not the Session is instantiated (list rows read the 'title' key).
  this.projectionStore(frame.sessionId).apply(frame.key, frame.value, frame.seq)
  this.notifier.markDirty()
  return
}
...
if (frame.type === 'session/subscribed') {
  // Rows past the host's durable baseline rode state a restart lost; drop
  // them so last-wins cannot pin a phantom value over recomputed truth.
  this.projectionStores.get(frame.sessionId)?.truncate(frame.lastSeq)
  ...
}
```

The list refresh also seeds per-row projection values into the same stores (`manage(r).refreshList`):
`for (const s of result.value.items) { const block = s.projections; ... store.apply(key, values[key], block.asOfSeq) }`
— i.e. a row's `projections` block is a partial baseline applied key-by-key under higher-seq-wins.

**ProjectionValueStore (projection-store.ts)** — the push-model per-session value store; the host is
the only computation site:

```ts
export type UseProjection = {
  <K extends Extract<keyof SessionProjectionMap, string>>(key: K): SessionProjectionMap[K] | undefined
  <K extends Extract<keyof SessionProjectionMap, string>, S>(
    key: K,
    selector: (value: SessionProjectionMap[K] | undefined) => S,
    eq?: (a: S, b: S) => boolean,
  ): S
}

export class ProjectionValueStore {
  faceOf(key: string): ObservableSnapshot<unknown>          // identity-stable per key; absence = undefined snapshot
  get(key: string): unknown
  values(): Readonly<Partial<SessionProjectionMap>>         // frozen reference-stable map
  subscribeAny(listener: () => void): () => void
  apply(key, value, seq): void                              // higher seq wins; replays/stale frames drop
  seed(baseline: ProjectionsBaseline): void                 // tail-page / list block; absent key clears unless newer
  truncate(lastSeq: number): void                           // drop rows past a mux-generation baseline
}
```

The conversation snapshot never carries projection values; `useProjection` is a separate framework seat.

### 1.3 `useProjection(key)` / `session.projections.faceOf(key)`

`UseProjection` is injected as a **standard prop** on every session-scope slot component
(`SessionStandardProps.useProjection`, runtime index.ts). `session.projections` is the
`ProjectionsFace` (`faceOf(key)`) on the Session face — same store the hook reads. A key reads
`undefined` uniformly when the host unit is unmounted or no baseline/frame has carried it yet (that
is "capability absent", never an error).

**Projection keys — full `SessionProjectionMap` declaration-merge inventory** (each domain merges via
`declare module '@deepseek-ai/dsh-session-projection/types'`; the base table lives in
`packages/session/session-projection/src/types.ts` as `interface SessionProjectionMap {}`):

| key | domain package | value shape |
|---|---|---|
| `title` | `@deepseek-ai/dsh-session-title` (src/types.ts) | `string \| null` |
| `tokenUsage` | `@deepseek-ai/dsh-token-meter` (src/projection.ts) | `TokenUsageProjection { uncachedInputTokens; outputTokens; cacheReadTokens; cacheWriteTokens }` |
| `contextPressure` | `@deepseek-ai/dsh-token-meter` | `ContextPressureProjection { pressureTokens?; projectedTokens?; contextWindow? }` |
| `contextBreakdown` | `@deepseek-ai/dsh-token-meter` | `ContextBreakdownProjection { systemTokens; toolsTokens; messageTokens }` |
| `sessionStats` | `@deepseek-ai/dsh-session-stats` (src/types.ts) | whole-log turn/step counts + wall times |
| `plan` | `@deepseek-ai/dsh-plan-mode` (src/types.ts) | plan collaboration state |
| `todos` | `@deepseek-ai/dsh-tool-todo` (src/types.ts) | `TodoItem[] \| null` |
| `goal` | `@deepseek-ai/dsh-goal` (src/types.ts) | `GoalProjection \| null` |
| `permissions` | `@deepseek-ai/dsh-permission-presets` (src/types.ts) | permission select |
| `subagentTiming` | `@deepseek-ai/dsh-subagent` (src/projection-types.ts) | active-turn duration |
| `subagent` | `@deepseek-ai/dsh-subagent` | `SubagentIdentityProjection \| null` |

The token-meter merge, verbatim (`packages/llm/token-meter/src/projection.ts`):

```ts
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Provider-reported usage accumulated across the complete durable log. */
    tokenUsage: TokenUsageProjection
    /** Newest request pressure paired with the newest known route capacity. */
    contextPressure: ContextPressureProjection
    /** Heuristic system/tools/message composition of the next request. */
    contextBreakdown: ContextBreakdownProjection
  }
}
```

Note the two export conventions for a domain's client-safe types: the projection key merges must be
reachable **type-only** in the client program via a `/client` half (e.g. `@deepseek-ai/dsh-token-meter/client`
re-exports `./projection.ts`; `@deepseek-ai/dsh-session-title/client` re-exports its `./types`).

### 1.4 Conversation registries — `ctx.conversationEvents` / `ctx.conversationViews`

- `ConversationEventRegistry` (conversation/event-registry.ts) — registers
  `ConversationNodeDefinition`s; `register(definition)` keyed by `definition.kind` (duplicate kind
  throws), plus `registerFallback`. Returns an idempotent disposer. Lifecycle rides `owner.effect`,
  so plugin unload removes the definition.
- `ConversationViewRegistry` (conversation/view-registry.ts) — `register(definition)` keyed by
  `definition.target` (duplicate target throws).
- Both extend `ConversationDefinitionRegistry` (definition-registry.ts): `entries()` gives
  reference-stable Definitions in registration order; `subscribe(listener)` observes low-frequency
  registry changes. `SessionManager` rebuilds resident Session assemblers whenever these change
  (`rebuildConversationRegistry`).

**The contract** (contract/conversation.ts) — one Definition per event family:

```ts
export interface ConversationNodeDefinition<State = unknown> {
  readonly kind: string
  /** Sole view target owned by this Definition; omitted for state-only Contexts. */
  readonly target?: string
  /** Extract this Definition's stable business identity from one event. */
  match(event: SessionEvent): ConversationMatchResult | null   // { id, role: 'start' | 'update' }
  start(context: ConversationNodeContext<State>, match: ConversationMatch, reader: ConversationContextReader): State
  update(context: ConversationNodeContext<State> & { readonly state: State }, match: ConversationMatch): State
  publication?(match: ConversationMatch): ConversationPublication  // 'none' | 'animation-frame' | 'immediate'
  buildLocationData?(context, scope: 'step' | 'turn'): ConversationLocationData | null
  buildViewNode?(context: ConversationNodeContext<State>): ConversationViewNode | null
}
```

And the per-session, per-target builder — this is the "trajectory-style view":

```ts
export interface ConversationViewBuilder<Node extends ConversationViewNode = ConversationViewNode, Snapshot = unknown> {
  readonly empty: Snapshot
  /** Replace the low-frequency complete materialized Node set. */
  replace(input: { readonly nodes: readonly Node[]; readonly timeline: ConversationTimelineSnapshot }): Snapshot
  /** Apply only Nodes whose materialized values changed in this transaction. */
  apply(input: { readonly upserts: readonly Node[]; readonly timeline: ConversationTimelineSnapshot }): Snapshot
}

export interface ConversationViewDefinition<Node extends ConversationViewNode = ConversationViewNode, Snapshot = unknown> {
  readonly target: string
  /** @returns a new Session-owned incremental builder. */
  create(): ConversationViewBuilder<Node, Snapshot>
}
```

**The engine** (`ConversationNodeAssembler`, sessions/conversation-assembler.ts) is owned per
Session; `replaceWindow`/`append`/`prepend` feed it the contiguous event window; `flush()` runs
`definition.buildViewNode` per Context and hands each target's changed Nodes to that target's
builder (`view.snapshot = view.builder.replace({nodes, timeline})` on full rebuilds;
`view.builder.apply({upserts, timeline})` incrementally). It implements
`ConversationViewSnapshotStore`:

```ts
snapshot(target: string): unknown { return this.views.get(target)?.snapshot }
get<Target extends Extract<keyof ConversationViewSnapshotMap, string>>(target: Target): ConversationViewSnapshotMap[Target] | undefined
```

Reading side (the view component): `useSession(snapshot => snapshot.views.get('trajectory') ?? EMPTY_TRAJECTORY_SNAPSHOT)`
— see §2.4/§4.3.

**Recommended way to build a session-scoped view from live events** (the modern "trajectory" recipe):

1. `ctx.conversationEvents.register(definition)` for each business event family you render — pure
   `match`/`start`/`update` + `buildViewNode` (target = your view target, e.g. `'context'`);
   whole-value state preferred so it survives a window whose start is paged out.
2. `ctx.conversationViews.register({ target, create: () => new YourSnapshotBuilder() })` where the
   builder implements `ConversationViewBuilder` (`empty`/`replace`/`apply`) and folds Nodes to your
   view snapshot.
3. Register into `conversation.view` with `inject: (sessionId) => ({ ... , loadOlder: ... })`; the
   component reads `useSession(s => s.views.get('<target>'))` for the snapshot and `useSession(s =>
   s.loadingOlder / s.hasMore / s.openState)` for paging/loading state; call the injected
   `loadOlder()` (which routes to `session.loadOlder()`) for history paging.

## 2. Slot registration contract

### 2.1 `packages/client/ui-slots/src/index.ts` — the register() options and the SlotsService wrapper

`register` has two overloads (with/without `inject`); the options type:

```ts
type BaseOptions<K, EntryKey, D, H, M, N> = {
  name: K                                   // target slot key
  children?: D                              // child-slot declaration + render authorization + runtime spec
  store?: H                                 // store seat: shared handle or exclusive factory
  locale?: N                                // dictionary namespace; puts the typed `t` seat on props
  registrant?: string                       // diagnostics label
} & KindOptions<K, EntryKey, M>             // kind shape: keyed -> { key, priority? }; list -> { id, order?, label?, priority? }; chain -> { select, priority? }
```

- `label?: SlotLabel = string | (() => string)` — **thunk labels are read per-read via
  `resolveSlotLabel`**, so registration-time text (view tab labels) follows the active locale without
  re-registration. `order` (list) selects display sequence in the ring; `priority` (all kinds)
  selects cell shadowing (ascending, default 0, lowest renders).
- `locale` + `inject` are optional but load-bearing in the modern pattern: `locale` synthesizes the
  framework `t` seat typed to your namespace (`PropsLocale<N>`); `inject` is a factory
  `(...args: InjectParams<K, H>) => I` whose returned object is the registrant's business face; a
  reserved `hooks` compartment (`Record<string, HostObservable<unknown>>`) arrives on the component
  as bound `use<Name>` selector hooks (`InjectFace`), every other member passes through verbatim.
- Registering **into an undeclared slot throws**; declaring a child slot is "declaring is claiming"
  (only that entry may render it). List `id` is mandatory, keyed `key` mandatory, chain `select`
  mandatory. Duplicate (slot, cell, same priority) throws — shadowing requires a distinct `priority`.

The **SlotsService wrapper** (`packages/client/runtime/src/client/slots.ts`, class `SlotRegistry
extends Service`) adds: disposal through the caller's `ctx.effect` (`fiber unload = cascade`, which
also collapses declared children), the `registrant` diagnostic stamp, store-instance lifecycle, and
`inject`:

```ts
/**
 * Install an effect for each declaration lifetime of a slot. The callback runs synchronously
 * when the declaration already exists; otherwise it runs inside the declaring `register()` call
 * after the declaration is committed. Collapse disposes the effect and a later declaration runs it again.
 * @param key - declared SlotMap key to depend on.
 * @param callback - creates one disposer or an iterable of disposers.
 */
inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void
```

`ctx.slots.inject('conversation.view', () => ctx.slots.register({...}, Component))` is therefore the
correct "register a view tab now, whenever the slot gets declared" pattern: it waits for the slot's
declaration lifetime (by ui-conversation's `conversation.session` entry), registers inside it, and
unloads/re-registers per declaration lifetime. The runtime also exposes `entries(key)`,
`entriesOfSlot(key)`, `subscribe(key, fn)`, `getVersion(key)`, `spec(key)`, `snapshot()`,
`renderSlot('root', owner)` and the boot-once `install(renderer)` / `installLocale(face)`.

### 2.2 `conversation.view` declaration (packages/client/ui-conversation/src/client/contract/slots.ts)

```ts
/**
 * The conversation view ring: one list entry per view tab (chat here;
 * trajectory/waterfall from ui-trajectory), rendered one-at-a-time by
 * the session body via `only: <active id>`. Declared by this package's
 * body entry (declaring is claiming). Session scope: views read the
 * conversation snapshot through the standard kit.
 */
'conversation.view': { kind: 'list'; scope: 'session'; owner: ConvViewOwnerProps }
```

`ConvViewOwnerProps = { inspect?: { callId: CallId } | null; onInspectDone?: () => void }` — the only
owner-supplied props; everything else a view needs comes from the standard kit: `sessionId`,
`useSession` (conversation snapshot selector), `useProjection`, plus global `useSessions`,
`useWorkspaces` (`SessionStandardProps`/`GlobalStandardProps` merged in runtime index.ts). A
store-less pure reader can take `ConvViewProps = PropsRuntime<'conversation.view'>` alone.

**The full `conversation.*` slot list** (all declared in contract/slots.ts / apply.ts):

| slot | kind | scope | owner | purpose |
|---|---|---|---|---|
| `conversation.session` | single | session | — | the whole session body (replaces the view ring + draft) |
| `conversation.session.header` | single | session | — | the header strip |
| `conversation.session.header.actions` | list | session | `ConversationHeaderActionOwnerProps` | action-row buttons (additive) |
| `conversation.session.header.utilities` | list | session | `ConversationHeaderActionOwnerProps` | right-aligned utilities |
| `conversation.view` | list | session | `ConvViewOwnerProps` | **the view tab ring** (chat / trajectory / yours) |
| `conversation.chat.node` | keyed | session | `ChatNodeOwnerProps` | chat business node renderers (`ChatNodeKind`) |
| `conversation.chat.commandview` | keyed | session | `CommandRowOwnerProps` | per-command row hole |
| `conversation.chat.turnTail` | chain | session | `TurnTailOwnerProps` | completed-turn extension chain |
| `conversation.chat.assistant-actions` | list | session | `AssistantActionOwnerProps` | per-message action strip |
| `conversation.details.tool` | single | session | `DetailsToolOwnerProps` | details panel tool body |
| `conversation.composer` | chain | session | `ComposerChainProps` | composer takeover chain (approval panel is an entry) |
| `conversation.composer.bar` | single | session-maybe | `ComposerBarOwnerProps` | default composer body (InputBar) |
| `conversation.composer.dock` | list | session | `InputZone` | band under the composer card (StatsLine lives here) |
| `conversation.input.dock` | list | session | `InputZone` | full-width row above the card |
| `conversation.input.left` / `.right` | list | session | `InputZone` | composer tool-row ends |
| `conversation.input.plan` / `.model` | single | session | `InputControlOwnerProps` | named composer control seats |
| `conversation.hero.workspace` | single | root | `EmptyWorkspaceOwnerProps` | blank-session workspace picker |
| `conversation.hero.agentPreset` | single | root | `HeroAgentPresetOwnerProps` | agent-preset chip |
| `conversation.input.overlay` | list | session | (merged from ui-input-trigger) | floating overlay anchor content |

### 2.3 ui-conversation `apply.ts` — how the view ring is built

The ring is a plain projection of the slot ledger (`entries('conversation.view')` sorted by
`order`), exposed to the header/body as injected `views`:

```ts
const viewTabs = (): ViewTab[] => {
  const tabs: ViewTab[] = []
  for (const entry of slots.entries('conversation.view')) {
    if (entry.options.id === undefined) continue
    tabs.push({ id: entry.options.id, label: resolveSlotLabel(entry.options.label) ?? entry.options.id })
  }
  return tabs
}
const views = {
  list: viewTabs,
  subscribe: (fn: () => void) => slots.subscribe('conversation.view', fn),
  version: () => slots.getVersion('conversation.view'),
}
```

The header renders one tab button per `ViewTab` (in `entries` order = Order+Ascending); the body
renders the active entry only:

```tsx
// ConversationSession.tsx
const selectedId = useStore(s => s.view)
const active = resolveActiveView(tabs, selectedId)          // falls back to 'chat'
...
{active !== undefined && renderSlot('conversation.view', {
  inspect,
  onInspectDone: () => { actions.setInspect(null) },
}, { only: active.id })}
```

### 2.4 ui-trajectory — the modern registration pattern (quote it fully)

`packages/client/ui-trajectory/src/client/index.ts`, verbatim:

```ts
/**
 * Browser trajectory plugin contributing one entry to the conversation view
 * slot without defining a service.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createTrajectoryDurationStore } from './duration-store.ts'
import { en, NS, zh } from './locales.ts'
import { registerTrajectoryAssistantDefinition } from './trajectory-assistant-definition.ts'
import { registerTrajectoryCompactionDefinitions } from './trajectory-compaction-definition.ts'
import { registerTrajectoryMessageDefinitions } from './trajectory-message-definitions.ts'
import { registerTrajectoryRequestHeaderDefinition } from './trajectory-request-header-definition.ts'
import { registerTrajectoryConversationView } from './trajectory-snapshot-builder.ts'
import { registerTrajectoryToolDefinition } from './trajectory-tool-definition.ts'
import { TrajectoryView, type TrajectoryViewInjected } from './TrajectoryView.tsx'

/** Required services: the conversation slot, registries, ordinary Session paging, and the locale service. */
export const inject = ['slots', 'conversationEvents', 'conversationViews', 'sessions', 'locale']

/**
 * Client plugin body: register the trajectory view tab. The registration
 * rides the slot service's effect wrapper, so plugin unload removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-trajectory: dictionaries')
  // Registration-time text (the view tab label) reads through the bound
  // translate as a thunk, so it follows the active locale without
  // re-registration.
  const t = ctx.locale.bind(NS)
  const duration = createTrajectoryDurationStore()
  registerTrajectoryMessageDefinitions(ctx)
  registerTrajectoryRequestHeaderDefinition(ctx)
  registerTrajectoryAssistantDefinition(ctx)
  registerTrajectoryToolDefinition(ctx)
  registerTrajectoryCompactionDefinitions(ctx)
  registerTrajectoryConversationView(ctx)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'trajectory',
    order: 10,
    locale: NS,
    label: () => t('view.trajectory'),
    inject: (sessionId: SessionId): TrajectoryViewInjected => {
      const session = ctx.sessions.binding(sessionId)?.session
      if (session === undefined) {
        throw new Error(`ui-trajectory: session "${sessionId}" is unavailable`)
      }
      return {
        hooks: { duration },
        loadOlder: async () => {
          const before = session.getSnapshot().views.get('trajectory')
          await session.loadOlder()
          return session.getSnapshot().views.get('trajectory') !== before
        },
        setActualDuration: (value) => { duration.set(value) },
      }
    },
  }, TrajectoryView))
}
```

And the component reads its data through the standard kit + inject face
(TrajectoryView.tsx props line, and its data reads):

```ts
export function TrajectoryView({
  useSession, useDuration, loadOlder, setActualDuration,
  inspect, onInspectDone, t,
}: ConvViewProps & InjectFace<TrajectoryViewInjected> & PropsLocale<'trajectory'>) {
  ...
  const inspection = useSession(snapshot =>
    snapshot.views.get('trajectory') ?? EMPTY_TRAJECTORY_SNAPSHOT)
  const historyLoading = useSession(snapshot => snapshot.openState === 'loading')
  const olderHistoryLoading = useSession(snapshot => snapshot.loadingOlder)
  const hasOlderHistory = useSession(snapshot => snapshot.hasMore)
```

`TrajectorySnapshotBuilder` (trajectory-snapshot-builder.ts) is the `ConversationViewBuilder`
reference: `readonly empty = EMPTY_TRAJECTORY_SNAPSHOT`, `replace({nodes})` clears + re-keys,
`apply({upserts})` re-keys changed nodes and cheap-positions; exported factory
`trajectoryViewDefinition: ConversationViewDefinition = { target: 'trajectory', create: () => new TrajectorySnapshotBuilder() }`,
registered via `ctx.conversationViews.register(trajectoryViewDefinition)` (a `ctx.effect`-installed
call in the definition-registry does the disposal automatically).

## 3. Official context widgets

### 3.1 `skeleton/ContextMeter.tsx` — data flow (all from projections, nothing local)

```tsx
export interface ContextMeterProps {
  useProjection: UseProjection
  /** The owning bar's locale seat, passed down as a plain prop. */
  t: ComposerBarProps['t']
}

export function ContextMeter({ useProjection, t }: ContextMeterProps) {
  const pressure = useProjection('contextPressure')
  const breakdown = useProjection('contextBreakdown')
  ...
  const context = contextOccupancy(pressure)      // { percent, usedTokens, contextWindow } | null
  const available = context !== null
  ...
  if (context === null) return null
  // breakdown proportions are heuristic shares of the provider-exact percent:
  const breakdownTotal = breakdown === undefined ? 0
    : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
  ...
}
```

`contextOccupancy` (chat/StatsLine.tsx): numerator prefers `projectedTokens` (the provider sample
carried forward over surface movement) and falls back to `pressureTokens`; `undefined` until both
numerator and `contextWindow` exist; percent clamps at 100. It requires the `contextPressure` and
`contextBreakdown` key merges type-only (`import type {} from '@deepseek-ai/dsh-token-meter/client'`).

### 3.2 `chat/StatsLine.tsx` — the token line

Registered on `'conversation.composer.dock'` (`id: 'stats', order: 0`). It reads **three** feeds:

```tsx
export const StatsLine = memo(function StatsLine({ useSession, useProjection, t }: StatsLineProps) {
  const settledNodes = useSession(s => s.chat.legacy.nodes)
  const usage = useProjection('tokenUsage')
  // Every figure rides the durable sessionStats projection, so paging and
  // compaction cannot change any of them; an assembly without the unit falls
  // back to the window-scoped fold wholesale (same field names), paid only
  // while no projection value is served.
  const projected = useProjection('sessionStats')
  const stats = useMemo(() => projected ?? deriveStats(settledNodes), [projected, settledNodes])
  ...
  if (usage !== undefined && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
    const cacheHit = cacheHitPercent(usage)          // cacheRead / (uncached+cacheRead+cacheWrite)
    if (cacheHit !== null) groups.push(t('stats.cacheHit', { percent: cacheHit }))
    groups.push(t('stats.tokens', {
      input: formatTokens(billedInputTokens(usage)),   // uncachedInput + cacheRead + cacheWrite
      output: formatTokens(usage.outputTokens),
    }))
  }
```

### 3.3 `packages/client/web-react` — the snapshot/selector hook bindings

`bind.ts` — the ONE hook constructor in the client stack:

```ts
export function bindSnapshotSelector<T>(w: HostObservable<T>): SnapshotSelectorHook<T> {
  const subscribe = (fn: () => void) => w.subscribe(fn)
  const getSnapshot = () => w.getSnapshot()
  return function useSelector<S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean): S {
    return useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, sel, eq)
  }
}
```

`session-provider.tsx` — `observableHook(source)` binds bare observables with a per-source identity
cache (one uSES subscription per source); `projectionHook(info)` builds the `useProjection` seat per
provide bundle: `observableHook(info.projections?.faceOf(key) ?? absentSource)` so an absent key
still runs the selector over `undefined` with a stable subscribe reference. The renderer host
(`host.sessions.provideInfo`) is the atomic current bundle; `SessionProvider`/`SessionMaybeProvider`
bridge selection into React and remount session subtrees with `key={sessionId}`.

## 4. Locale + connection client halves

### 4.1 `packages/client/locale` — `ctx.locale` (LocaleRuntime, client/index.ts)

```ts
register<N extends keyof LocaleNamespaceMap & string>(ns: N, dicts: Record<LocaleId, LocaleDictOf<N>>): () => void
register(ns: string, locale: string, dict: LocaleDict): () => void        // untyped form
bind<N extends keyof LocaleNamespaceMap & string>(ns: N): TranslateNS<N>    // identity-stable; typed or untyped
subscribe(fn: () => void): () => void                                       // LocaleFace half
getSnapshot(): LocaleSnapshot
getLocale(): LocaleSnapshot
setLocale(id: string): void
```

- `LocaleNamespaceMap` is the merge-extensible namespace table (declared + lexical-merged in
  ui-slots `src/index.ts`). Keys: `common` and `settings.locale` come from the locale plugin itself;
  ui-conversation merges `conversation`, ui-trajectory merges `trajectory`, etc.
- Lookup chain per key: **entry namespace (active) → entry namespace (zh fallback) → `common`
  (active, then zh) → the key itself** (missing text stays visible, no blank).
- `register(ns, {zh, en})` requires **every shipped locale** in the typed form and throws on
  duplicate `(ns, locale)`; the disposer removes the dictionaries. Registration bumps the revision
  (render refresh via LocaleFace); only `setLocale` emits `locale/change`.
- The service IS the `LocaleFace` (`bind` + `getSnapshot`/`subscribe`), installed via
  `ctx.slots.installLocale(locale)` — that is how the renderer synthesizes the standard `t` seat.
  `ctx.locale.bind(NS)` bound at apply time is the recommended way to get registration-time text
  (tab labels); in-component text uses the injected `t` prop (declared `locale:` on the entry).
- Typed namespaces compile-check dictionary key unions; a JS bundle (like dsh-context's) uses the
  untyped overloads only — same runtime semantics.

### 4.2 `packages/client/connection` — the client wire surface

`ctx.connection` (`ConnectionHandle`): `{ api: IApiClient, isLoopback, hostDescription, rpc, start(sinks, config) }`.

- **`rpc.call`** (client/rpc.ts) — generic logical-RPC channel caller:

```ts
export interface ClientConnectionRpc {
  call(
    channel: string,      // absolute logical channel such as '/api' or '/dsh-context'
    endpoint: string,     // channel-relative endpoint such as 'snapshot' (also 'goals/create')
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<RpcResult<unknown>>
}
```

`createWebConnectionRpc()` POSTs `{type:'client-request', rpcId, method: endpoint, payload}` to
`<origin>/<channel>/<endpoint>` and validates the server response envelope (strict channel
`/^\/[A-Za-z0-9._~-]+$/` and endpoint segment whitelist). **There is no `rpc.intercept` on the
client side** — `intercept` exists only on the Host registry (`HostConnectionRpc.intercept(channel:
'/api', ...)`), and a plugin's host half registers its own channel with
`ctx.connection.rpc.handle(channel, handler, { authority: 'trusted-host' | 'loopback' })`
(rpc.ts + rpc-host.ts). So a host/client plugin pair like dsh-context's `/dsh-context` channel is
fully supported: host half `handle('/dsh-context', ...)` (authority `'trusted-host'`), client half
`rpc.call('/dsh-context', 'snapshot', {sessionId})`.
- **Downlinks**: unary/respond go over fetch at `/api/<method>`; the two event streams are
  downlink-only WebSockets, `ws(s)://<origin>/api/events.mux` and `/api/events.host`
  (api-path.ts + web-api-client.ts), consumed by the runtime's ConnectionController
  (`connection.start({onMuxEnvelope, onHostEnvelope, onConnected, onStateChange})`). Plugins consume
  live data through the object layer (`ctx.sessions`) and projections, not the sockets directly.
- **Other official client channels**: the typed `ApiProxy` namespaces (`ctx.connection.api`) —
  the apiproxy `RpcMethodMap` (packages/host/apiproxy/src/api/rpc-map.ts), the full official `/api`
  RPC surface:

```
session.list | session.search | session.create | session.history | session.models |
session.selectModel | session.rename | session.fork | session.prompt | session.attachment |
session.updateQueue | session.cancel
subagent.list | subagent.history | subagent.prompt | subagent.interrupt
host.describe | host.pickDirectory | host.listDirectory | host.createDirectory | host.openPath
workspace.list | workspace.create | workspace.rename | workspace.delete | workspace.insertBefore |
workspace.insertSessionBefore | workspace.archiveSession
skill.list | agentPreset.list/select/read/copy/openDocument/remove
goal.create/edit/pause/resume/complete/clear
settings.describe/openDocument/update/replace/mutate
credentials.describe/set/unset | llm.providers/models/discoverModels
```

`session.history` returns `{ events: HistoryEntry[]; hasMore: boolean; projections?: SessionProjectionsBlock }`
(the tail page carries the projections baseline). Plus generated **Remotes** via `ctx.remote`
(api-remotes `/client`): drawn from `@deepseek-ai/dsh-* /remote` contributions — e.g.
`commands.execute` (application), `goals`, `pluginInventory`, `messageFeedback`. Host cordis events
forward verbatim to `ctx.remote.$on` only when allowlisted (api-remotes
`API_REMOTE_FORWARDED_EVENTS`).

## 5. Packaging — how a plugin ships a client bundle

Node half: `packages/client/modules/src/index.ts` (`ClientModuleRegistry`). A package joins the web
table by declaring, in package.json:

```json
"dsh": { "client": { "inject": ["..."], "platform": "web", "immediately": true } }
```

Validated fields (index.ts):

```ts
interface DshClientDeclaration {
  inject?: string[]      // package-name dependency edges (informational graph metadata / boot preflight)
  platform: string       // must be 'web'
  immediately?: boolean  // stage-one prefetch of the bundle; absent = lazy, fetched on first import
}
```

plus `exports["./client"]` resolving to the built bundle (string, or `{ default: string }`):
`clientExportOf` reads `exportsField['./client']`, falling back to `.default`. The bundle is served
at `/plugins/<id>/client.js?rev=<hash>` (`no-cache`; GET/HEAD only; unknown id → loud 404), and the
graph is injected as `window.__DSH_BOOT__` (`{rev, entries: [{id, url, rev, inject?, immediately?}]}`)
as the first `<head>` script. Docs: `docs/subsystems/client-modules.md` (the subsystem page, incl.
HMR via dsh-client-hmr) and `docs/user/develop/basic/publish.md` (bundle/profile manifests —
`dsh.bundle.patch` against `dsh.profile.bundles`; `dsh.client` is the web half of that same
package.json `dsh` key).

The bundle's own contract (browser half `packages/client/modules/src/client/*`):

- `window.__ModuleLoader__.load({ id, factory })` where `factory: (require) => Record<string, unknown>`
  — the require resolves seed words → static modules → memoized records → registered factories
  (cross-plugin **value** imports between bundles are forbidden: "a build-time externals drift");
  `@deepseek-ai/*` packages are inlined into the consumer bundle (plugin-to-plugin value imports are
  flagged as "bundle purity errors").
- The materialized `module.exports` is read by the vendored Loader as a cordis plugin module —
  `{ name, inject: string[], apply(ctx) }` (`inject` = required-service names resolved against the
  fiber graph; graph `inject` edges are informational). dsh-context's bundle already uses exactly
  this shape.
- Styles: the module host claims `<style data-plugin="…">` tags on materialization
  (`claimStyles`), and plugin-owned tags are removed on invalidate/unload — the dsh-context
  `data-plugin` injection (§7) is the documented mechanism (tags are claimed into the record's
  `styles` list; `data-plugin-css` values tracked for HMR).

## 6. Recommended re-architecture for dsh-context (summary of the official path)

- Keep registering a tab into `'conversation.view'` (`id: 'context'`, `order: 20`), but use the
  full modern options: `locale: NS` + `label: () => t('...')` thunk + `inject: (sessionId) =>
  ({ hooks: {...}, ... })` — the trajectory pattern (§2.4) verbatim.
- Replace the 2s `rpc.call` polling with either (a) **push projections**: register a host
  `ProjectionDefinition` per context key (see `docs/subsystems/session-projection.md` — framework
  drives `apply` over committed events; the client just `useProjection('yourKey')`), or (b) a
  **conversation view target**: `ctx.conversationEvents.register(...)` +
  `ctx.conversationViews.register({target, create})` read via
  `useSession(s => s.views.get('target'))` — live events arrive by mux push and the per-session
  assembler rebuilds your snapshot; `loadOlder()` pages history.
- Read official context data directly: `useProjection('contextPressure' | 'contextBreakdown' |
  'tokenUsage' | 'sessionStats' | 'title')` — no client-side folding; the host computes.
- Get the session binding in `inject` via `ctx.sessions.binding(sessionId)?.session` for verbs
  (`loadOlder`, `command`, `rename`, …); components read state through `useSession`/`useProjection`
  standard props, never through the binding in render.

---

## 7. Compatibility table — dsh-context client assumptions vs. current reality

Current dsh-context client facts (src/client/{index,services,i18n,viewkit,styles}.ts + lib/client.js):
`ctx.slots.inject('conversation.view', () => ctx.slots.register({name, id, order, label}, props => h(...)))`;
`ctx.locale.register('dsh-context', {zh, en})` + `ctx.locale.bind('dsh-context')` + `locale.subscribe(() =>
setTick)`; `ctx.connection.rpc.call('/dsh-context', 'snapshot', {sessionId})` polled every 2s;
`<style data-plugin="dsh-context">` injection; bundle =
`window.__ModuleLoader__.load({id, factory})` with `module.exports = { name, inject, apply }`;
component = hand-rolled `h()` factories over `require('react')`; props typed `{sessionId?: string}`.

| # | dsh-context assumption | Current reality | Verdict |
|---|---|---|---|
| 1 | `ctx.slots.inject('conversation.view', cb)` — `SlotsService.inject(key, callback)` returns disposer, callback may return a disposer | `SlotRegistry.inject(key, cb)` exists verbatim (runtime slots.ts §2.1); effect per declaration lifetime, unload-cascade | **compatible** |
| 2 | `ctx.slots.register({name,id,order,label}, component)` — list-kind options into a declared slot | `register` typed overloads unchanged; list requires `id`; `order` sorts the ring; `label` may be a thunk (`SlotLabel`, resolved by `resolveSlotLabel`) | **compatible** |
| 3 | register without `locale:` — component gets no `t` prop, uses closure `ctx.locale.bind` instead | `locale` is optional; omitting it just skips the typed `t` seat. Modern pattern adds `locale: NS` + `inject` (§2.1, §2.4) — a strict improvement, not a requirement | **compatible** (obsolete-but-harmless; upgrade recommended) |
| 4 | register without `inject:` — `(props) => h(ContextView, props)`, reading `props.sessionId` | `inject` optional; component still receives standard kit (`sessionId`, `useSession`, `useProjection`, `useSessions`, `useWorkspaces`) + owner share (`inspect`, `onInspectDone`). Extra props are ignored by destructuring | **compatible** (redesign should switch to `inject` + standard hooks) |
| 5 | `ctx.locale.register('dsh-context', {zh, en})` untyped | Untyped overload exists with identical semantics; disposer idempotent; duplicate (ns,locale) throws | **compatible** |
| 6 | `ctx.locale.bind('dsh-context')` — stable translate, lookup chain ns→zh→common→key | Identical (`LocaleRuntime.bind` caches per namespace; `translate` falls back to `common` then key) | **compatible** |
| 7 | `ctx.locale.subscribe(fn)` for in-component locale re-render | `LocaleRuntime.subscribe` exists (LocaleFace half); note dictionary regs and locale switches both bump revision → listener fires. Modern pattern: `locale:` seat re-renders via LocaleFace without manual subscribe | **compatible** (manual subscribe works; seat is cleaner) |
| 8 | `ctx.connection.rpc.call('/dsh-context', 'snapshot', {sessionId})` | `ClientConnectionRpc.call(channel, endpoint, payload, signal?)` unchanged; wiring to the host channel requires host-half `ctx.connection.rpc.handle` (present in dsh-context's host half) | **compatible** |
| 9 | 2s polling of a snapshot RPC to animate the context tab | Mechanics work, but the harness is push-first: `session/event` mux frames + `session/projection` frames + per-target conversation views deliver the same data with zero polling; the official ContextMeter/StatsLine never poll. Polling is redundant work, drifts from `seq` reality, and duplicates what `useProjection`/`useSession` give | **obsolete-but-harmless** (works; replace with push in the redesign) |
| 10 | Styles injected as `<style data-plugin="dsh-context">` + manual removal in `ctx.effect` cleanup | The module host's `claimStyles` explicitly supports pre-tagged `style[data-plugin=...]`; owned tags are removed on plugin invalidate/unload (packages/client/modules/src/client/system.ts §5) | **compatible** (official mechanism) |
| 11 | Bundle = `window.__ModuleLoader__.load({id, factory})`; `factory(require)` returns `module.exports = { name, inject, apply }` | Exact `ClientPluginHandoff` shape (manifest.ts §5); factory `require` resolves the module table; `{name, inject, apply}` is the cordis plugin module contract; `react` is a seed word supplied by the shell | **compatible** |
| 12 | `inject: ['connection', 'slots', 'locale']` in the bundle exports | All three services still exist (`ctx.connection`, `ctx.slots`, `ctx.locale`); package.json `dsh.client.inject` additionally lists `@deepseek-ai/dsh-client-connection`, `-locale`, `-runtime`, `-ui-conversation` as graph edges — all still valid package names | **compatible** |
| 13 | Component props typed `{sessionId?: string}` via `h()` factories over `require('react')` | Standard props include the branded `sessionId`; `h = React.createElement` unchanged; React 18 via seed module | **compatible** |
| 14 | `ctx.slots.inject`/`locale.register` wrapped in `ctx.effect(...)` | Consistent with the framework (effect wiring, disposal on fiber stop/HMR) | **compatible** |

**Compatibility summary**: every dsh-context client-side assumption is still on the live surface —
nothing is broken. The redesign should *upgrade* §7 rows 3/4/7/9 to the official pattern:
`locale:` seat, `inject:` face (hooks compartment + `loadOlder`), standard `useSession`/`useProjection`
hooks, and push-driven data (projections and/or a conversation view target) instead of 2s polling.