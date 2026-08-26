// events.tsx — makeEventText pure helpers plus EventList rendered with real
// React (real shared icon components), including the truncation layout effect
// and the empty→non-empty hook-count regression (issue #12).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { act } from 'react'
import { h } from '../../../src/client/react'
import { makeEventList, makeEventText } from '../../../src/client/components/events'
import { fmtTime } from '../../../src/client/format'
import type { ContextEventRecord } from '../../../src/shared/types'
import { flush, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const { eventLabel, eventAt } = makeEventText(kit.t)
const EventList = makeEventList(kit)

function ev(over: Partial<ContextEventRecord> & { kind: ContextEventRecord['kind'] }): ContextEventRecord {
  return { seq: 1, time: 0, ...over }
}

describe('makeEventText.eventLabel', () => {
  test('compaction counts the replaced messages (absent count folds to 0)', () => {
    assert.equal(eventLabel(ev({ kind: 'compaction', count: 3 })), 'Context compacted (summary replaced 3 messages)')
    assert.equal(eventLabel(ev({ kind: 'compaction' })), 'Context compacted (summary replaced 0 messages)')
  })

  test('prune has a fixed label', () => {
    assert.equal(eventLabel(ev({ kind: 'prune' })), 'Tool output pruned')
  })

  test('model switch interpolates from/to, ? for a missing side', () => {
    assert.equal(eventLabel(ev({ kind: 'model', from: 'a', to: 'b' })), 'Model switched: a → b')
    assert.equal(eventLabel(ev({ kind: 'model', from: 'a' })), 'Model switched: a → ?')
    assert.equal(eventLabel(ev({ kind: 'model', to: 'b' })), 'Model switched: ? → b')
  })

  test('mode labels resolve per name; a missing name resolves to the raw key', () => {
    assert.equal(eventLabel(ev({ kind: 'mode', name: 'plan.on' })), 'Plan mode on')
    assert.equal(eventLabel(ev({ kind: 'mode', name: 'plan.off' })), 'Plan mode off')
    assert.equal(eventLabel(ev({ kind: 'mode' })), 'ev.mode.?')
  })

  test('skill injects name the skill, ? when missing', () => {
    assert.equal(eventLabel(ev({ kind: 'inject', sub: 'skill', name: 'code-review' })), 'Skill injected (code-review)')
    assert.equal(eventLabel(ev({ kind: 'inject', sub: 'skill' })), 'Skill injected (?)')
  })

  test('plain injects label their form, then append name and detail', () => {
    assert.equal(eventLabel(ev({ kind: 'inject' })), 'Context Injection')
    assert.equal(eventLabel(ev({ kind: 'inject', form: 'notice' })), 'Notice')
    assert.equal(eventLabel(ev({ kind: 'inject', form: 'notice', name: 'hook' })), 'Notice · hook')
    assert.equal(eventLabel(ev({ kind: 'inject', detail: 'from the producer' })), 'Context Injection · from the producer')
    assert.equal(eventLabel(ev({ kind: 'inject', form: 'notice', name: 'hook', detail: 'd' })), 'Notice · hook · d')
  })
})

describe('makeEventText.eventAt', () => {
  test('boundary events label the gap: same-turn range, cross-turn range, single point', () => {
    assert.equal(eventAt(ev({ kind: 'compaction', turn: 2, step: 4, fromTurn: 2, fromStep: 3 })), 'Turn 2 · Step 3→4')
    assert.equal(eventAt(ev({ kind: 'prune', turn: 51, step: 1, fromTurn: 50, fromStep: 8 })), 'Turn 50 · Step 8 → Turn 51 · Step 1')
    assert.equal(eventAt(ev({ kind: 'compaction', turn: 2, step: 3 })), 'Turn 2 · Step 3')
    // A partial from-side falls back to the single point.
    assert.equal(eventAt(ev({ kind: 'compaction', turn: 2, step: 3, fromTurn: 2 })), 'Turn 2 · Step 3')
  })

  test('missing turn/step yields null; non-boundary kinds keep their single point', () => {
    assert.equal(eventAt(ev({ kind: 'compaction' })), null)
    assert.equal(eventAt(ev({ kind: 'prune', turn: 1 })), null)
    assert.equal(eventAt(ev({ kind: 'inject', turn: 1, step: 2 })), 'Turn 1 · Step 2')
    assert.equal(eventAt(ev({ kind: 'model' })), null)
  })
})

describe('EventList', () => {
  test('renders the empty state', async () => {
    const m = await mount(h(EventList, { events: [] }))
    assert.ok(text(m.container).includes('No context events yet'))
    await m.unmount()
  })

  test('rows render newest first with icons, kinds, labels, positions, tokens, and times', async () => {
    const time = new Date(2024, 0, 2, 3, 4, 5).getTime()
    const events: ContextEventRecord[] = [
      ev({ seq: 1, time, kind: 'inject', form: 'notice', tokens: 50, turn: 1, step: 1 }),
      ev({ seq: 2, time, kind: 'model', from: 'a', to: 'b' }),
      ev({ seq: 3, time, kind: 'compaction', count: 2, tokens: 100 }),
      ev({ seq: 4, time, kind: 'mystery' as never }),
      ev({ seq: 5, time, kind: 'inject', tokens: 0 }),
    ]
    const m = await mount(h(EventList, { events }))
    const rows = queryAll(m.container, '.lc-event')
    assert.equal(rows.length, 5)

    // Newest first: seq 5 leads. tokens 0 renders no token span.
    assert.ok(text(rows[0]).includes('Context Injection'))
    assert.equal(queryAll(rows[0], '.lc-event-tokens').length, 0)

    // Foreign kind: EVENT_ICONS miss → '•' fallback, and the kind label
    // resolves through the locale chain to the key itself.
    assert.equal(query(rows[1], '.lc-event-icon').textContent, '•')
    assert.equal(query(rows[1], '.lc-kind').textContent, 'kind.mystery')

    // Compaction: ✂ glyph, negative token delta, no position (no turn/step).
    assert.equal(query(rows[2], '.lc-event-icon').textContent, '✂')
    const down = query(rows[2], '.lc-event-tokens')
    assert.ok(down.className.includes('lc-down'))
    assert.equal(down.textContent, '−100')
    assert.equal(queryAll(rows[2], '.lc-event-at').length, 0)

    // Model switch: real IconBranchOutline16 svg.
    assert.ok(query(rows[3], '.lc-event-icon svg') instanceof SVGElement)
    assert.ok(text(rows[3]).includes('Model switched: a → b'))
    assert.equal(query(rows[3], '.lc-kind').textContent, 'Switch')

    // Inject: real IconPlusOutline16 svg, positive token delta, position, time.
    assert.ok(query(rows[4], '.lc-event-icon svg') instanceof SVGElement)
    const up = query(rows[4], '.lc-event-tokens')
    assert.ok(up.className.includes('lc-up'))
    assert.equal(up.textContent, '+50')
    assert.equal(query(rows[4], '.lc-event-at').textContent, 'Turn 1 · Step 1')
    assert.equal(query(rows[4], '.lc-event-time').textContent, fmtTime(time))
    await m.unmount()
  })

  test('truncation effect: jsdom widths are 0 so titles stay empty; a forced overflow syncs the title', async () => {
    const events = [
      ev({ seq: 1, kind: 'inject', form: 'notice' }),
      ev({ seq: 2, kind: 'prune' }),
    ]
    const m = await mount(h(EventList, { events }))
    const labels = queryAll(m.container, '.lc-event-label')
    assert.equal(labels[0].getAttribute('title'), '')
    assert.equal(labels[1].getAttribute('title'), '')

    // Newest first: labels[0] is the prune, labels[1] the inject.
    // Force an empty-text overflow on the prune label (the
    // `el.textContent || ''` fallback arm) and a real overflow on the
    // inject label, then resize.
    Object.defineProperty(labels[0], 'scrollWidth', { value: 100, configurable: true })
    Object.defineProperty(labels[1], 'scrollWidth', { value: 100, configurable: true })
    labels[0].textContent = ''
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    assert.equal(labels[0].getAttribute('title'), '')
    assert.equal(labels[1].getAttribute('title'), 'Notice')
    await flush()
    await m.unmount()
  })

  test('a resize while the list is empty (no rows, no root) does not throw', async () => {
    const m = await mount(h(EventList, { events: [] }))
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    assert.ok(text(m.container).includes('No context events yet'))
    // The same listener keeps working once rows arrive (root was null at mount).
    await m.update(h(EventList, { events: [ev({ seq: 1, kind: 'prune' })] }))
    const label = query(m.container, '.lc-event-label')
    Object.defineProperty(label, 'scrollWidth', { value: 100, configurable: true })
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    assert.equal(label.getAttribute('title'), 'Tool output pruned')
    await m.unmount()
  })

  test('an appended event keeps every existing row mounted (seq-keyed, newest prepends)', async () => {
    const base = [
      ev({ seq: 1, kind: 'inject', form: 'notice', name: 'first' }),
      ev({ seq: 2, kind: 'prune' }),
    ]
    const m = await mount(h(EventList, { events: base }))
    const before = queryAll(m.container, '.lc-event')
    assert.equal(before.length, 2)

    // A new event lands at the log tail → the row list prepends it; every old row must be the SAME DOM node
    // (an index-bearing key would shift all keys and remount the whole list on every push).
    await m.update(h(EventList, { events: [...base, ev({ seq: 3, kind: 'model', from: 'a', to: 'b' })] }))
    const after = queryAll(m.container, '.lc-event')
    assert.equal(after.length, 3)
    assert.ok(after[0] !== before[0], 'the new event prepends a new row')
    assert.equal(after[1], before[0], 'the previously-newest row keeps its DOM node')
    assert.equal(after[2], before[1], 'the oldest row keeps its DOM node')
    await m.unmount()
  })

  test('empty → non-empty transition keeps the hook count stable (issue #12)', async () => {
    const m = await mount(h(EventList, { events: [] }))
    assert.ok(text(m.container).includes('No context events yet'))
    await m.update(h(EventList, { events: [ev({ seq: 1, kind: 'prune' })] }))
    assert.equal(queryAll(m.container, '.lc-event').length, 1)
    assert.ok(text(m.container).includes('Tool output pruned'))
    await m.update(h(EventList, { events: [] }))
    assert.ok(text(m.container).includes('No context events yet'))
    await m.unmount()
  })
})
