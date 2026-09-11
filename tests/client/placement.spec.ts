// Placement gating (src/client/placement.ts): the mounts follow the
// `defaultPlacement` preference — both, the tab only, or the sidebar only —
// a flip disposes exactly what the new value drops, and the watcher's own
// disposer unwinds everything and detaches the store.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createContextSettings } from '../../src/client/settings'
import { watchPlacement } from '../../src/client/placement'

/** A mount factory counting its mounts and the disposer calls it received. */
function mountSpy(): { factory: () => () => void; mounted: () => number; disposed: () => number } {
  let mountedCount = 0
  let disposedCount = 0
  return {
    factory: () => {
      mountedCount += 1
      return () => { disposedCount += 1 }
    },
    mounted: () => mountedCount,
    disposed: () => disposedCount,
  }
}

describe('watchPlacement', () => {
  test("the default 'all' mounts both; a flip to one side disposes only the other", () => {
    const settings = createContextSettings()
    const tab = mountSpy()
    const sidebar = mountSpy()
    const dispose = watchPlacement(settings, { tab: tab.factory, sidebar: sidebar.factory })
    assert.equal(tab.mounted(), 1)
    assert.equal(sidebar.mounted(), 1)

    settings.set('defaultPlacement', 'sidebar')
    assert.equal(tab.disposed(), 1, 'the dropped tab registration was disposed')
    assert.equal(tab.mounted(), 1, 'no remount churn')
    assert.equal(sidebar.disposed(), 0, 'the sidebar stays mounted')
    assert.equal(sidebar.mounted(), 1)

    settings.set('defaultPlacement', 'tab')
    assert.equal(sidebar.disposed(), 1)
    assert.equal(sidebar.mounted(), 1)
    assert.equal(tab.mounted(), 2, 'the tab comes back')
    assert.equal(tab.disposed(), 1)
    dispose()
  })

  test("'all' restores both; unrelated preference changes never remount", () => {
    const settings = createContextSettings()
    const tab = mountSpy()
    const sidebar = mountSpy()
    const dispose = watchPlacement(settings, { tab: tab.factory, sidebar: sidebar.factory })

    settings.set('defaultGranularity', 'turn')
    assert.equal(tab.mounted(), 1)
    assert.equal(sidebar.mounted(), 1)

    settings.set('defaultPlacement', 'tab')
    settings.set('defaultPlacement', 'all')
    assert.equal(tab.mounted(), 1, 'the kept side is never churned')
    assert.equal(sidebar.mounted(), 2, 'the dropped side remounts once')
    assert.equal(sidebar.disposed(), 1)
    dispose()
  })

  test("a 'tab'-only or 'sidebar'-only start mounts just that side", () => {
    const settings = createContextSettings()
    settings.set('defaultPlacement', 'tab')
    const tab = mountSpy()
    const sidebar = mountSpy()
    const dispose = watchPlacement(settings, { tab: tab.factory, sidebar: sidebar.factory })
    assert.equal(tab.mounted(), 1)
    assert.equal(sidebar.mounted(), 0)
    dispose()
    assert.equal(tab.disposed(), 1)
    assert.equal(sidebar.disposed(), 0)

    const again = createContextSettings()
    again.set('defaultPlacement', 'sidebar')
    const tab2 = mountSpy()
    const sidebar2 = mountSpy()
    const dispose2 = watchPlacement(again, { tab: tab2.factory, sidebar: sidebar2.factory })
    assert.equal(tab2.mounted(), 0)
    assert.equal(sidebar2.mounted(), 1)
    dispose2()
  })

  test('the watcher disposer unwinds every mount and detaches the store', () => {
    const settings = createContextSettings()
    const tab = mountSpy()
    const sidebar = mountSpy()
    const dispose = watchPlacement(settings, { tab: tab.factory, sidebar: sidebar.factory })
    dispose()
    assert.equal(tab.disposed(), 1)
    assert.equal(sidebar.disposed(), 1)
    // The store subscription is gone: a later flip reaches no mount.
    settings.set('defaultPlacement', 'sidebar')
    assert.equal(tab.mounted(), 1)
    assert.equal(sidebar.mounted(), 1)
    // The disposer is safe to repeat.
    assert.doesNotThrow(dispose)
    assert.equal(tab.disposed(), 1, 'no double unwind')
  })

  test('a mount landing no disposer (a face returning nothing) is tolerated', () => {
    const settings = createContextSettings()
    const dispose = watchPlacement(settings, {
      tab: () => undefined,
      sidebar: () => undefined,
    })
    assert.doesNotThrow(() => { settings.set('defaultPlacement', 'tab') })
    assert.doesNotThrow(() => { dispose() })
  })
})
