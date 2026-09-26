// The compatibility matrix as a vitest project (`compat`): the REAL-CODE
// regression for the supported dsh baselines (tests/baselines.ts). The
// always-on host/client lanes pin the plugin against MIRRORED seam
// semantics; this project runs the plugin against the harness's ACTUAL
// sources at each baseline tag — the tag's real `SessionProjectionRegistry`
// on the cordis release that line vendors, the tag's own settings-namespace
// pattern, its durable-event vocabulary, its platform module table, and its
// client seam sources (slots, seats, image/history faces, markdown chrome).
// A failing probe names the SEAM — the connection point to re-fit or
// refactor — not just "it broke somewhere".
//
// Preconditions (skipped cleanly when absent; the release workflow fetches
// the baseline tags before `pnpm test`, so it always runs there):
//   - a dsh checkout with the baseline tags (env DSH_REPO, default
//     ~/dev/deepseek-harness),
//   - the built plugin (`pnpm run build` first — the matrix exercises the
//     BUILT artifacts, lib/index.js + lib/client.js).

import assert from 'node:assert/strict'
import { beforeAll, describe, test } from 'vitest'
import { BASELINES } from '../baselines'
import * as staging from './staging'

const reasons = staging.skipReasons()
if (reasons.length > 0) {
  console.warn(`[compat] matrix skipped — ${reasons.join('; ')}`)
}

// The always-runnable part (no checkout needed): every specifier the built
// bundle requires at runtime must be seeded by EACH baseline's platform
// module table — a require the shell cannot answer is a guaranteed boot
// crash on that generation.
describe('compat matrix — the per-baseline fold vocabularies', () => {
  test('their union covers every event family the fold switches on', () => {
    const union = new Set(BASELINES.flatMap(baseline => baseline.foldEventTypes))
    assert.deepEqual(
      staging.FOLD_EVENT_TYPES.filter(type => !union.has(type)),
      [],
      'a fold case no baseline declares would go unprobed',
    )
  })
})

describe.skipIf(staging.artifactsMissing())('compat matrix — bundle requires vs baseline module tables', () => {
  test.each(BASELINES)('$id: the platform module table answers every bundle require', (baseline) => {
    assert.deepEqual(
      staging.bundleRequires().filter(spec => !baseline.client.platformModules.includes(spec)),
      [],
    )
  })
})

describe.skipIf(reasons.length > 0)('compat matrix — real dsh sources per baseline', () => {
  describe.each(BASELINES)('$id (tag $tag, cordis $cordis)', (baseline) => {
    let report: staging.DriverReport
    // 60s: the driver's own spawn budget. A cold stage dir (fresh clone,
    // cache miss, dependency re-pin) runs a real npm install inside the hook,
    // which the 10s default ceiling cannot cover.
    beforeAll(() => {
      report = staging.runDriver(baseline)
    }, 60_000)

    test('host: the plugin applies into the tag\'s real registry', () => {
      assert.equal(report.registered, true)
    })

    test('host: all three projection values served through the wire', () => {
      assert.deepEqual(report.keys, ['contextActivity', 'contextHeaders', 'contextTimeline'])
    })

    test('host: checkpoint rows pass the tag\'s lossless-JSON cache-write gate', () => {
      assert.equal(report.gateOk, true)
    })

    test('host: cold restore refolds to the live snapshot', () => {
      assert.equal(report.coldMatches, true)
    })

    test('host: hostile gateway usage keeps the served view schema-valid (issue #44)', () => {
      // Negative uncached input (cached_tokens > prompt_tokens), fractional
      // counts, string buckets, and a hostile NaN must all survive the REAL
      // registry's strict wire parse — billed from sanitized buckets, never
      // frozen.
      assert.equal(report.hostileSnapshotOk, true)
      assert.equal(report.hostilePrompt, 161)
      assert.equal(report.hostileCacheRead, 151)
    })

    test('host: a poisoned upstream unit starves downstream units and throws the whole snapshot (dsh containment gap)', () => {
      // The registry drives every unit in ONE uncontained loop: the first
      // schema-invalid view throws out of drive() per event, units registered
      // after it stop receiving events entirely, and snapshot() — every
      // reconnect baseline — throws wholesale. The plugin cannot fix this
      // seam from outside; the probe pins the defect to the dsh generation.
      assert.ok(report.poisonedEscapedDrive >= 1)
      assert.equal(report.poisonedStarves, true)
      assert.equal(report.poisonedSnapshotThrows, true)
    })

    test('settings: the tag\'s namespace surface matches the plugin\'s feature-detected faces', () => {
      const settings = baseline.settings
      // The register face the host half calls (and feature-detects): present
      // through V3, gone on the V4+ Config-form generations.
      assert.equal(
        staging.dshHasString(baseline.tag, 'register(', settings.serviceFile),
        settings.register,
        'the settings service register face',
      )
      // Where the generation enforces a namespace pattern it must accept the
      // plugin literal; where it does not (the pattern source is gone), the
      // register probe above already pins the plugin's inert path.
      if (settings.patternFile === undefined) return
      const pattern = staging.namespacePatternOf(baseline, settings.patternFile)
      assert.ok(pattern !== null, 'the tag source carries NAMESPACE_PATTERN')
      assert.equal(pattern.test('dsh-context'), true)
    })

    test('balance: the settings face and the DeepSeek provider row the facts fold reads', () => {
      // The balance route resolves the provider's settings row through the
      // face this generation serves — the `get(ns)` section read through V3,
      // the Config-form `describe()` projection on V4+ (the row matched by
      // its own apiKeyEnv-bearing section shape). Presence asserted both
      // ways, so a moved seam names itself instead of silently hiding the
      // capsule.
      const balance = baseline.balance
      assert.equal(
        staging.dshHasString(baseline.tag, balance.settingsGetNeedle, balance.settingsFile),
        balance.settingsGetPresent,
        'the settings service get face',
      )
      if (balance.settingsDescribeNeedle !== undefined) {
        assert.equal(
          staging.dshHasString(baseline.tag, balance.settingsDescribeNeedle, balance.settingsFile),
          true,
          'the settings service describe face',
        )
      }
      for (const provider of balance.providerFiles) {
        for (const needle of provider.needles) {
          assert.equal(staging.dshHasString(baseline.tag, needle, provider.file), true, `provider seam: ${needle}`)
        }
      }
    })

    for (const slot of staging.SLOT_SEAMS) {
      test(`client: slot "${slot}" exists`, () => {
        assert.equal(staging.dshHasString(baseline.tag, slot, 'packages/client/*/src/**'), true)
      })
    }

    test('client: the preferences card seat and transport match the generation', () => {
      // The keyed slot the browser half's card registers on and the settings
      // transport it rides: `settings.plugin.item` + `settingsScope` through
      // V3, the Plugins page's `plugins.bundle.config` + `configForms` from
      // the Config-form generation on. Asserted BOTH ways (like the sidebar
      // seam) so a moved seam cannot read as "unsupported here" — a slot the
      // generation does not declare simply never receives the registration.
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
      // dockMeasure reads the LEADING `Npx` track off the frame's inline
      // gridTemplateColumns; `px minmax(` pins a sidebar-first multi-track
      // template without pinning the newer generations' center/right spellings.
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
      // The view owner's navigation verb (the sidebar row click's own), with
      // the signature this line spells; and the retired sessions-service
      // `open(id)` selection verb, declared exactly where the line still has it.
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

    test('client: MarkdownText chrome prop', () => {
      assert.equal(staging.dshHasString(baseline.tag, baseline.client.markdownChrome, 'packages/client/ui-primitives/src/markdown/MarkdownText.tsx'), true)
    })

    test('client: the icon seams resolve on this generation (primitives.ts)', () => {
      for (const [modern, legacy] of staging.ICON_SEAMS) {
        const present = staging.dshHasString(baseline.tag, modern, 'packages/client/ui-primitives/src/**')
          || staging.dshHasString(baseline.tag, legacy, 'packages/client/ui-primitives/src/**')
        assert.equal(present, true, `icon seam: ${modern} | ${legacy}`)
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

    test('client: platform module table answers every bundle require', async () => {
      const table = await staging.platformModulesOf(baseline)
      const unanswerable = staging.bundleRequires().filter(spec => !table.includes(spec))
      assert.deepEqual(unanswerable, [])
    })
  })
})
