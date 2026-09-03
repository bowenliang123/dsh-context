/**
 * The supported harness compatibility matrix — the ONE source of truth for
 * which dsh baselines this plugin must work on, and how their seams differ.
 *
 * Consumed by:
 *   - tests/host/compat/  (always-on registry-contract drivers, vitest host lane)
 *   - tests/client/compat/ (always-on client-face matrix, vitest jsdom lane)
 *   - tests/compat/ (the `compat` vitest project: the real-code matrix boots
 *     the REAL dsh registry + settings + platform-table sources per baseline
 *     tag and runs the built plugin through them; plus the bundle smoke)
 *
 * Adding a future harness version = adding one entry here (its tag, its
 * cordis, and a face for every seam that differs), then running the matrix.
 * A failing probe names the seam — the connection point to re-fit or
 * refactor — not just "it broke somewhere".
 */

/** Every dsh line this plugin must install and work on (see AGENTS.md "Compatibility"). */
export const SUPPORTED_BASELINES = ['v0.1.1-rc.2', 'v0.1.2-alpha.2', 'v0.1.2-alpha.5', 'v0.1.2-rc.1'] as const

export type BaselineId = (typeof SUPPORTED_BASELINES)[number]

/** The session-projection unit contract (src/host/compat.ts mirrors it). */
export interface HostSeam {
  /**
   * Whether the registry hands the session's immutable header to a fresh
   * fold: `init(header)` since dsh 0.1.2-alpha.1, `init()` before. The
   * plugin's zero-argument `init` satisfies both — the matrix proves it.
   */
  initHeader: boolean
  /**
   * Whether `session/created` eagerly seeds cells for fresh (seq-0)
   * sessions (dsh 0.1.2-alpha.1+); before that, cells build lazily on
   * first touch. Observationally identical for contributors, but the
   * driver reproduces both timings.
   */
  seedsOnCreate: boolean
}

/** The harness web half's client faces, as far as this plugin consumes them. */
export interface ClientSeam {
  /**
   * Where the finalized conversation nodes come from: the `useChat`
   * ChatSnapshot seat (`legacy.nodes`) since dsh 0.1.2, or the session
   * snapshot's own `nodes` before.
   */
  chatNodesSeat: 'useChat' | 'useSession'
  /** The durable-image loader service/method, renamed across 0.1.2. */
  imageFace: { service: 'conversation' | 'uiConversation'; method: 'resolveImage' | 'imageUrl' }
  /** The seq-anchored history face the browser's targeted fetch rides. */
  historyFace: 'api.sessions.history' | 'remote.session.page'
  /**
   * The served response envelope: the 0.1.1 api client nests the result
   * (`{result:{ok,value}}`), the 0.1.2 remote resolves the ClientResult
   * itself (`{ok,value}`).
   */
  historyEnvelope: 'resultNested' | 'clientResult'
  /** The rows field on a successful history page value. */
  historyRowsField: 'events' | 'records'
  /**
   * MarkdownText's chrome prop: optional `codeLabels` on 0.1.1 (extra props
   * are ignored), REQUIRED `labels` since 0.1.2-alpha — missing it would
   * throw inside the primitive.
   */
  markdownChrome: 'codeLabels' | 'labels'
  /** The platform module table the shell seeds (client-bundle requires must resolve). */
  platformModules: readonly string[]
}

export interface Baseline {
  id: BaselineId
  /** The dsh git tag in deepseek-ai/deepseek-harness (local checkout or CI fetch). */
  tag: string
  /** The vendored @deepseek-ai/cordis release that harness line ships. */
  cordis: string
  /**
   * The @deepseek-ai/dsh-session release that line vendors. The staged
   * session-projection sources import runtime values from it (SessionLogOffset /
   * SessionSeq, non-type imports since 0.1.2-alpha.3), so the compat driver must
   * resolve the specifier to the tag's own generation.
   */
  session: string
  host: HostSeam
  client: ClientSeam
}

/** The client faces shared by the whole 0.1.2 generation (verified identical alpha.2 through rc.1). */
const CLIENT_0_1_2: ClientSeam = {
  chatNodesSeat: 'useChat',
  imageFace: { service: 'uiConversation', method: 'imageUrl' },
  historyFace: 'remote.session.page',
  historyEnvelope: 'clientResult',
  historyRowsField: 'records',
  markdownChrome: 'labels',
  platformModules: [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
}

export const BASELINES: readonly Baseline[] = [
  {
    id: 'v0.1.1-rc.2',
    tag: 'dsh-v0.1.1-rc.2',
    cordis: '4.0.1',
    session: '0.1.1-rc.2',
    host: { initHeader: false, seedsOnCreate: false },
    client: {
      chatNodesSeat: 'useSession',
      imageFace: { service: 'conversation', method: 'resolveImage' },
      historyFace: 'api.sessions.history',
      historyEnvelope: 'resultNested',
      historyRowsField: 'events',
      markdownChrome: 'codeLabels',
      platformModules: [
        'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-client-ui-slots',
        '@deepseek-ai/dsh-client-ui-primitives',
      ],
    },
  },
  {
    id: 'v0.1.2-alpha.2',
    tag: 'dsh-v0.1.2-alpha.2',
    cordis: '4.0.2',
    session: '0.1.2-alpha.2',
    host: { initHeader: true, seedsOnCreate: true },
    client: CLIENT_0_1_2,
  },
  {
    // The preview window's head — the DSH STORE latest-three compatibility
    // window currently ends here (alpha.3/alpha.4 sit between the probed
    // alpha.2 and alpha.5 tags with no seam drift).
    id: 'v0.1.2-alpha.5',
    tag: 'dsh-v0.1.2-alpha.5',
    cordis: '4.0.2',
    session: '0.1.2-alpha.5',
    host: { initHeader: true, seedsOnCreate: true },
    client: CLIENT_0_1_2,
  },
  {
    // The `next`-channel release candidate — the newest declared dsh release.
    id: 'v0.1.2-rc.1',
    tag: 'dsh-v0.1.2-rc.1',
    cordis: '4.0.2',
    session: '0.1.2-rc.1',
    host: { initHeader: true, seedsOnCreate: true },
    client: CLIENT_0_1_2,
  },
]
