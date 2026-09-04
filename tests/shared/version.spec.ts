// The version gate's arithmetic (src/shared/version.ts): parsing, the total
// order (release > rc > beta > alpha at equal X.Y.Z), and the fail-open
// baseline check.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { BASELINE_DSH_VERSION, compareVersions, meetsBaseline, parseVersion } from '../../src/shared/version'

describe('parseVersion', () => {
  test('parses plain releases, channels, serials, v-prefixes and build metadata', () => {
    assert.deepEqual(parseVersion('0.1.2-rc.1'), { major: 0, minor: 1, patch: 2, rank: 3, serial: 1 })
    assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, rank: 4, serial: 0 })
    assert.deepEqual(parseVersion('v2.0.0-alpha'), { major: 2, minor: 0, patch: 0, rank: 1, serial: 0 })
    assert.deepEqual(parseVersion('0.1.2-beta.3'), { major: 0, minor: 1, patch: 2, rank: 2, serial: 3 })
    assert.deepEqual(parseVersion(' 0.1.2-RC.2 '), { major: 0, minor: 1, patch: 2, rank: 3, serial: 2 })
    assert.deepEqual(parseVersion('1.0.0+build.5'), { major: 1, minor: 0, patch: 0, rank: 4, serial: 0 })
  })

  test('rejects non-semver strings', () => {
    for (const bad of ['', 'abc', '1.2', '1.2.3.4', '1.2.3-nightly', '1.2.3-rc.x', '0.0.0-dev', 'v1.2.3.4-something']) {
      assert.equal(parseVersion(bad), null, bad)
    }
  })
})

describe('compareVersions', () => {
  test('orders numerically, then channel (release > rc > beta > alpha), then serial', () => {
    assert.ok(compareVersions('1.0.0', '0.9.9') > 0)
    assert.ok(compareVersions('0.2.0', '0.1.9') > 0)
    assert.ok(compareVersions('0.1.3', '0.1.2') > 0)
    assert.ok(compareVersions('0.1.2', '0.1.2-rc.9') > 0, 'final outranks rc')
    assert.ok(compareVersions('0.1.2-rc.1', '0.1.2-beta.9') > 0, 'rc outranks beta')
    assert.ok(compareVersions('0.1.2-beta.1', '0.1.2-alpha.9') > 0, 'beta outranks alpha')
    assert.ok(compareVersions('0.1.2-rc.2', '0.1.2-rc.1') > 0, 'higher serial wins')
    assert.equal(compareVersions('0.1.2-rc.1', '0.1.2-rc.1'), 0)
    assert.ok(compareVersions('0.1.3-alpha.1', '0.1.2') > 0, 'a newer X.Y.Z beats any older channel')
  })

  test('an unparseable side compares equal', () => {
    assert.equal(compareVersions('dev-build', '0.1.2'), 0)
    assert.equal(compareVersions('0.1.2', 'dev-build'), 0)
  })
})

describe('meetsBaseline', () => {
  test(`the supported baseline is ${BASELINE_DSH_VERSION}`, () => {
    assert.equal(BASELINE_DSH_VERSION, '0.1.2-rc.1')
  })

  test('baseline and above pass; anything below fails', () => {
    assert.equal(meetsBaseline('0.1.2-rc.1'), true, 'the baseline itself')
    assert.equal(meetsBaseline('0.1.2-rc.2'), true)
    assert.equal(meetsBaseline('0.1.2'), true, 'the final release of the baseline line')
    assert.equal(meetsBaseline('0.1.3-alpha.1'), true)
    assert.equal(meetsBaseline('0.1.1-rc.2'), false)
    assert.equal(meetsBaseline('0.1.2-beta.3'), false, 'beta is below rc at equal X.Y.Z')
    assert.equal(meetsBaseline('0.1.2-alpha.1'), false)
    assert.equal(meetsBaseline('0.0.9'), false)
  })

  test('fails open: an unparseable version (or baseline) never gates', () => {
    assert.equal(meetsBaseline('0.0.0-dev'), true)
    assert.equal(meetsBaseline('not-a-version'), true)
    assert.equal(meetsBaseline('0.1.0', 'also-junk'), true)
  })

  test('accepts an explicit baseline', () => {
    assert.equal(meetsBaseline('0.1.2-rc.1', '0.2.0'), false)
    assert.equal(meetsBaseline('0.2.0', '0.2.0-alpha.1'), true)
  })
})
