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
  beforeAll(() => {
    staging.primeBaselines(BASELINES)
  })

  describe.each(BASELINES)('$id (tag $tag, cordis $cordis)', (baseline) => {
    let report: staging.DriverReport
    beforeAll(async () => {
      report = await staging.runDriver(baseline)
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

    test('admission: the tag gate admits this manifest and refuses the dropped 0.1.7 line', async () => {
      const admission = await staging.evaluateAdmission(baseline)
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

    test('settings: the retired register face stays gone (the plugin never calls it)', async () => {
      assert.equal(
        await staging.dshHasString(baseline.tag, 'register(', baseline.settings.serviceFile),
        baseline.settings.register,
        'the settings service register face',
      )
    })

    test('balance: the settings face, the DeepSeek provider row, and the signed-in account wallet service', async () => {
      const balance = baseline.balance
      const [getFace, describeFace, redact, directory, stockHits, providerHits, service, accountProvider, bundle] = await Promise.all([
        staging.dshHasString(baseline.tag, balance.settingsGetNeedle, balance.settingsFile),
        staging.dshHasString(baseline.tag, balance.settingsDescribeNeedle, balance.settingsFile),
        staging.dshHasString(baseline.tag, balance.settingsRedactNeedle, balance.settingsFile),
        staging.dshHasString(baseline.tag, balance.providerDirectory.needle, balance.providerDirectory.file),
        Promise.all(balance.stockIds.ids.map(id =>
          staging.dshHasString(baseline.tag, `id: ${id}$`, balance.stockIds.file),
        )),
        Promise.all(balance.providerFiles.map(provider =>
          Promise.all(provider.needles.map(needle =>
            staging.dshHasString(baseline.tag, needle, provider.file),
          )),
        )),
        staging.dshHasString(baseline.tag, balance.account.serviceNeedle, balance.account.serviceFile),
        staging.dshHasString(baseline.tag, balance.account.providerNeedle, balance.account.providerFile),
        staging.dshHasString(baseline.tag, balance.account.bundleNeedle, balance.account.bundleFile),
      ])
      assert.equal(getFace, balance.settingsGetPresent, 'the settings service get face')
      assert.equal(describeFace, true, 'the settings service describe face')
      assert.equal(redact, true, 'the settings service redaction option')
      assert.equal(directory, true, 'the llm provider directory face')
      assert.equal(service, true, 'the deepseekAccount getBalance face')
      assert.equal(accountProvider, true, 'the account platform getBalance implementation')
      assert.equal(bundle, true, 'the base bundle mounts the account platform')
      for (const [index, id] of balance.stockIds.ids.entries()) {
        assert.equal(stockHits[index], true, `the DeepSeek stock entry id: ${id}`)
      }
      for (const [pIndex, provider] of balance.providerFiles.entries()) {
        for (const [nIndex, needle] of provider.needles.entries()) {
          assert.equal(providerHits[pIndex][nIndex], true, `provider seam: ${needle}`)
        }
      }
    })

    test('host: the sliced cold fold faces exist (else the backfill falls back to whole-log blocks)', async () => {
      const fold = baseline.backfillFold
      const needles = [
        [fold.registryFile, '  restore('],
        [fold.registryFile, '  hydrate('],
        [fold.storeFile, '  prepare('],
        [fold.cacheFile, '  async write('],
        [fold.cacheFile, '  coldSnapshot('],
      ] as const
      const hits = await Promise.all(needles.map(([file, needle]) =>
        staging.dshHasString(baseline.tag, needle, file),
      ))
      for (const [index, [file, needle]] of needles.entries()) {
        assert.equal(hits[index], true, `sliced-fold seam: ${needle} in ${file}`)
      }
    })

    for (const slot of staging.SLOT_SEAMS) {
      test(`client: slot "${slot}" exists`, async () => {
        assert.equal(await staging.dshHasString(baseline.tag, slot, 'packages/client/*/src/**'), true)
      })
    }

    test('client: the preferences card seat and transport match the generation', async () => {
      const settings = baseline.settings
      const [cardSlot, transport] = await Promise.all([
        Promise.all(settings.cardSlotFiles.map(pattern =>
          staging.dshHasString(baseline.tag, `'${settings.cardSlot}'`, pattern),
        )),
        staging.dshHasString(baseline.tag, `'${settings.transport}'`, settings.transportFile),
      ])
      assert.equal(
        cardSlot.some(present => present),
        true,
        `the card slot "${settings.cardSlot}" is declared on this generation`,
      )
      assert.equal(transport, settings.transportPresent, `the settings transport "${settings.transport}"`)
    })

    test('client: the app frame carries the inline sidebar-leading grid track (modal dock seam, dockMeasure.ts)', async () => {
      assert.equal(
        await staging.dshHasString(baseline.tag, 'px minmax(', 'packages/client/ui-layout/src/client/AppFrame.tsx'),
        true,
      )
    })

    test('client: finalized-nodes seat (useChat ChatSnapshot)', async () => {
      assert.equal(await staging.dshHasString(baseline.tag, 'useChat', 'packages/client/ui-chat/src/client/contract/slots.ts'), true)
    })

    test('client: durable-image loader service', async () => {
      assert.equal(await staging.dshHasString(baseline.tag, baseline.client.imageFaceMethod, 'packages/client/*/src/**'), true)
    })

    test('client: the gateway history face of this generation', async () => {
      const [remote, envelope] = await Promise.all([
        staging.dshHasString(baseline.tag, "'remote.session'", 'packages/api/*/src/**'),
        staging.dshHasString(baseline.tag, 'records: frame.records', 'packages/api/session-controller/src/client/transport.ts'),
      ])
      assert.equal(remote, true)
      assert.equal(envelope, true, 'the history page envelope key')
    })

    test('detail channel: the Connection RPC faces and the registry state read faces exist', async () => {
      const dc = baseline.client.detailChannel
      const [hostRpc, clientRpc, registry, fallback, awaitable] = await Promise.all([
        staging.dshHasString(baseline.tag, dc.hostRpcNeedle, dc.hostRpcFile),
        staging.dshHasString(baseline.tag, dc.clientRpcNeedle, dc.clientRpcFile),
        staging.dshHasString(baseline.tag, dc.registryNeedle, dc.registryFile),
        staging.dshHasString(baseline.tag, dc.fallbackStateOfNeedle, dc.registryFile),
        staging.dshHasString(baseline.tag, 'Promise<ProjectionHandle<S>>', dc.registryFile),
      ])
      assert.equal(hostRpc, true, 'host RPC registry face')
      assert.equal(clientRpc, true, 'browser RPC caller face')
      assert.equal(registry, true, 'registry stateOf face')
      assert.equal(fallback, true, 'registry keyed stateOf fallback')
      assert.equal(awaitable, dc.awaitableRegister, 'the registration return the gate retains a handle from')
    })

    test('client: the right Sidebar tab seam', async () => {
      const sidebar = baseline.client.sidebar
      const [service, slot, titleSlot, nav] = await Promise.all([
        staging.dshHasString(baseline.tag, sidebar.serviceNeedle, sidebar.serviceFile),
        staging.dshHasString(baseline.tag, sidebar.slotNeedle, sidebar.slotFile),
        staging.dshHasString(baseline.tag, sidebar.titleSlotNeedle, sidebar.slotFile),
        staging.dshHasString(baseline.tag, sidebar.nav.needle, sidebar.nav.file),
      ])
      assert.equal(service, true, 'tab-type registry service')
      assert.equal(slot, true, 'keyed body seat')
      assert.equal(titleSlot, true, 'keyed chip-title seat')
      assert.equal(nav, true, 'resource navigation face (openResource)')
    })

    test('client: the right Sidebar guide-entry contract (the contribution\'s shape)', async () => {
      const guide = baseline.client.sidebar.guideEntry
      const hits = await Promise.all(guide.fields.map(field =>
        staging.dshHasString(baseline.tag, field, guide.file),
      ))
      for (const [index, field] of guide.fields.entries()) {
        assert.equal(hits[index], true, `guide-entry field: ${field}`)
      }
    })

    test('client: the session-jump seam of this generation (issue #90)', async () => {
      const nav = baseline.client.sessionNav
      const [workspace, sessions] = await Promise.all([
        staging.dshHasString(baseline.tag, nav.workspaceNeedle, nav.workspaceFile),
        staging.dshHasString(baseline.tag, 'open(id: SessionId): void', nav.sessionsFile),
      ])
      assert.equal(workspace, true, 'the view-owner navigation verb (uiWorkspace.openSession)')
      assert.equal(sessions, nav.sessionsOpen, 'the retired sessions-service selection verb')
    })

    test('client: the subagent history-address resolver (issue #193)', async () => {
      const seam = baseline.client.subagentAddress
      const [address, summary] = await Promise.all([
        staging.dshHasString(baseline.tag, seam.needle, seam.file),
        staging.dshHasString(baseline.tag, seam.summaryNeedle, seam.file),
      ])
      assert.equal(address, true, 'the sessions direct-parent resolver (subagentAddress)')
      assert.equal(summary, seam.summaryFallback, 'the listed-summary fallback')
    })

    test('client: the Plugins-panel navigator the settings jump rides', async () => {
      const nav = baseline.client.pluginsNav
      const [panel, tabReset, tabsSlot] = await Promise.all([
        staging.dshHasString(baseline.tag, nav.needle, nav.file),
        staging.dshHasString(baseline.tag, nav.tabResetNeedle, nav.file),
        staging.dshHasString(baseline.tag, nav.tabsSlotNeedle, nav.tabsSlotFile),
      ])
      assert.equal(panel, true, 'the panel-owned openBundle verb (pluginNavigation)')
      assert.equal(tabReset, nav.tabReset, 'the navigator resets the remembered tab to Installed')
      assert.equal(tabsSlot, nav.tabsSlot, 'the contributed-tab slot the reset guards')
    })

    test('client: the first-level insight page seam (keyed main panel + sidebar panel list)', async () => {
      const page = baseline.client.insightPage
      const [panellist, main] = await Promise.all([
        staging.dshHasString(baseline.tag, page.panellistNeedle, page.panellistFile),
        staging.dshHasString(baseline.tag, page.mainNeedle, page.mainFile),
      ])
      assert.equal(panellist, true, 'the sidebar panel-list seat')
      assert.equal(main, true, 'the layout\'s keyed main panel seat')
    })

    test('client: the slot-ledger read of the second-mount guard (dsh-context#137)', async () => {
      const ledger = baseline.client.ledger
      assert.equal(
        await staging.dshHasString(baseline.tag, ledger.needle, ledger.file),
        true,
        'the raw SlotCore.entries view',
      )
    })

    test('client: MarkdownText chrome prop', async () => {
      assert.equal(await staging.dshHasString(baseline.tag, baseline.client.markdownChrome, 'packages/client/ui-primitives/src/markdown/MarkdownText.tsx'), true)
    })

    test('client: the JsonTree faces the rich-text JSON body rides', async () => {
      const tree = baseline.client.jsonTree
      const hits = await Promise.all(tree.needles.map(needle =>
        staging.dshHasString(baseline.tag, needle, tree.file),
      ))
      for (const [index, needle] of tree.needles.entries()) {
        assert.equal(hits[index], true, `JsonTree seam: ${needle}`)
      }
    })

    test('client: the command panel\'s coloring seam', async () => {
      const hits = await Promise.all(baseline.client.codeHighlight.map(({ file, needle }) =>
        staging.dshHasString(baseline.tag, needle, file),
      ))
      for (const [index, { needle, what }] of baseline.client.codeHighlight.entries()) {
        assert.equal(hits[index], true, `${what} (${needle})`)
      }
    })

    test('client: the icon seams resolve on this generation (primitives.ts)', async () => {
      const hits = await Promise.all(staging.ICON_SEAMS.map(name =>
        staging.dshHasString(baseline.tag, name, 'packages/client/ui-primitives/src/**'),
      ))
      for (const [index, name] of staging.ICON_SEAMS.entries()) {
        assert.equal(hits[index], true, `icon seam: ${name}`)
      }
    })

    test('host: the fold\'s event vocabulary for this generation exists in the durable log', async () => {
      const known = await staging.knownEventTypesOf(baseline)
      const missing = baseline.foldEventTypes.filter(type => !known.has(type))
      assert.deepEqual(missing, [])
    })

    test('host: the step-boundary identity guard seam (issue #51)', async () => {
      const sg = baseline.stepGuard
      const [loops, prepend] = await Promise.all([
        Promise.all(sg.loopNeedles.map(needle => staging.dshHasString(baseline.tag, needle, sg.loopFile))),
        staging.dshHasString(baseline.tag, 'prepend: true', sg.prependProofFile),
      ])
      for (const [index, needle] of sg.loopNeedles.entries()) {
        assert.equal(loops[index], true, `loop seam: ${needle}`)
      }
      assert.equal(prepend, true, 'the prepend listener option the guard rides')
    })

    test('host: the system-prompt injection seam', async () => {
      const prompt = baseline.prompt
      const [section, anchors, loaderVolatile] = await Promise.all([
        staging.dshHasString(baseline.tag, prompt.sectionNeedle, prompt.serviceFile),
        Promise.all(prompt.orderAnchors.map(anchor => staging.dshHasString(baseline.tag, anchor, prompt.serviceFile))),
        staging.dshHasString(baseline.tag, prompt.loaderVolatileNeedle, prompt.loaderVolatileFile),
      ])
      assert.equal(section, true, 'the ordered-section face')
      for (const [index, anchor] of prompt.orderAnchors.entries()) {
        assert.equal(anchors[index], true, `order anchor: ${anchor}`)
      }
      assert.equal(loaderVolatile, true, 'the loader volatile-only commit')
    })

    test('client: platform module table answers every bundle require', async () => {
      const table = await staging.platformModulesOf(baseline)
      const unanswerable = staging.bundleRequires().filter(spec => !table.includes(spec))
      assert.deepEqual(unanswerable, [])
    })
  })
})
