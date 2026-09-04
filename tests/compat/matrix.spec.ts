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

    test('host: both projection values served through the wire', () => {
      assert.deepEqual(report.keys, ['contextHeaders', 'contextTimeline'])
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

    test('settings: the tag\'s namespace enforcement accepts the plugin literal', () => {
      const pattern = staging.namespacePatternOf(baseline)
      assert.ok(pattern !== null, 'the tag source carries NAMESPACE_PATTERN')
      assert.equal(pattern.test('dsh-context'), true)
    })

    for (const slot of staging.SLOT_SEAMS) {
      test(`client: slot "${slot}" exists`, () => {
        assert.equal(staging.dshHasString(baseline.tag, slot, 'packages/client/*/src/**'), true)
      })
    }

    test('client: the app frame carries the inline sidebar track (modal dock seam, dockMeasure.ts)', () => {
      assert.equal(
        staging.dshHasString(baseline.tag, '${cols.sidebar}px minmax(0, 1fr)', 'packages/client/ui-layout/src/client/AppFrame.tsx'),
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

    test('client: MarkdownText chrome prop', () => {
      assert.equal(staging.dshHasString(baseline.tag, baseline.client.markdownChrome, 'packages/client/ui-primitives/src/markdown/MarkdownText.tsx'), true)
    })

    test('host: the fold\'s event vocabulary exists in the durable log', async () => {
      const known = await staging.knownEventTypesOf(baseline)
      const missing = staging.FOLD_EVENT_TYPES.filter(type => !known.has(type))
      assert.deepEqual(missing, [])
    })

    test('client: platform module table answers every bundle require', async () => {
      const table = await staging.platformModulesOf(baseline)
      const unanswerable = staging.bundleRequires().filter(spec => !table.includes(spec))
      assert.deepEqual(unanswerable, [])
    })
  })
})
