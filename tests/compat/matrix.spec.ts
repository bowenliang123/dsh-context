import assert from 'node:assert/strict'
import { beforeAll, describe, test } from 'vitest'
import { BASELINES } from '../baselines'
import * as staging from './staging'

const reasons = staging.skipReasons()
if (reasons.length > 0) {
  if (process.env.CI) throw new Error(`[compat] matrix cannot run: ${reasons.join('; ')}`)
  console.warn(`[compat] matrix skipped — ${reasons.join('; ')}`)
}

describe('compat matrix — the per-baseline fold vocabularies', () => {
  test('every event family the fold switches on is declared by the baselines', () => {
    const folded = staging.foldEventTypesFromSource()
    const declared = new Set(BASELINES.flatMap(b => b.foldEventTypes))
    assert.deepEqual(
      folded.filter(type => !declared.has(type)),
      [],
      'a fold case no baseline declares',
    )
  })
})

describe.skipIf(staging.artifactsMissing())('compat matrix — bundle requires vs the declared module tables', () => {
  test.each(BASELINES)('$id: the declared table answers every bundle require', (baseline) => {
    assert.deepEqual(
      staging.bundleRequires().filter(spec => !baseline.client.platformModules.includes(spec)),
      [],
    )
  })
})

describe.skipIf(reasons.length > 0)('compat matrix — real dsh sources per baseline', () => {
  describe.each(BASELINES)('$id (tag $tag, cordis $cordis)', (baseline) => {
    let report: staging.DriverReport
    beforeAll(() => {
      report = staging.runDriver(baseline)
    }, 60_000)

    test('host: all three projection values served through the wire', () => {
      assert.deepEqual(report.keys, ['contextActivity', 'contextHeaders', 'contextTimeline'])
    })

    test('host: checkpoint rows pass the tag\'s lossless-JSON cache-write gate', () => {
      assert.equal(report.gateOk, true)
    })

    test('host: cold restore refolds to the live snapshot', () => {
      assert.equal(report.coldMatches, true)
    })

    test('host: developer messages contribute to requests and survive warm restore and v24 cache rebuild', () => {
      assert.equal(report.developerTokens, 35)
      assert.equal(report.developerInjectCount, 1)
      assert.equal(report.developerRestoreMatches, true)
    })

    test('admission: the tag gate admits this manifest and refuses the dropped 0.1.7 line', () => {
      const admission = staging.evaluateAdmission(baseline)
      assert.deepEqual(admission.baseline, { admitted: true, requirements: null }, 'a supported release needs no exemption')
      assert.equal(admission.dropped.admitted, false, 'the dropped 0.1.7 line is refused')
      assert.ok(Object.keys(admission.dropped.requirements ?? {}).length > 0, 'the refusal names its unmet requirement')
    })

    test('host: hostile gateway usage keeps the served view schema-valid (issue #44)', () => {
      assert.equal(report.hostileSnapshotOk, true)
      assert.equal(report.hostileSteps, 3, 'both hostile requests re-track in the head counts')
    })

    test('host: a poisoned upstream unit starves downstream units and throws the whole snapshot (dsh containment gap)', () => {
      assert.ok(report.poisonedEscapedDrive >= 1)
      assert.equal(report.poisonedStarves, true)
      assert.equal(report.poisonedSnapshotThrows, true)
    })

    test('settings: the retired register face stays gone (the plugin never calls it)', () => {
      assert.equal(
        staging.dshHasString(baseline.tag, 'register(', baseline.settings.serviceFile),
        baseline.settings.register,
        'the settings service register face',
      )
    })

    test('balance: the settings face and the DeepSeek provider row the facts fold reads', () => {
      const balance = baseline.balance
      assert.equal(
        staging.dshHasString(baseline.tag, balance.settingsGetNeedle, balance.settingsFile),
        balance.settingsGetPresent,
        'the settings service get face',
      )
      assert.equal(
        staging.dshHasString(baseline.tag, balance.settingsDescribeNeedle, balance.settingsFile),
        true,
        'the settings service describe face',
      )
      assert.equal(
        staging.dshHasString(baseline.tag, balance.settingsRedactNeedle, balance.settingsFile),
        true,
        'the settings service redaction option',
      )
      assert.equal(
        staging.dshHasString(baseline.tag, balance.providerDirectory.needle, balance.providerDirectory.file),
        true,
        'the llm provider directory face',
      )
      for (const id of balance.stockIds.ids) {
        assert.equal(
          staging.dshHasString(baseline.tag, `id: ${id}$`, balance.stockIds.file),
          true,
          `the DeepSeek stock entry id: ${id}`,
        )
      }
      for (const provider of balance.providerFiles) {
        for (const needle of provider.needles) {
          assert.equal(staging.dshHasString(baseline.tag, needle, provider.file), true, `provider seam: ${needle}`)
        }
      }
    })

    test('host: the sliced cold fold faces exist (else the backfill falls back to whole-log blocks)', () => {
      const fold = baseline.backfillFold
      for (const [file, needle] of [
        [fold.registryFile, '  restore('],
        [fold.registryFile, '  hydrate('],
        [fold.storeFile, '  prepare('],
        [fold.cacheFile, '  async write('],
        [fold.cacheFile, '  coldSnapshot('],
      ] as const) {
        assert.equal(staging.dshHasString(baseline.tag, needle, file), true, `sliced-fold seam: ${needle} in ${file}`)
      }
    })

    for (const slot of staging.SLOT_SEAMS) {
      test(`client: slot "${slot}" exists`, () => {
        assert.equal(staging.dshHasString(baseline.tag, slot, 'packages/client/*/src/**'), true)
      })
    }

    test('client: the preferences card seat and transport match the generation', () => {
      const settings = baseline.settings
      assert.equal(
        settings.cardSlotFiles.some(pattern =>
          staging.dshHasString(baseline.tag, `'${settings.cardSlot}'`, pattern)),
        true,
        `the card slot "${settings.cardSlot}" is declared on this generation`,
      )
      assert.equal(
        staging.dshHasString(baseline.tag, `'${settings.transport}'`, settings.transportFile),
        settings.transportPresent,
        `the settings transport "${settings.transport}"`,
      )
    })

    test('client: the app frame carries the inline sidebar-leading grid track (modal dock seam, dockMeasure.ts)', () => {
      assert.equal(
        staging.dshHasString(baseline.tag, 'px minmax(', 'packages/client/ui-layout/src/client/AppFrame.tsx'),
        true,
      )
    })

    test('client: finalized-nodes seat (useChat ChatSnapshot)', () => {
      assert.equal(staging.dshHasString(baseline.tag, 'useChat', 'packages/client/ui-chat/src/client/contract/slots.ts'), true)
    })

    test('client: durable-image loader service', () => {
      assert.equal(staging.dshHasString(baseline.tag, baseline.client.imageFaceMethod, 'packages/client/*/src/**'), true)
    })

    test('client: the gateway history face of this generation', () => {
      assert.equal(staging.dshHasString(baseline.tag, "'remote.session'", 'packages/api/*/src/**'), true)
      assert.equal(
        staging.dshHasString(baseline.tag, 'records: frame.records', 'packages/api/session-controller/src/client/transport.ts'),
        true,
        'the history page envelope key',
      )
    })

    test('detail channel: the Connection RPC faces and the registry stateOf exist', () => {
      const dc = baseline.client.detailChannel
      assert.equal(staging.dshHasString(baseline.tag, dc.hostRpcNeedle, dc.hostRpcFile), true, 'host RPC registry face')
      assert.equal(staging.dshHasString(baseline.tag, dc.clientRpcNeedle, dc.clientRpcFile), true, 'browser RPC caller face')
      assert.equal(staging.dshHasString(baseline.tag, dc.registryNeedle, dc.registryFile), true, 'registry stateOf face')
    })

    test('client: the right Sidebar tab seam', () => {
      const sidebar = baseline.client.sidebar
      assert.equal(staging.dshHasString(baseline.tag, sidebar.serviceNeedle, sidebar.serviceFile), true, 'tab-type registry service')
      assert.equal(staging.dshHasString(baseline.tag, sidebar.slotNeedle, sidebar.slotFile), true, 'keyed body seat')
      assert.equal(staging.dshHasString(baseline.tag, sidebar.titleSlotNeedle, sidebar.slotFile), true, 'keyed chip-title seat')
      assert.equal(staging.dshHasString(baseline.tag, sidebar.nav.needle, sidebar.nav.file), true, 'resource navigation face (openResource)')
    })

    test('client: the right Sidebar guide-entry contract (the contribution\'s shape)', () => {
      for (const field of baseline.client.sidebar.guideEntry.fields) {
        assert.equal(staging.dshHasString(baseline.tag, field, baseline.client.sidebar.guideEntry.file), true, `guide-entry field: ${field}`)
      }
    })

    test('client: the session-jump seam of this generation (issue #90)', () => {
      const nav = baseline.client.sessionNav
      assert.equal(
        staging.dshHasString(baseline.tag, nav.workspaceNeedle, nav.workspaceFile),
        true,
        'the view-owner navigation verb (uiWorkspace.openSession)',
      )
      assert.equal(
        staging.dshHasString(baseline.tag, 'open(id: SessionId): void', nav.sessionsFile),
        nav.sessionsOpen,
        'the retired sessions-service selection verb',
      )
    })

    test('client: the subagent history-address resolver (issue #193)', () => {
      const seam = baseline.client.subagentAddress
      assert.equal(
        staging.dshHasString(baseline.tag, seam.needle, seam.file),
        true,
        'the sessions direct-parent resolver (subagentAddress)',
      )
      assert.equal(
        staging.dshHasString(baseline.tag, seam.summaryNeedle, seam.file),
        seam.summaryFallback,
        'the listed-summary fallback',
      )
    })

    test('client: the Plugins-panel navigator the settings jump rides', () => {
      const nav = baseline.client.pluginsNav
      assert.equal(
        staging.dshHasString(baseline.tag, nav.needle, nav.file),
        true,
        'the panel-owned openBundle verb (pluginNavigation)',
      )
      assert.equal(
        staging.dshHasString(baseline.tag, nav.tabResetNeedle, nav.file),
        nav.tabReset,
        'the navigator resets the remembered tab to Installed',
      )
      assert.equal(
        staging.dshHasString(baseline.tag, nav.tabsSlotNeedle, nav.tabsSlotFile),
        nav.tabsSlot,
        'the contributed-tab slot the reset guards',
      )
    })

    test('client: the first-level insight page seam (keyed main panel + sidebar panel list)', () => {
      const page = baseline.client.insightPage
      assert.equal(staging.dshHasString(baseline.tag, page.panellistNeedle, page.panellistFile), true, 'the sidebar panel-list seat')
      assert.equal(staging.dshHasString(baseline.tag, page.mainNeedle, page.mainFile), true, 'the layout\'s keyed main panel seat')
    })

    test('client: the slot-ledger read of the second-mount guard (dsh-context#137)', () => {
      const ledger = baseline.client.ledger
      assert.equal(
        staging.dshHasString(baseline.tag, ledger.needle, ledger.file),
        true,
        'the raw SlotCore.entries view',
      )
    })

    test('client: MarkdownText chrome prop', () => {
      assert.equal(staging.dshHasString(baseline.tag, baseline.client.markdownChrome, 'packages/client/ui-primitives/src/markdown/MarkdownText.tsx'), true)
    })

    test('client: the JsonTree faces the rich-text JSON body rides', () => {
      const tree = baseline.client.jsonTree
      for (const needle of tree.needles) {
        assert.equal(staging.dshHasString(baseline.tag, needle, tree.file), true, `JsonTree seam: ${needle}`)
      }
    })

    test('client: the command panel\'s coloring seam', () => {
      for (const { file, needle, what } of baseline.client.codeHighlight) {
        assert.equal(staging.dshHasString(baseline.tag, needle, file), true, `${what} (${needle})`)
      }
    })

    test('client: the icon seams resolve on this generation (primitives.ts)', () => {
      for (const name of staging.ICON_SEAMS) {
        const present = staging.dshHasString(baseline.tag, name, 'packages/client/ui-primitives/src/**')
        assert.equal(present, true, `icon seam: ${name}`)
      }
    })

    test('host: the fold\'s event vocabulary for this generation exists in the durable log', async () => {
      const known = await staging.knownEventTypesOf(baseline)
      const missing = baseline.foldEventTypes.filter(type => !known.has(type))
      assert.deepEqual(missing, [])
    })

    test('host: the step-boundary identity guard seam (issue #51)', () => {
      const sg = baseline.stepGuard
      for (const needle of sg.loopNeedles) {
        assert.equal(staging.dshHasString(baseline.tag, needle, sg.loopFile), true, `loop seam: ${needle}`)
      }
      assert.equal(
        staging.dshHasString(baseline.tag, 'prepend: true', sg.prependProofFile),
        true,
        'the prepend listener option the guard rides',
      )
    })

    test('host: the system-prompt injection seam', () => {
      const prompt = baseline.prompt
      assert.equal(
        staging.dshHasString(baseline.tag, prompt.sectionNeedle, prompt.serviceFile),
        true,
        'the ordered-section face',
      )
      for (const anchor of prompt.orderAnchors) {
        assert.equal(staging.dshHasString(baseline.tag, anchor, prompt.serviceFile), true, `order anchor: ${anchor}`)
      }
      assert.equal(
        staging.dshHasString(baseline.tag, prompt.loaderVolatileNeedle, prompt.loaderVolatileFile),
        true,
        'the loader volatile-only commit',
      )
    })

    test('client: platform module table answers every bundle require', async () => {
      const table = await staging.platformModulesOf(baseline)
      const unanswerable = staging.bundleRequires().filter(spec => !table.includes(spec))
      assert.deepEqual(unanswerable, [])
    })
  })
})
