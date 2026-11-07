import assert from 'node:assert/strict'
import { createElement as h, createRef, useRef, type ReactElement } from 'react'
import { mount, pinRect, query } from '../helpers/kit'
import { describe, test } from 'vitest'
import {
  clampTipLeft, TipBubble, tipShiftOf, tipShiftStyle, tipShiftTransform, useTipShift,
} from '../../../src/client/components/tip'

describe('tipShiftOf', () => {
  test('shifts a centered tip back inside either edge and leaves a fitting one alone', () => {
    assert.equal(tipShiftOf(100, 80, 300), 0)
    assert.equal(tipShiftOf(10, 80, 300), 30)
    assert.equal(tipShiftOf(290, 80, 300), -30)
    assert.equal(tipShiftOf(45, 80, 300), 0)
  })
})

describe('clampTipLeft', () => {
  test('clamps the left edge to the frame on both sides, centers a fitting tip, and half-overflows an oversized one', () => {
    assert.equal(clampTipLeft(100, 80, 300), 60)
    assert.equal(clampTipLeft(0, 80, 300), 0)
    assert.equal(clampTipLeft(300, 80, 300), 220)
    assert.equal(clampTipLeft(150, 400, 300), -50)
  })
})

describe('tip transforms', () => {
  test('a zero shift keeps the plain centered transform and a signed one moves by pixels', () => {
    assert.equal(tipShiftTransform(0), 'translateX(-50%)')
    assert.equal(tipShiftTransform(6), 'translateX(calc(-50% + 6px))')
    assert.equal(tipShiftTransform(-6), 'translateX(calc(-50% - 6px))')
    assert.equal(tipShiftStyle(0), undefined)
    assert.deepEqual(tipShiftStyle(-6), { transform: 'translateX(calc(-50% - 6px))' })
  })
})

function ShiftProbe(props: { anchor: number | null }): ReactElement {
  const wrapRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const shift = useTipShift(wrapRef, tipRef, props.anchor === null ? null : { unit: 'px', value: props.anchor })
  return h('div', { ref: wrapRef, className: 'probe-wrap' },
    h('div', { ref: tipRef, className: 'probe-tip' }),
    h('span', { className: 'probe-shift' }, String(shift)))
}

describe('useTipShift', () => {
  test('measures the frame and tip, shifts an edge anchor inside, and resets when the anchor clears', async () => {
    const m = await mount(h(ShiftProbe, { anchor: null }))
    pinRect(query(m.container, '.probe-wrap'), 300)
    pinRect(query(m.container, '.probe-tip'), 80)
    await m.update(h(ShiftProbe, { anchor: 10 }))
    assert.equal(query(m.container, '.probe-shift').textContent, '30')
    await m.update(h(ShiftProbe, { anchor: null }))
    assert.equal(query(m.container, '.probe-shift').textContent, '0')
    await m.unmount()
  })

  test('percent anchors resolve against the frame width', async () => {
    function PctProbe(props: { leftPct: number }): ReactElement {
      const wrapRef = useRef<HTMLDivElement>(null)
      const tipRef = useRef<HTMLDivElement>(null)
      const shift = useTipShift(wrapRef, tipRef, { unit: 'pct', value: props.leftPct })
      return h('div', { ref: wrapRef, className: 'probe-wrap' },
        h('div', { ref: tipRef, className: 'probe-tip' }),
        h('span', { className: 'probe-shift' }, String(shift)))
    }
    const m = await mount(h(PctProbe, { leftPct: 50 }))
    pinRect(query(m.container, '.probe-wrap'), 300)
    pinRect(query(m.container, '.probe-tip'), 80)
    await m.update(h(PctProbe, { leftPct: 10 }))
    assert.equal(query(m.container, '.probe-shift').textContent, '10')
    await m.update(h(PctProbe, { leftPct: 50 }))
    assert.equal(query(m.container, '.probe-shift').textContent, '0')
    await m.unmount()
  })
})

describe('TipBubble', () => {
  test('renders the head, figure and note as a tooltip only while shown', async () => {
    const tipRef = createRef<HTMLDivElement>()
    const m = await mount(h(TipBubble, {
      tipRef, className: 'lc-tip lc-bar-tip', onClass: 'lc-bar-tip-on', shown: true,
      style: { left: '25%' }, head: 'Head', figure: '42', note: 'Note',
    }))
    const bubble = query(m.container, '.lc-bar-tip')
    assert.equal(bubble.getAttribute('role'), 'tooltip')
    assert.equal(bubble.className, 'lc-tip lc-bar-tip lc-bar-tip-on')
    assert.equal(query(bubble, '.lc-bar-tip-head').textContent, 'Head')
    assert.equal(query(bubble, '.lc-bar-tip-fig').textContent, '42')
    assert.equal(query(bubble, '.lc-bar-tip-note').textContent, 'Note')
    await m.update(h(TipBubble, {
      tipRef, className: 'lc-tip lc-bar-tip', onClass: 'lc-bar-tip-on', shown: false,
      style: { left: '25%' }, head: 'Head', figure: '42',
    }))
    assert.equal(bubble.getAttribute('role'), null)
    assert.equal(bubble.className, 'lc-tip lc-bar-tip')
    assert.equal(bubble.childElementCount, 0)
    await m.unmount()
  })
})
