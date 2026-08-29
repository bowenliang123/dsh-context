# dsh-context

A DeepSeek Harness plugin for context insight, actions, and management.

## Background

- DeepSeek Harness:
  - an open-source agent harness developed by DeepSeek AI.
  - Dive deep in to the code when you are preparing for development
  - Github: deepseek-ai/deepseek-harness
  - NPM: @deepseek-ai/dsh
  - Local git clone of [dsh](https://github.com/deepseek-ai/deepseek-harness):
    - may be found in the `~/dev/deepseek-harness` directory
    - `git pull` on the `main` branch to update
    - commits and tags are available for reference and comparison
    - run `pnpm install` to update dependencies after a `git pull` or switching commit/tag

- DeepSeek Harness Plugin:
  - docs:
    - Reference: https://deepseek-harness.github.io/deepseek-harness/en/reference/
  - Example plugins:
    - Available on GitHub topic `dsh-plugin`: https://github.com/topics/dsh-plugin

## 强制要求
- **必须** 使用codegraph来对代码进行探索和理解，在调查代码、确认属于、文件细节、代码结构等，不管是前期调研还是事中还是事后。codegraph查询和更新性能很高、耗时特别少，能大幅加快探索代码的速度，尽量多用、并发用。
  - Example 1:
    Run `pnpm dlx @colbymchenry/codegraph explore --path /path --max-files 10000 "What's Context Stats?"`
    Result:
      =============
      **Exploration: What's Context Stats?**
        
        Found 9 symbols across 2 files.
        
        **Blast radius — what depends on these (update/verify before editing)**
        
        - `makeContextView` (src/client/components/contextView.tsx:43) — 4 callers in `src/client/index.ts`; tests: `tests/client/components/contextView.spec.ts`
          - `makeContextModal` (src/client/components/contextModal.tsx:26) — 3 callers in `src/client/index.ts`; tests: `tests/client/components/contextModal.spec.ts`
          - `makeContextJumpButton` (src/client/components/contextJump.tsx:56) — 3 callers in `src/client/index.ts`; tests: `tests/client/components/contextJump.spec.ts`
        
        **Source Code**
        
        > The code below is the **verbatim, current on-disk source** of these files — re-read from disk on this call and line-numbered, byte-for-byte identical to what the Read tool returns. It is NOT a summary, outline, or stale cache. Treat each block as a Read you have already performed: do not Read a file shown here. (Exception: files flagged "⚠ changed on disk" below drifted from the index after their last sync — their source is omitted rather than risk a mis-sliced block; Read those specific files.)
        
        **`src/client/components/contextView.tsx`** — ⚠ changed on disk after the last index sync — source omitted (indexed line ranges no longer match, so a slice could show the wrong code). Read this file directly for current content; the change is picked up on that project's next index sync.
        
        **`src/client/components/contextModal.tsx`** — makeContextModal(function), ContextModal(function), ContextModalBody(function), ContextModalProps(interface)
        
        ```tsx
        1       /**
        2        * The /context command's centered dialog — the same data as the Context tab (the pushed `contextTimeline` projection) distilled to the
        3        * current-composition overview and the shared Context browser; rendered from the `conversation.input.overlay` slot and opened/closed
        4        * through the per-session modal store, so the trigger flips it and no message ever enters session history.
        5        */
        6       
        7       import type * as ReactNS from 'react'
        8       import { headlineOf } from '../headline'
        9       import { modalStoreOf, takePendingConsume } from '../modalStore'
        10      import type { ClientCtx, SessionStandardProps, SessionsFace } from '../services'
        11      import { contextBreakdownOf, contextPressureOf, conversationNodesOf, headersOf, timelineOf } from '../services'
        12      import { makeContentFetcher } from '../historyPage'
        13      import type { ViewKit } from '../viewkit'
        14      import { makeContextBrowser } from './browser'
        15      import { makeCurrentComposition } from './currentComposition'
        16      import { makeErrorBoundary } from './errorBoundary'
        17      import { makeLegend, makeStackedBar } from './stackedBar'
        18      
        19      import { React, h } from '../react'
        20      
        21      export interface ContextModalProps extends SessionStandardProps {
        22        /** Bound selector hook over the per-session open flag (hooks compartment). */
        23        useContextModal?: (sel: (open: boolean) => boolean) => boolean
        24      }
        25      
        26      export function makeContextModal(ctx: ClientCtx, kit: ViewKit): (props: ContextModalProps) => ReactNS.ReactElement | null {
        27        const { t } = kit
        28        const StackedBar = makeStackedBar(kit)
        29        const Legend = makeLegend(kit)
        30        const CurrentComposition = makeCurrentComposition(kit, StackedBar, Legend)
        31        const ContextBrowser = makeContextBrowser(kit, StackedBar)
        32        const ErrorBoundary = makeErrorBoundary(t)
        33      
        34        function ContextModalBody(props: ContextModalProps): ReactNS.ReactElement | null {
        35          const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
        36          const open = typeof props.useContextModal === 'function' ? props.useContextModal(s => s) : false
        37          const data = typeof props.useProjection === 'function'
        38            ? timelineOf(props.useProjection('contextTimeline'))
        39            : null
        40          const pressure = typeof props.useProjection === 'function'
        41            ? contextPressureOf(props.useProjection('contextPressure'))
        42            : null
        43          const breakdown = typeof props.useProjection === 'function'
        44            ? contextBreakdownOf(props.useProjection('contextBreakdown'))
        45            : null
        46          const headers = typeof props.useProjection === 'function'
        47            ? headersOf(props.useProjection('contextHeaders'))
        48            : null
        49          // Conversation-window join for the browser (both seats are hooks — read
        50          // unconditionally here, before the closed early return, so the hook order
        51          // stays stable across open/close).
        52          const convNodes = conversationNodesOf(props)
        53          const [hoverCat, setHoverCat] = React.useState<string | null>(null)
        54          // Same targeted content fetch the Context tab wires (one seq-anchored history read per expanded row).
        55          const fetchContent = React.useMemo(
        56            () => (sessionId !== '' ? makeContentFetcher(ctx, sessionId) : undefined),
        57            [ctx, sessionId],
        58          )
        59      
        60          const close = React.useCallback(() => {
        61            if (sessionId === '') return
        62            modalStoreOf(sessionId).set(false)
        63            // Consume the `/context` token now (it stayed in the composer while the modal was open) via the scoped input event — a stale guard
        64            // (the user typed meanwhile) fails soft inside the shell and leaves the draft untouched. The sessions service is read at CLOSE time:
        65            // capturing it at apply would race the finer 0.1.2 module composition (`ctx.get` is the inject-free reflect read — undefined, never a
        66            // throw, when the service is not composed).
        67            const guard = takePendingConsume(sessionId)
        68            const sessions = ctx.get('sessions') as SessionsFace | undefined
        69            if (guard === undefined || sessions === undefined) return
        70            const scope = sessions.scope(sessionId)
        71            if (scope !== undefined) scope.bail(scope, 'slash/input-consume-token', { guard })
        72          }, [ctx, sessionId])
        73      
        74          React.useEffect(() => {
        75            if (!open) return undefined
        76            const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
        77            const onKey = (ev: KeyboardEvent) => {
        78              if (ev.key !== 'Escape') return
        79              ev.preventDefault()
        80              ev.stopPropagation()
        81              close()
        82            }
        83            window.addEventListener('keydown', onKey, true)
        84            return () => {
        85              window.removeEventListener('keydown', onKey, true)
        86              if (previous !== null && document.contains(previous)) previous.focus()
        87            }
        88          }, [open, close])
        89      
        90          if (!open) return null
        91      
        92          const head = data !== null ? headlineOf(data, pressure, breakdown) : null
        93          const subtitle = data !== null ? (data.model ? data.model : '') + (data.provider ? ' · ' + data.provider : '') : ''
        94      
        95          return (
        96            <div className="lc-modal-backdrop" onClick={close}>
        97              <div className="lc-modal-card" onClick={(ev) => { ev.stopPropagation() }}>
        98                <div className="lc-modal-head">
        99                  <span className="lc-modal-title">{t('tab')}</span>
        100                 <button className="lc-modal-close" aria-label={t('cmd.close')} onClick={close}>×</button>
        101               </div>
        102     
        103               {data === null || head === null ? (
        104                 <div className="lc-empty">{t('loading')}</div>
        105               ) : (
        106                 <div>
        107                   <CurrentComposition
        108                     head={head}
        109                     subtitle={subtitle}
        110                     hoverKey={hoverCat}
        111                     onHoverKey={setHoverCat}
        112                   />
        113                   <ContextBrowser
        114                     data={data}
        115                     headers={headers}
        116                     convNodes={convNodes}
        117                     fetchContent={fetchContent}
        118                     hoverKey={hoverCat}
        119                     onHoverKey={setHoverCat}
        120                   />
        121                 </div>
        122               )}
        123             </div>
        124           </div>
        125         )
        126       }
        127     
        128       return function ContextModal(props: ContextModalProps): ReactNS.ReactElement | null {
        129         return h(ErrorBoundary, null, h(ContextModalBody, props))
        130       }
        131     }
        ```
        
        **`src/client/components/contextJump.tsx`** — makeContextJumpButton(function), ContextJump(function), JumpIcon(function), ContextJumpProps(interface), seqOfMessageId(function)
        
        ```tsx
        1       /**
        2        * The assistant-message action that jumps to the Context tab at this reply's
        3        * turn. Registered on the harness `conversation.chat.assistant-actions` seat
        4        * (the icon row beside copy/branch), it receives the finalized reply's durable
        5        * message id, resolves the matching assistant node's seq off whichever node
        6        * seat the running harness serves (`useChat` on 0.1.2+, the session snapshot
        7        * before it), records it in the viewFocus relay, and activates the Context
        8        * tab — where the jump pins the reply's TURN (see contextView's leg 2). An
        9        * unresolvable seq still switches tabs, just without a pin; a message id that
        10       * is not a plain string renders nothing at all.
        11       */
        12      
        13      import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
        14      import type * as ReactNS from 'react'
        15      import type { ConversationNodeLike, UseChatLike, UseSessionLike } from '../services'
        16      import { conversationNodesOf } from '../services'
        17      import { React } from '../react'
        18      import { activateContextTab, requestContextFocus } from '../viewFocus'
        19      import type { ViewKit } from '../viewkit'
        20      
        21      /** The assistant-action seat's currency, as far as this button consumes it. */
        22      export interface ContextJumpProps {
        23        messageId?: unknown
        24        sessionId?: unknown
        25        useChat?: UseChatLike
        26        useSession?: UseSessionLike
        27      }
        28      
        29      /**
        30       * The reply's request seq by its durable message id, or null when no served node proves the pair. Join/log nodes are untrusted input: each
        31       * element is isolated, so one hostile object that throws on property access is skipped — the jump keeps its pin, never its click.
        32       */
        33      export function seqOfMessageId(nodes: readonly ConversationNodeLike[] | undefined, messageId: string): number | null {
        34        for (const node of nodes ?? []) {
        35          try {
        36            if (node.kind !== 'assistant' || node.messageId !== messageId) continue
        37            return typeof node.seq === 'number' && Number.isFinite(node.seq) ? node.seq : null
        38          } catch {
        39            continue
        40          }
        41        }
        42        return null
        43      }
        44      
        45      /** The jump glyph: the plugin's mini stacked composition bars, same 16px outline family as the shipped row icons. */
        46      function JumpIcon(): ReactNS.ReactElement {
        47        return (
        48          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        49            <rect x="2" y="3" width="12" height="2" rx="1" fill="currentColor" />
        50            <rect x="2" y="7" width="8.5" height="2" rx="1" fill="currentColor" />
        51            <rect x="2" y="11" width="5.5" height="2" rx="1" fill="currentColor" />
        52          </svg>
        53        )
        54      }
        55      
        56      export function makeContextJumpButton(kit: ViewKit): (props: ContextJumpProps) => ReactNS.ReactElement | null {
        57        const { t } = kit
        58        return function ContextJump(props: ContextJumpProps): ReactNS.ReactElement | null {
        59          const messageId = props.messageId
        60          // Interruption-frozen partials address no durable message — the owner
        61          // already withholds them, and anything else non-string is ignored.
        62          if (typeof messageId !== 'string' || messageId === '') return null
        63          const jump = (): void => {
        64            const seq = seqOfMessageId(conversationNodesOf(props), messageId)
        65            const sessionId = props.sessionId
        66            if (seq !== null && typeof sessionId === 'string' && sessionId !== '') {
        67              requestContextFocus(sessionId, seq)
        68            }
        69            activateContextTab(t('tab'))
        70          }
        71          return (
        72            <Tooltip label={t('jump.title')} side="bottom">
        73              <button type="button" className="lc-jump" aria-label={t('jump.title')} onClick={jump}>
        74                <JumpIcon />
        75              </button>
        76            </Tooltip>
        77          )
        78        }
        79      }
        ```
        
        **`src/client/services.ts`** — ⚠ changed on disk after the last index sync — source omitted (indexed line ranges no longer match, so a slice could show the wrong code). Read this file directly for current content; the change is picked up on that project's next index sync.
        
        
        > ⚠ Changed on disk after the last index sync: src/client/components/contextView.tsx, src/client/services.ts. Line numbers referencing these files elsewhere in this response (flow steps, blast radius, symbol lists) may be shifted until that project's next sync re-indexes them.
        **Not shown above — explore these names for their source**
        
        - src/client/components/contextView.tsx: makeContextView:43, ContextView:461, ContextViewBody:64, EVENT_KINDS:39, viewScroll:37, ContextViewProps:41
          - src/client/services.ts: ClientCtx:207, timelineOf:249, contextPressureOf:306, contextBreakdownOf:318, headersOf:350, conversationNodesOf:167, +9 more
          - src/client/viewFocus.ts: requestContextFocus:11, activateContextTab:31, pendingFocus:8, takeContextFocus:16
          - src/client/components/stackedBar.tsx: makeStackedBar:37, makeLegend:168
          - src/client/components/currentComposition.tsx: makeCurrentComposition:23, CurrentComposition:29
          - src/client/components/browser.tsx: makeContextBrowser:545, ContextBrowser:557
          - src/client/modalStore.ts: modalStoreOf:19, takePendingConsume:58
          - src/client/fileActivity.ts: activityOf:492, locateStepOf:627
          - src/client/viewkit.ts: ViewKit:8, makeViewKit:17
          - src/client/settings.ts: ContextSettings:45, createContextSettings:66
          - ... and 22 more files
          =============
    
    - Example 2:
      Run `pnpm dlx @colbymchenry/codegraph query --path /path --limit 10000 "FileActivity"`
      Result:  
        =============
        Search Results for "FileActivity":

        interface   FileActivity
        src/client/fileActivity.ts:78
        
        file        fileActivity.ts
        src/client/fileActivity.ts:1
        
        file        fileActivity.spec.ts
        tests/client/fileActivity.spec.ts:1
        
        function    activityOf
        src/client/fileActivity.ts:492
        (
        nodes: SurfaceNode[],
        convOf: (seq: number) => ConversationNodeLike | undefined,
        before: number | null,
        ): FileActivity
        
        import      ../fileActivity
        src/client/components/contextView.tsx:15
        import { activityOf, locateStepOf } from '../fileActivity'
        
        import      ../fileActivity
        src/client/components/contextView.tsx:16
        import type { FileOp } from '../fileActivity'
        
        import      ../fileActivity
        src/client/components/fileCard.tsx:15
        import { absPathOf, displayPathOf, glyphOf } from '../fileActivity'
        
        import      ../fileActivity
        src/client/components/fileCard.tsx:16
        import type { FileActivity, FileEntry, FileOp, FileOpKind } from '../fileActivity'
        
        import      ../../src/client/fileActivity
        tests/client/fileActivity.spec.ts:9
        import type { FileActivity } from '../../src/client/fileActivity'
        
        import      ../../src/client/fileActivity
        tests/client/fileActivity.spec.ts:8
        import { absPathOf, activityOf, displayPathOf, formOf, glyphOf, kindOfCall, kindOfTool, linesOf, locateStepOf, pathOfArgs } from '../../src/client/fileActivity'
        
        function    run
        tests/client/fileActivity.spec.ts:34
        (ops: { node: SurfaceNode; conv: ConversationNodeLike }[], before: number | null = null): FileActivity
        
        import      ../../../src/client/fileActivity
        tests/client/components/fileCard.spec.ts:11
        import type { FileActivity, FileEntry, FileOp } from '../../../src/client/fileActivity'
        
        function    richActivity
        tests/client/components/fileCard.spec.ts:30
        (over: Partial<FileActivity> = {}): FileActivity
        
        function    workspaceActivity
        tests/client/components/fileCard.spec.ts:431
        (): FileActivity
        =============
  
## Coding
- Always consider the minimal change and the most performance efficient implementation.
- Try best to use the existing classes, utilities, styles, style tokens, events, presets and lifecycles provided by DeepSeek Harness.ess.
- Use English in code comments, documentation, Pull Request description, and commit messages.
- Smaller, less-coupling and modulized code and tests are preferred for better maintainability and testability.
- Avoid adding unnecessary code comments (unless for the pinned major decision or for those provide significant value) and code duplication.
- Before any commit, MUST ALWAYS do ALL the following checks:
  - Check the to-do list, and ensure all the items are properly completed or closed.
  - Review and simplify all the code changes, to ensure they are necessary, correct and not over-engineered.
  - Cleanup all temporary files. Cleanup temporary or unhelpful comments.
  - MUST Run `pnpm run lint:fix && pnpm run test && pnpm run build` in single command and capture FULL output, to ensure:
    - passing all the linting and test
    - the per-file code coverage MUST BE literally 100%.
      - Example output:
        - -------------------------|---------|----------|---------|---------|-------------------
          File                     | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
          -------------------------|---------|----------|---------|---------|-------------------
          All files                |     100 |      100 |     100 |     100 |

## Parsing resilience (log data must never crash or hang a view)

The plugin lives off data it does not own: the durable session log (event shapes vary across dsh versions, producers, and hand-edited replays), the conversation snapshot behind the client join, projection payloads on the wire, history RPC pages, and persisted stores. Treat all of it as untrusted input at every layer. The two failures to design out: any client- or host-side parsing that blanks the page (the error card), and anything that leaves the page stuck on "loading".

- Never let one bad record take down a view. A malformed node, event, tool entry, or file op degrades to zero rows for that item — the card, the tab, and the session keep working.
- Host-side projection folds must be TOTAL. The harness projection registry drives `apply` straight off the session/event bus with no error boundary of its own: one throwing fold stalls that unit's cells and its `session/projection` push feed, and the browser then waits on "loading" forever. So: unknown event types return the state unchanged; per-event processing is isolated so a malformed event is dropped whole (all-or-nothing — no partial state); and never materialize an `undefined`-valued property into persisted state, because the plain-JSON precondition makes one such property fail EVERY projection-cache write for the session (sessions then break in unrelated, far-away places).
- Client-side parsing degrades visibly. Sanitize delivered projection payloads at the boundary (the `timelineOf` pattern: collections re-proved, scalars zeroed, whole-value absence stays `null` → loading screen); isolate per-item work in any fold over join/log data (per-item guards, or a bounded catch when a hostile object may throw on property access); every async fetch must resolve to data or a visible retryable state, never an unhandled rejection that leaves a spinner.
- Re-prove every field at runtime. Structural narrowing over blind casts; optional chaining over non-null assertions; skip elements that fail the shape instead of throwing.
- Every parser carries hostile fixtures next to its happy path: wrong types, null/missing fields, null or primitive elements inside arrays, unpaired references, and objects that throw on property access. The 100% coverage bar applies to every guard branch — an untested guard is an unverified promise.

## Building
- Run `pnpm run build` after code changes applied.
- Run `pnpm run watch` to keep hot-reloaded on dsh with local plugin installed. It also helps developer to see the code changes in the browser.

## Dependency
- Consider updating the dependencies to the latest version if possible, as the deepseek-harness is evolving rapidly.

## Compatibility - Important!
- MUST be able to install and work correctly on `@deepseek-ai/dsh` all of **0.1.0-rc7+** and **0.1.1-rc2+** and **0.1.2-alpha1+** — no regressions in runtime dependencies, message parsing, or any user-visible behavior.
- Check carefully in depth for the compatibility of the plugin with all supported dsh version, investigate and dive deep into details of dsh source code and its dependencies (run pnpm install in dsh source code folder).
- Low-level logic (e.g. token counting) should track the implementation of the newest supported dsh version.

## I18n
- Chinese (Simplified) and English are supported for UI elements.
- Update all the supported languages translations when adding or modifying the UI elements.
- Do not keep the deprecated or unused language keys.

## Docs
- `docs` directory contains only end-user faced documents.
- `docs/social-preview.png` (GitHub social preview) must be exactly **1280 × 640 pixels**.
- `README.md`
  - Images:
    - Only embed external links in the `README.md`, in order to help the readers on both GitHub and NPM to access the images
      - For example, putting the image in the `docs` directory and embedding it in the `README.md` with links:
        - ![some image](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/some-image.png)

## Temp files
- Generate one-time temp files in the `.tmp` directory, and properly clean them up right after use.

## Git
- When asked to commit, please commit the possibly mixed changes separately for each task or purpose.
- `gh` cli is installed and logged in.

## Workflow

- To-do list
  - ALWAYS keep the coding agent's to-do list up to date throughout starting or finishing every step/task of planning, investigation and implementation.
  - Before closing any task, review all pending to-do items and ensure each is completed, cleaned up or explicitly closed.

## Tool Usage
- Always read the file first using the `read` tool before using the `edit` tool, which prevents errors like "Error: edit requires reading '/path/file' first — read the file, then retry."

## Releasing
- Version X.Y.Z, 大版本.次版本.小版本。
- Releases are cut by tagging: `git tag vX.Y.Z && gh release create vX.Y.Z`.
- A [GitHub Actions workflow](.github/workflows/release.yml) then builds, tests, and publishes the package to npm automatically by github workflow. Agent don't have to do or check it manually.
- Write the release notes from the [release template](.github/release_template.md)
