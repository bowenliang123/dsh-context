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
export type BaselineId = 'v0.1.5-rc.1' | 'v0.1.7-rc.2'

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
   * The session-jump seam (the Context Dashboard's session cards and the
   * Agent network card's nodes — issue #90). Every supported line selects a
   * session through the view owner's `uiWorkspace.openSession` (the sidebar
   * row click's own verb), but the 0.1.6 selection refactor re-spelled the
   * parameter (`sessionId` → `target: SessionTarget`) and retired the
   * sessions service's own `open(id)` spelling — present through V3, absent
   * on V4+. Both faces are probed presence-as-declared so a future move
   * names the seam instead of silently dead-ending the jump.
   */
  sessionNav: {
    /** The view-owner navigation verb's source, plus this line's signature spelling. */
    workspaceFile: string
    workspaceNeedle: string
    /** The sessions contract source, plus whether this line still declares `open(id: SessionId)`. */
    sessionsFile: string
    sessionsOpen: boolean
  }
  /**
   * The right Sidebar's tab seam — every supported generation ships it
   * (0.1.5-rc.1 introduced it). The plugin's registration stays an OPTIONAL
   * deferred inject: a below-baseline host (the gate's fallback composition)
   * may lack the service entirely, and the client must simply never register
   * the tab there instead of pending.
   */
  sidebar: {
    /** The tab-type registry service's providing source. */
    serviceFile: string
    serviceNeedle: string
    /** The keyed body seat's declaring source. */
    slotFile: string
    slotNeedle: string
    /**
     * The keyed chip-title seat the plugin's tab type also registers into
     * (the emblem-beside-label idiom the shipped files type uses). Present
     * wherever the body seat is; probed separately so a rename names the seam.
     */
    titleSlotNeedle: string
    /**
     * The navigation face the plugin's file-open affordance rides
     * (`ctx.sidebarRight.openResource`): the controller's providing source and
     * the needle in it. Same package as the registry, so present wherever the
     * tab seam is; probed so a rename names the preview seam instead of
     * silently degrading the affordance.
     */
    nav: {
      /** The controller source (the public navigation face's implementation). */
      file: string
      /** The `openResource` verb's declaration/comments marker. */
      needle: string
    }
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
   * `KNOWN_SESSION_EVENT_TYPES`. Both supported generations (V3, V4) carry
   * the same families, so the lists match; the matrix also asserts the union
   * covers the fold's whole vocabulary, so a fold case added without a
   * baseline list fails loudly instead of going unprobed.
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
  /**
   * The tag's settings-namespace surface. Through V3 the settings service
   * carries the `register(ns, schema)` face the plugin's host half calls
   * (feature-detected), optionally behind a namespace pattern that must
   * accept the plugin literal, the browser half binds the `settingsScope`
   * service and registers its card on the `settings.plugin.item` slot. V4+
   * derives configuration forms from each loader entry's own Config schema —
   * the register face is gone (the plugin stays inert there) and the browser
   * half rides the `configForms` service and the Plugins page's keyed
   * `plugins.bundle.config` seat instead.
   */
  settings: {
    /** The settings service source carrying (or missing) the register face. */
    serviceFile: string
    /** Whether this generation serves `settings.register`. */
    register: boolean
    /** The NAMESPACE_PATTERN source, where the generation enforces one. */
    patternFile?: string
    /** The browser slot the preferences card registers on this generation. */
    cardSlot: string
    /** The sources declaring (or missing) the card slot. */
    cardSlotFiles: readonly string[]
    /** The browser settings-transport service this generation composes. */
    transport: 'settingsScope' | 'configForms'
    /** The transport's declaring source, plus whether it exists. */
    transportFile: string
    transportPresent: boolean
  }
  /**
   * The balance capsule's host seam (src/host/balance.ts). The facts fold
   * reads the DeepSeek API-key provider's settings row through whichever face
   * the line serves: the `get(ns)` registered-section read through V3, the
   * Config-form `describe()` projection on V4+ — where the provider row is
   * the entry whose served value declares the top-level `apiKeyEnv`
   * credential ref, preferred under the settings ids the generations have
   * served it as. Each face is probed against the tag's real sources.
   */
  balance: {
    /** The settings service source the face needles are asserted in. */
    settingsFile: string
    /** The `get(ns)` section read — served through V3, retired on V4+. */
    settingsGetNeedle: string
    settingsGetPresent: boolean
    /** The Config-form projection needle, when this line serves one the fold reads. */
    settingsDescribeNeedle: string | undefined
    /** The provider sources carrying the plugin id and the section shape the fold matches. */
    providerFiles: readonly { file: string; needles: readonly string[] }[]
  }
}

export const BASELINES: readonly Baseline[] = [
  {
    // The oldest supported line — Session format V3: the system prompt is a
    // surface node (`system/message`), replacement endpoints spell
    // `startSeq`/`endSeq`, and the nested PTC vocabulary is
    // `tool/ptc-dispatch`. From 0.1.5-alpha.2 the conversation surface moved
    // under the keyed `main` panel (`main.conversation`); at 0.1.5-rc.1 the
    // guide entry regained its optional description line.
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
        titleSlotNeedle: 'sidebar.right.pane.tab.title',
        nav: {
          file: 'packages/client/ui-sidebar-right/src/client/service.ts',
          needle: 'openResource(address',
        },
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
      sessionNav: {
        workspaceFile: 'packages/client/ui-workspace/src/client/navigation.ts',
        workspaceNeedle: 'openSession(sessionId: SessionId): void',
        sessionsFile: 'packages/api/session-controller/src/client/contract/sessions.ts',
        sessionsOpen: true,
      },
    },
    settings: {
      serviceFile: 'packages/settings/settings/src/index.ts',
      register: true,
      patternFile: 'packages/settings/settings/src/index.ts',
      cardSlot: 'settings.plugin.item',
      cardSlotFiles: ['packages/client/ui-settings-plugins/src/**'],
      transport: 'settingsScope',
      transportFile: 'packages/client/ui-settings/src/client/settings-scope.ts',
      transportPresent: true,
    },
    balance: {
      settingsFile: 'packages/settings/settings/src/index.ts',
      settingsGetNeedle: 'get<const Namespace extends string>(ns:',
      settingsGetPresent: true,
      settingsDescribeNeedle: undefined,
      providerFiles: [
        {
          file: 'packages/llm/llm-deepseek/src/index.ts',
          needles: ["export const name = 'llm-deepseek'", "apiKeyEnv: z.string().role('credential-ref')"],
        },
      ],
    },
    stepGuard: {
      loopFile: 'packages/core/agent-loop/src/agent.ts',
      loopNeedles: ["'agent/pre-step'", "append('user/message'"],
      prependProofFile: 'packages/context/time-context/src/index.ts',
    },
  },
  {
    // Session format V4: the fold's switched families are unchanged (the
    // system prompt still rides `system/message`), but the line retires the
    // `settings.register` host face and the `settings.plugin.item` slot — the
    // plugin's preferences card registers on the Plugins page's keyed
    // `plugins.bundle.config` slot there, keeping the old registration for the
    // V3 line (each slot exists on exactly one side, so the deferred injects
    // pick their generation and never pend). V4 also rewrites the tool result:
    // a first-class role-`tool` message with lifted `toolCallId`/`isError`
    // (the fold reads both spellings). The baseline pins `0.1.7-rc.2`, the
    // first release of the line with a complete npm dependency closure; rc.2
    // adds `startsSeries` to the first `request/header` and the
    // `developer/message` tool-registry events, both inert to the fold.
    // 0.1.7 enforces plugin dsh-peer compatibility at startup and install
    // (evaluatePluginCompatibility); this plugin's `>=0.1.5-rc.1` dsh peers
    // satisfy every supported line under the gate's includePrerelease check.
    id: 'v0.1.7-rc.2',
    tag: 'dsh-v0.1.7-rc.2',
    cordis: '4.0.4',
    session: '0.1.7-rc.2',
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
        titleSlotNeedle: 'sidebar.right.pane.tab.title',
        nav: {
          file: 'packages/client/ui-sidebar-right/src/client/service.ts',
          needle: 'openResource(address',
        },
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
      sessionNav: {
        workspaceFile: 'packages/client/ui-workspace/src/client/navigation.ts',
        workspaceNeedle: 'openSession(target: SessionTarget): void',
        sessionsFile: 'packages/api/session-controller/src/client/contract/sessions.ts',
        sessionsOpen: false,
      },
    },
    settings: {
      serviceFile: 'packages/settings/settings/src/index.ts',
      register: false,
      cardSlot: 'plugins.bundle.config',
      cardSlotFiles: ['packages/client/ui-plugin-manager/src/**'],
      transport: 'configForms',
      transportFile: 'packages/client/ui-settings/src/client/config-form.ts',
      transportPresent: true,
    },
    balance: {
      settingsFile: 'packages/settings/settings/src/index.ts',
      settingsGetNeedle: 'get<const Namespace extends string>(ns:',
      settingsGetPresent: false,
      settingsDescribeNeedle: 'describe(options?: SettingsDescribeOptions)',
      providerFiles: [
        {
          file: 'packages/llm/llm-deepseek-api-key/src/index.ts',
          needles: ["export const name = 'llm-deepseek-api-key'"],
        },
        {
          file: 'packages/llm/llm-deepseek-api-key/src/config.ts',
          needles: ["apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY').volatile()"],
        },
        {
          file: 'packages/llm/llm-deepseek/src/config.ts',
          needles: ['baseURL: z.string().volatile()'],
        },
      ],
    },
    stepGuard: {
      loopFile: 'packages/core/agent-loop/src/agent.ts',
      loopNeedles: ["'agent/pre-step'", "append('user/message'"],
      prependProofFile: 'packages/context/time-context/src/index.ts',
    },
  },
]
