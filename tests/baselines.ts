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
export type BaselineId = 'v0.1.2-rc.1' | 'v0.1.3-alpha.2' | 'v0.1.5-rc.1'

/** The harness web half's client faces, as far as the compat probes consume them. */
export interface ClientSeam {
  /** The durable-image loader method the browser cards ride. */
  imageFaceMethod: string
  /** MarkdownText's chrome prop the plugin must hand every markdown render. */
  markdownChrome: string
  /** The platform module table the shell seeds (client-bundle requires must resolve). */
  platformModules: readonly string[]
  /**
   * The faces the split timeline's on-demand detail channel rides
   * (host/detail.ts + client/timelineSource.ts): the host's generic
   * Connection RPC registry, the browser caller, and the projection
   * registry's `stateOf` read. Each probe is a needle in the named source
   * file of the baseline tag.
   */
  detailChannel: {
    /** `HostConnectionRpc` in the connection package's shared rpc source. */
    hostRpcFile: string
    hostRpcNeedle: string
    /** The browser caller's `call(channel, endpoint, payload…)` in the connection client source. */
    clientRpcFile: string
    clientRpcNeedle: string
    /** The registry's `stateOf` unit-state read (the detail endpoint's data source). */
    registryFile: string
    registryNeedle: string
  }
  /**
   * The right Sidebar's tab seam, present only from the generation that ships
   * it (0.1.5-rc.1+). The plugin's registration is OPTIONAL: a line without
   * this seam must simply never register the tab, and the matrix asserts the
   * absence explicitly so a probe can tell "not supported here" from "moved".
   */
  sidebar?: {
    /** The tab-type registry service's providing source. */
    serviceFile: string
    serviceNeedle: string
    /** The keyed body seat's declaring source. */
    slotFile: string
    slotNeedle: string
    /**
     * The guide-entry contract the plugin's contribution must satisfy: one
     * needle per field `SidebarRightGuideEntry` carries on this generation.
     */
    guideEntry: {
      /** The declaring source. */
      file: string
      /** One needle per field the guide entry carries. */
      fields: readonly string[]
    }
  }
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
  /**
   * The durable-event families THIS line's log carries that the host fold
   * switches on — the probe asserts every one exists in the tag's
   * `KNOWN_SESSION_EVENT_TYPES`. The fold reads a UNION of generations
   * (V0 `assistant/chunk` + `tool/code-dispatch`; V2 `assistant/attempt`; V3
   * `system/message` + `tool/ptc-dispatch`), and no single line carries them
   * all, so the list is per baseline by construction; the matrix also asserts
   * the union covers the fold's whole vocabulary.
   */
  foldEventTypes: readonly string[]
  client: ClientSeam
  /**
   * The step-boundary identity guard's host seam (src/host/stepIdentity.ts):
   * the agent-loop file that dispatches the `agent/pre-step` waterfall and
   * appends its decision's messages, plus a shipped context plugin proving
   * the `prepend` listener option this guard rides on that line.
   */
  stepGuard: {
    loopFile: string
    loopNeedles: readonly string[]
    prependProofFile: string
  }
}

export const BASELINES: readonly Baseline[] = [
  {
    // Session format V0 — the oldest supported line (the plugin's original target).
    id: 'v0.1.2-rc.1',
    tag: 'dsh-v0.1.2-rc.1',
    cordis: '4.0.2',
    session: '0.1.2-rc.1',
    foldEventTypes: [
      'request/header', 'request/context', 'step/start', 'step/end',
      'user/message', 'tool/call', 'tool/result', 'assistant/message', 'assistant/chunk',
      'tool/code-dispatch',
      'plan/mode', 'compaction/summary', 'compaction/prune',
    ],
    client: {
      imageFaceMethod: 'imageUrl',
      markdownChrome: 'labels',
      platformModules: [
        'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-client-store',
        '@deepseek-ai/dsh-client-ui-slots',
        '@deepseek-ai/dsh-client-ui-primitives',
      ],
      detailChannel: {
        hostRpcFile: 'packages/client/connection/src/rpc.ts',
        hostRpcNeedle: 'HostConnectionRpc',
        clientRpcFile: 'packages/client/connection/src/client/rpc.ts',
        clientRpcNeedle: 'call(channel, endpoint, payload',
        registryFile: 'packages/session/session-projection/src/index.ts',
        registryNeedle: 'stateOf<',
      },
    },
    stepGuard: {
      loopFile: 'packages/core/agent-loop/src/agent.ts',
      loopNeedles: ["'agent/pre-step'", "append('user/message'"],
      prependProofFile: 'packages/context/time-context/src/index.ts',
    },
  },
  {
    // Session format V2: the assistant stream moved INTO the settlement
    // (`assistant/message.data.stream` / `assistant/attempt.data.stream`), so
    // `assistant/chunk` no longer exists and the fold's first-token source
    // changes while every other V0 seam stays.
    id: 'v0.1.3-alpha.2',
    tag: 'dsh-v0.1.3-alpha.2',
    cordis: '4.0.2',
    session: '0.1.3-alpha.2',
    foldEventTypes: [
      'request/header', 'request/context', 'step/start', 'step/end',
      'user/message', 'tool/call', 'tool/result', 'assistant/message', 'assistant/attempt',
      'tool/code-dispatch',
      'plan/mode', 'compaction/summary', 'compaction/prune',
    ],
    client: {
      imageFaceMethod: 'imageUrl',
      markdownChrome: 'labels',
      platformModules: [
        'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-client-store',
        '@deepseek-ai/dsh-client-ui-slots',
        '@deepseek-ai/dsh-client-ui-primitives',
      ],
      detailChannel: {
        hostRpcFile: 'packages/client/connection/src/rpc.ts',
        hostRpcNeedle: 'HostConnectionRpc',
        clientRpcFile: 'packages/client/connection/src/client/rpc.ts',
        clientRpcNeedle: 'call(channel, endpoint, payload',
        registryFile: 'packages/session/session-projection/src/index.ts',
        registryNeedle: 'stateOf<',
      },
    },
    stepGuard: {
      loopFile: 'packages/core/agent-loop/src/agent.ts',
      loopNeedles: ["'agent/pre-step'", "append('user/message'"],
      prependProofFile: 'packages/context/time-context/src/index.ts',
    },
  },
  {
    // Session format V3: the system prompt became a surface node
    // (`system/message`) and left `request/header.header.system`; replacement
    // endpoints renamed to `startSeq`/`endSeq`; the PTC vocabulary renamed to
    // `tool/ptc-dispatch`; the shell seeds one more platform module. From
    // 0.1.5-alpha.2 the conversation surface moved under the keyed `main` panel
    // (`main.conversation`); at 0.1.5-rc.1 the guide entry regained its
    // optional description line.
    id: 'v0.1.5-rc.1',
    tag: 'dsh-v0.1.5-rc.1',
    cordis: '4.0.2',
    session: '0.1.5-rc.1',
    foldEventTypes: [
      'request/header', 'request/context', 'step/start', 'step/end',
      'user/message', 'tool/call', 'tool/result', 'assistant/message', 'assistant/attempt',
      'tool/ptc-dispatch',
      'plan/mode', 'compaction/summary', 'compaction/prune', 'system/message',
    ],
    client: {
      imageFaceMethod: 'imageUrl',
      markdownChrome: 'labels',
      platformModules: [
        'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-client-store',
        '@deepseek-ai/dsh-client-ui-slots',
        '@deepseek-ai/dsh-client-ui-primitives',
        '@deepseek-ai/dsh-client-ui-dockkit',
      ],
      detailChannel: {
        hostRpcFile: 'packages/client/connection/src/rpc.ts',
        hostRpcNeedle: 'HostConnectionRpc',
        clientRpcFile: 'packages/client/connection/src/client/rpc.ts',
        clientRpcNeedle: 'call(channel, endpoint, payload',
        registryFile: 'packages/session/session-projection/src/index.ts',
        registryNeedle: 'stateOf<',
      },
      sidebar: {
        serviceFile: 'packages/client/ui-sidebar-right/src/client/index.ts',
        serviceNeedle: 'sidebarRightTabs',
        slotFile: 'packages/client/ui-sidebar-right/src/client/contract/slots.ts',
        slotNeedle: 'sidebar.right.pane.tab',
        guideEntry: {
          file: 'packages/client/ui-sidebar-right/src/client/tab-registry.ts',
          fields: [
            'readonly order: number',
            'readonly title: () => string',
            'readonly description?: () => string',
            'readonly icon?: ComponentType<IconProps>',
          ],
        },
      },
    },
    stepGuard: {
      loopFile: 'packages/core/agent-loop/src/agent.ts',
      loopNeedles: ["'agent/pre-step'", "append('user/message'"],
      prependProofFile: 'packages/context/time-context/src/index.ts',
    },
  },
]
