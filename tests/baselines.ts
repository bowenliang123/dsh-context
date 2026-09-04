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

/** The supported dsh tags, in lockstep with the BASELINES entries below. */
export type BaselineId = 'v0.1.2-rc.1'

/** The harness web half's client faces, as far as the compat probes consume them. */
export interface ClientSeam {
  /** The durable-image loader method the browser cards ride. */
  imageFaceMethod: string
  /** MarkdownText's chrome prop the plugin must hand every markdown render. */
  markdownChrome: string
  /** The platform module table the shell seeds (client-bundle requires must resolve). */
  platformModules: readonly string[]
}

export interface Baseline {
  /** The dsh git tag in deepseek-ai/deepseek-harness (local checkout or CI fetch). */
  id: BaselineId
  tag: string
  /** The vendored @deepseek-ai/cordis release that harness line ships. */
  cordis: string
  /**
   * The @deepseek-ai/dsh-session release that line vendors. The staged
   * session-projection sources import runtime values from it (SessionLogOffset /
   * SessionSeq), so the compat driver must resolve the specifier to the tag's
   * own generation.
   */
  session: string
  client: ClientSeam
}

export const BASELINES: readonly Baseline[] = [
  {
    // The `next`-channel release candidate — the newest declared dsh release.
    id: 'v0.1.2-rc.1',
    tag: 'dsh-v0.1.2-rc.1',
    cordis: '4.0.2',
    session: '0.1.2-rc.1',
    client: {
      imageFaceMethod: 'imageUrl',
      markdownChrome: 'labels',
      platformModules: [
        'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-client-store',
        '@deepseek-ai/dsh-client-ui-slots',
        '@deepseek-ai/dsh-client-ui-primitives',
      ],
    },
  },
]
