import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'vitest'
import semver from 'semver'
import { BASELINES } from '../baselines'
import { BASELINE_DSH_VERSION, meetsBaseline } from '../../src/shared/version'

const REPO = new URL('../..', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, REPO), 'utf8')

interface Manifest {
  engines: { dsh: string }
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
  dsh: { compatibility: { dshReleases: Record<string, string> } }
}
const manifest = JSON.parse(read('package.json')) as Manifest
const versions = BASELINES.map(baseline => baseline.version)
const floorOf = (term: string): string => {
  const match = />=([^ ]+)/.exec(term.trim())
  if (match === null) throw new Error(`range term carries no floor: ${term}`)
  return match[1]
}
const floorsOf = (range: string): string[] => range.split('||').map(floorOf)
const satisfies = (version: string, range: string): boolean => semver.satisfies(version, range, { includePrerelease: true })

describe('supported-set lockstep', () => {
  test('dshReleases, baselines and the CI tag fetches name the same per-line floors', () => {
    assert.deepEqual(
      manifest.dsh.compatibility.dshReleases,
      Object.fromEntries(versions.map(version => [`${version}+`, 'compatible'])),
    )
    for (const artifact of ['.github/workflows/pr-checks.yml', '.github/workflows/release.yml']) {
      const tags = [...read(artifact).matchAll(/refs\/tags\/(dsh-v[0-9a-z.-]+)/gi)].map(match => match[1])
      assert.deepEqual([...new Set(tags)].sort(), BASELINES.map(baseline => baseline.tag).sort(), artifact)
    }
  })

  test('engines.dsh and the dsh peer floors admit every floor release and its line finals, and refuse the dropped 0.1.7 line', () => {
    const finals = versions.map(version => version.replace(/-(?:alpha|beta|rc)(?:\.\d+)?$/, ''))
    for (const range of [manifest.engines.dsh, ...['@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-session'].map(name => manifest.peerDependencies[name])]) {
      for (const version of [...versions, ...finals, '0.2.2-alpha.3']) {
        assert.ok(satisfies(version, range), `${version} inside ${range}`)
      }
      for (const refused of ['0.1.7', '0.1.7-rc.2', '0.2.0-rc.1']) {
        assert.equal(satisfies(refused, range), false, `${refused} outside ${range}`)
      }
    }
  })

  test('the runtime floor is the lowest engines floor and the compiled dsh pins', () => {
    const floors = floorsOf(manifest.engines.dsh)
    const lowest = floors.reduce((min, floor) => (meetsBaseline(floor, min) ? min : floor))
    assert.equal(BASELINE_DSH_VERSION, lowest)
    for (const name of ['@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-util-code-language', '@deepseek-ai/dsh-util-workspace-path']) {
      assert.equal(manifest.devDependencies[name], lowest, `${name} is pinned to the floor surface`)
    }
  })
})
