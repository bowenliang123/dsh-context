import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeScanWindow, type ScanResult } from '../../src/host/overviewScan'

function result(id: string): ScanResult {
  return { entries: [], coldIds: new Set([id]), identitiesSynced: false }
}

describe('scan window', () => {
  test('reuses a fresh scan for the same version and rescans after ttl or version change', async () => {
    let clock = 0
    let version = 1
    let loads = 0
    const window = makeScanWindow(1_000, () => clock)
    const load = async (): Promise<ScanResult> => {
      loads++
      return result(String(loads))
    }
    assert.equal((await window.read(load, () => version)).coldIds.has('1'), true)
    assert.equal((await window.read(load, () => version)).coldIds.has('1'), true)
    assert.equal(loads, 1)
    clock = 999
    await window.read(load, () => version)
    assert.equal(loads, 1)
    clock = 1_000
    await window.read(load, () => version)
    assert.equal(loads, 2)
    version = 2
    await window.read(load, () => version)
    assert.equal(loads, 3)
    window.reset()
    await window.read(load, () => version)
    assert.equal(loads, 4)
  })

  test('coalesces concurrent loads', async () => {
    let release: (value: ScanResult) => void = () => {}
    let loads = 0
    const window = makeScanWindow(1_000, () => 0)
    const load = (): Promise<ScanResult> => {
      loads++
      return new Promise((resolve) => { release = resolve })
    }
    const first = window.read(load, () => 1)
    const second = window.read(load, () => 1)
    assert.equal(loads, 1)
    const value = result('1')
    release(value)
    assert.equal(await first, value)
    assert.equal(await second, value)
  })

  test('a reset during a load does not cache the stale scan', async () => {
    let release: (value: ScanResult) => void = () => {}
    let loads = 0
    const window = makeScanWindow(1_000, () => 0)
    const load = (): Promise<ScanResult> => {
      loads++
      return new Promise((resolve) => { release = resolve })
    }
    const pending = window.read(load, () => 1)
    window.reset()
    const stale = result('stale')
    release(stale)
    assert.equal(await pending, stale)
    const fresh = await window.read(async () => {
      loads++
      return result('fresh')
    }, () => 1)
    assert.equal(fresh.coldIds.has('fresh'), true)
    assert.equal(loads, 2)
  })

  test('stamps the version read after the load', async () => {
    let version = 1
    let release: (value: ScanResult) => void = () => {}
    let loads = 0
    const window = makeScanWindow(1_000, () => 0)
    const pending = window.read(() => {
      loads++
      return new Promise((resolve) => { release = resolve })
    }, () => version)
    version = 2
    release(result('a'))
    await pending
    const cached = await window.read(async () => {
      loads++
      return result('b')
    }, () => version)
    assert.equal(cached.coldIds.has('a'), true)
    assert.equal(loads, 1)
  })

  test('a failed load clears the in-flight slot', async () => {
    let loads = 0
    const window = makeScanWindow(1_000, () => 0)
    const load = (): Promise<ScanResult> => {
      loads++
      return loads === 1 ? Promise.reject(new Error('scan failed')) : Promise.resolve(result('2'))
    }
    await assert.rejects(window.read(load, () => 1), /scan failed/)
    assert.equal(loads, 1)
    assert.equal((await window.read(load, () => 1)).coldIds.has('2'), true)
    assert.equal(loads, 2)
  })
})
