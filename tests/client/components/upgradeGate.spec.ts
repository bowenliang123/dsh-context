import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeUpgradeGate } from '../../../src/client/components/upgradeGate'
import { disposeRetention } from '../../../src/client/retention'
import { click, keydown, makeKit, mount, query, text } from '../helpers/kit'

const kit = makeKit()
const Gate = makeUpgradeGate(kit)

function render(sessionId: string | undefined, extra: { current?: string; minimum?: string } = {}) {
  return mount(h(Gate, { sessionId, current: extra.current ?? '0.1.1-rc.2', minimum: extra.minimum ?? '0.2.0-rc.2' }))
}

describe('UpgradeGate', () => {
  test('renders both versions and the upgrade prompt', async () => {
    const en = await render('s-en')
    try {
      assert.match(text(en.container), /Update DeepSeek Harness/)
      assert.match(text(en.container), /dsh-context supports DeepSeek Harness v0\.2\.0-rc\.2 or newer\./)
      assert.match(text(en.container), /v0\.1\.1-rc\.2/)
      assert.match(text(en.container), /Current/)
      assert.match(text(en.container), /Minimum required/)
    } finally {
      await en.unmount()
    }
    const zh = await mount(h(makeUpgradeGate(makeKit('zh')), { sessionId: 's-zh', current: '0.1.1-rc.2', minimum: '0.2.0-rc.2' }))
    assert.ok(text(zh.container).includes('请更新 DeepSeek Harness 版本'))
    await zh.unmount()
  })

  test('OK dismisses and the dismissal survives a remount; ×, a backdrop click, and Escape dismiss; a card click and other keys do not', async () => {
    const first = await render('s-ok')
    await click(query(first.container, '.lc-gate-ok'))
    assert.equal(first.container.querySelector('.lc-modal-backdrop'), null)
    await first.unmount()
    const second = await render('s-ok')
    assert.equal(second.container.querySelector('.lc-modal-backdrop'), null, 'the ledger keeps it closed')
    await second.unmount()

    const x = await render('s-x')
    await click(query(x.container, '.lc-modal-close'))
    assert.equal(x.container.querySelector('.lc-modal-backdrop'), null)
    await x.unmount()

    const backdrop = await render('s-backdrop')
    await click(query(backdrop.container, '.lc-gate-card'))
    assert.ok(backdrop.container.querySelector('.lc-modal-backdrop') !== null, 'card clicks stay inside')
    await click(query(backdrop.container, '.lc-modal-backdrop'))
    assert.equal(backdrop.container.querySelector('.lc-modal-backdrop'), null)
    await backdrop.unmount()

    const esc = await render('s-esc')
    await keydown('Enter')
    assert.ok(esc.container.querySelector('.lc-modal-backdrop') !== null)
    await keydown('Escape')
    assert.equal(esc.container.querySelector('.lc-modal-backdrop'), null)
    await keydown('Escape')
    assert.equal(esc.container.querySelector('.lc-modal-backdrop'), null)
    await esc.unmount()
  })

  test('an in-place session switch re-evaluates the ledger', async () => {
    const m = await render('s-switch-a')
    await click(query(m.container, '.lc-gate-ok'))
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    await m.update(h(Gate, { sessionId: 's-switch-b', current: '0.1.0', minimum: '0.2.0-rc.2' }))
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null)
    await m.update(h(Gate, { sessionId: 's-switch-a', current: '0.1.0', minimum: '0.2.0-rc.2' }))
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

describe('UpgradeGate retention', () => {
  test('the dismissed ledger is bounded and dispose forgets dismissals', async () => {
    const gate = makeUpgradeGate(makeKit())
    for (let i = 0; i < 65; i++) {
      const m = await mount(h(gate, { sessionId: 'gate-cap-' + i, current: '0.1.0', minimum: '0.2.0-rc.2' }))
      await click(query(m.container, '.lc-gate-ok'))
      await m.unmount()
    }
    const evicted = await mount(h(gate, { sessionId: 'gate-cap-0', current: '0.1.0', minimum: '0.2.0-rc.2' }))
    assert.ok(evicted.container.querySelector('.lc-modal-backdrop') !== null, 'the oldest dismissal fell out of the ledger')
    await evicted.unmount()

    const kept = await mount(h(gate, { sessionId: 'gate-cap-64', current: '0.1.0', minimum: '0.2.0-rc.2' }))
    assert.equal(kept.container.querySelector('.lc-modal-backdrop'), null, 'the newest dismissal survives')
    await kept.unmount()

    disposeRetention()
    const forgotten = await mount(h(gate, { sessionId: 'gate-cap-64', current: '0.1.0', minimum: '0.2.0-rc.2' }))
    assert.ok(forgotten.container.querySelector('.lc-modal-backdrop') !== null, 'dispose forgets dismissals')
    await forgotten.unmount()
  })
})
