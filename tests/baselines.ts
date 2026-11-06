export type BaselineId = 'v0.2.0-rc.2' | 'v0.2.1-rc.2' | 'v0.2.2-rc.1'

export interface ClientSeam {
  imageFaceMethod: string
  markdownChrome: string
  jsonTree: {
    file: string
    needles: readonly string[]
  }
  platformModules: readonly string[]
  detailChannel: {
    hostRpcFile: string
    hostRpcNeedle: string
    clientRpcFile: string
    clientRpcNeedle: string
    registryFile: string
    registryNeedle: string
    fallbackStateOfNeedle: string
    awaitableRegister: boolean
  }
  sessionNav: {
    workspaceFile: string
    workspaceNeedle: string
    sessionsFile: string
    sessionsOpen: boolean
  }
  subagentAddress: {
    file: string
    needle: string
    summaryFallback: boolean
    summaryNeedle: string
  }
  pluginsNav: {
    file: string
    needle: string
    tabReset: boolean
    tabResetNeedle: string
    tabsSlot: boolean
    tabsSlotFile: string
    tabsSlotNeedle: string
  }
  codeHighlight: readonly { file: string; needle: string; what: string }[]
  insightPage: {
    panellistFile: string
    panellistNeedle: string
    mainFile: string
    mainNeedle: string
  }
  ledger: {
    file: string
    needle: string
  }
  sidebar: {
    serviceFile: string
    serviceNeedle: string
    slotFile: string
    slotNeedle: string
    titleSlotNeedle: string
    nav: {
      file: string
      needle: string
    }
    guideEntry: {
      file: string
      fields: readonly string[]
    }
  }
}

export interface Baseline {
  id: BaselineId
  tag: string
  version: string
  cordis: string
  session: string
  foldEventTypes: readonly string[]
  client: ClientSeam
  stepGuard: {
    loopFile: string
    loopNeedles: readonly string[]
    prependProofFile: string
  }
  settings: {
    serviceFile: string
    register: boolean
    cardSlot: string
    cardSlotFiles: readonly string[]
    transport: 'configForms'
    transportFile: string
    transportPresent: boolean
  }
  balance: {
    settingsFile: string
    settingsGetNeedle: string
    settingsGetPresent: boolean
    settingsDescribeNeedle: string
    settingsRedactNeedle: string
    providerDirectory: { file: string; needle: string }
    stockIds: { file: string; ids: readonly string[] }
    providerFiles: readonly { file: string; needles: readonly string[] }[]
  }
  prompt: {
    serviceFile: string
    sectionNeedle: string
    orderAnchors: readonly string[]
    loaderVolatileFile: string
    loaderVolatileNeedle: string
  }
  backfillFold: {
    registryFile: string
    storeFile: string
    cacheFile: string
  }
}

const DEFAULT_PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

function baseline(id: BaselineId, tag: string, session: string, line: {
  cordis?: string
  stockIds?: readonly string[]
  extraFoldEvents?: readonly string[]
  platformModules?: readonly string[]
  stateOfNeedle?: string
  fallbackStateOfNeedle?: string
  awaitableRegister?: boolean
} = {}): Baseline {
  return {
    id,
    tag,
    version: tag.replace(/^dsh-v/, ''),
    cordis: line.cordis ?? '4.0.4',
    session,
    foldEventTypes: [
      'request/header', 'request/context', 'step/start', 'step/end',
      'user/message', 'developer/message', 'tool/call', 'tool/result', 'assistant/message', 'assistant/attempt',
      'tool/ptc-dispatch', 'tool/ptc-dispatch-start',
      'plan/mode', 'compaction/summary', 'compaction/prune', 'system/message',
      'approval/asked', 'approval/decided', 'session/end-seed',
      ...(line.extraFoldEvents ?? []),
    ],
    client: {
      imageFaceMethod: 'imageUrl',
      markdownChrome: 'labels',
      jsonTree: {
        file: 'packages/client/ui-primitives/src/JsonTree.tsx',
        needles: ['data-json-expander', 'aria-expanded', 'css.summary', 'css.preview', 'css.punctuation', 'expandTopLevel', 'copyButtonTitle'],
      },
      platformModules: line.platformModules ?? DEFAULT_PLATFORM_MODULES,
      detailChannel: {
        hostRpcFile: 'packages/client/connection/src/rpc.ts',
        hostRpcNeedle: 'HostConnectionRpc',
        clientRpcFile: 'packages/client/connection/src/client/rpc.ts',
        clientRpcNeedle: 'call(channel, endpoint, payload',
        registryFile: 'packages/session/session-projection/src/index.ts',
        registryNeedle: line.stateOfNeedle ?? 'stateOf<',
        fallbackStateOfNeedle: line.fallbackStateOfNeedle ?? 'stateOf<',
        awaitableRegister: line.awaitableRegister ?? false,
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
            'readonly id: string',
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
      codeHighlight: [
        { file: 'packages/client/ui-primitives/src/code-highlighting.ts', needle: 'useCodeHighlighter', what: 'the highlighter hook the panel binds' },
        { file: 'packages/client/ui-primitives/src/markdown/highlight.ts', needle: "lang: 'shellscript'", what: 'the shell grammar is pre-tokenized at boot' },
        { file: 'packages/client/ui-primitives/src/markdown/highlight.ts', needle: '@shikijs/langs/powershell', what: 'the pwsh grammar loads through the lazy table' },
        { file: 'packages/client/ui-theme/src/styles/shiki.css', needle: 'shiki-token-function', what: 'the token sheet the runs resolve against' },
      ],
      subagentAddress: {
        file: 'packages/api/session-controller/src/client/sessions/manager.ts',
        needle: 'subagentAddress',
        summaryFallback: id !== 'v0.2.0-rc.2',
        summaryNeedle: 'summary?.origin',
      },
      pluginsNav: {
        file: 'packages/client/ui-plugin-manager/src/client/index.ts',
        needle: "'pluginNavigation', {",
        tabReset: id !== 'v0.2.0-rc.2',
        tabResetNeedle: 'instance.actions.setTab',
        tabsSlot: id !== 'v0.2.0-rc.2',
        tabsSlotFile: 'packages/client/ui-plugin-manager/src/client/slot-contract.ts',
        tabsSlotNeedle: "'plugins.tab'",
      },
      insightPage: {
        panellistFile: 'packages/client/ui-sidebar/src/client/contract/slots.ts',
        panellistNeedle: "'sidebar.panellist'",
        mainFile: 'packages/client/ui-layout/src/client/index.ts',
        mainNeedle: "'main': { kind: 'keyed'",
      },
      ledger: {
        file: 'packages/client/ui-renderer/src/client/registry.ts',
        needle: 'entries(key: keyof SlotMap',
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
      settingsRedactNeedle: 'redactSecrets?: boolean',
      providerDirectory: {
        file: 'packages/llm/llm/src/index.ts',
        needle: 'listConfigurableProviders(): LlmConfigurableProvider',
      },
      stockIds: {
        file: 'packages/bundle/base/cordis.patch.yml',
        ids: line.stockIds ?? ['llm-deepseek', 'web-search-deepseek'],
      },
      providerFiles: [
        {
          file: 'packages/llm/llm-deepseek-api-key/src/index.ts',
          needles: ["const PROVIDER = 'deepseek-official'"],
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
    prompt: {
      serviceFile: 'packages/core/system-prompt/src/index.ts',
      sectionNeedle: 'section(section: PromptSection)',
      orderAnchors: ['HARNESS_IDENTITY', 'DEPLOYMENT_PERSONA_SUFFIX'],
      loaderVolatileFile: 'vendor/loader/src/config/entry.ts',
      loaderVolatileNeedle: 'updateVolatile(ref, source)',
    },
    backfillFold: {
      registryFile: 'packages/session/session-projection/src/index.ts',
      storeFile: 'packages/core/session/src/index.ts',
      cacheFile: 'packages/session/session-projection-cache/src/index.ts',
    },
  }
}

export const BASELINES: readonly Baseline[] = [
  baseline('v0.2.0-rc.2', 'dsh-v0.2.0-rc.2', '0.2.0-rc.2'),
  baseline('v0.2.1-rc.2', 'dsh-v0.2.1-rc.2', '0.2.1-rc.2', {
    cordis: '4.0.5',
    stockIds: ['llm-deepseek', 'web-search-deepseek', 'web-deepseek-api'],
    platformModules: [...DEFAULT_PLATFORM_MODULES, 'zod', '@tanstack/react-virtual'],
    extraFoldEvents: ['job/registered', 'job/settled'],
  }),
  baseline('v0.2.2-rc.1', 'dsh-v0.2.2-rc.1', '0.2.2-rc.1', {
    cordis: '4.1.0',
    stockIds: ['llm-deepseek', 'web-search-deepseek', 'web-deepseek-api'],
    platformModules: [...DEFAULT_PLATFORM_MODULES, 'zod', '@tanstack/react-virtual'],
    extraFoldEvents: ['job/registered', 'job/settled'],
    stateOfNeedle: 'stateOf(session: Session): S',
    fallbackStateOfNeedle: 'stateOf(session: Session, key: string): unknown',
    awaitableRegister: true,
  }),
]
