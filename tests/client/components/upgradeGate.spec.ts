// UpgradeGate (src/client/components/upgradeGate.tsx) — the baseline-gate
// modal rendered for real in jsdom: version rows, backdrop/card/Escape/OK/×
// dismissal, and the per-session dismissal ledger across remounts and
// in-place session switches.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeUpgradeGate } from '../../../src/client/components/upgradeGate'
import { click, keydown, makeKit, mount, query, text } from '../helpers/kit'

const kit = makeKit()
const kitZh = makeKit('zh')
const Gate = makeUpgradeGate(kit)

function render(sessionId: string | undefined, extra: { current?: string; minimum?: string } = {}) {
  return mount(h(Gate, { sessionId, current: extra.current ?? '0.1.1-rc.2', minimum: extra.minimum ?? '0.1.2-rc.1' }))
}

describe('UpgradeGate', () => {
  test('renders both versions and the upgrade prompt (en and zh)', async () => {
    const en = await render('s-en')
    try {
      assert.match(text(en.container), /Update DeepSeek Harness/)
      assert.match(text(en.container), /dsh-context supports DeepSeek Harness v0\.1\.2-rc\.1 or newer\./)
      assert.match(text(en.container), /v0\.1\.1-rc\.2/)
      assert.match(text(en.container), /Current/)
      assert.match(text(en.container), /Minimum required/)
    } finally {
      await en.unmount()
    }
    const ZhGate = makeUpgradeGate(kitZh)
    const zh = await mount(h(ZhGate, { sessionId: 's-zh', current: '0.1.0', minimum: '0.1.2-rc.1' }))
    try {
      assert.match(text(zh.container), /请更新 DeepSeek Harness 版本/)
      assert.match(text(zh.container), /dsh-context 插件支持 DeepSeek Harness v0\.1\.2-rc\.1 或更新版本。/)
      assert.match(text(zh.container), /v0\.1\.2-rc\.1及更新的版本/)
      assert.match(text(zh.container), /v0\.1\.0/)
    } finally {
      await zh.unmount()
    }
  })

  test('the OK button dismisses and the dismissal survives a remount', async () => {
    const first = await render('s-ok')
    await click(query(first.container, '.lc-gate-ok'))
    assert.equal(first.container.querySelector('.lc-modal-backdrop'), null)
    await first.unmount()

    const second = await render('s-ok')
    try {
      assert.equal(second.container.querySelector('.lc-modal-backdrop'), null, 'the ledger keeps it closed')
    } finally {
      await second.unmount()
    }
  })

  test('the × button dismisses', async () => {
    const m = await render('s-x')
    await click(query(m.container, '.lc-modal-close'))
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    await m.unmount()
  })

  test('a backdrop click dismisses; a card click does not', async () => {
    const m = await render('s-backdrop')
    await click(query(m.container, '.lc-gate-card'))
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null, 'card clicks stay inside')
    await click(query(m.container, '.lc-modal-backdrop'))
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    await m.unmount()
  })

  test('Escape dismisses; other keys do not', async () => {
    const m = await render('s-esc')
    await keydown('Enter')
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null)
    await keydown('Escape')
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    // A closed gate does not react to further keys (listener detached).
    await keydown('Escape')
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    await m.unmount()
  })

  test('an in-place session switch re-evaluates the ledger', async () => {
    const m = await render('s-switch-a')
    await click(query(m.container, '.lc-gate-ok'))
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    // Switching to a fresh session shows its gate again on the same mount.
    await m.update(h(Gate, { sessionId: 's-switch-b', current: '0.1.0', minimum: '0.1.2-rc.1' }))
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null)
    // Switching back to the dismissed session stays closed.
    await m.update(h(Gate, { sessionId: 's-switch-a', current: '0.1.0', minimum: '0.1.2-rc.1' }))
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    await m.unmount()
  })

  test('a missing sessionId still renders and dismisses', async () => {
    const m = await render(undefined)
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null)
    await click(query(m.container, '.lc-gate-ok'))
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    await m.unmount()
  })
})
