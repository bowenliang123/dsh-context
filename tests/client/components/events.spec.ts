import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeEventList, makeEventText } from '../../../src/client/components/events'
import { settle } from '../helpers/kit'
import { fmtTime } from '../../../src/client/format'
import type { ContextEventRecord } from '../../../src/shared/types'
import { DICT_EN } from '../../../src/client/i18n'
import { click,  makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const { eventLabel, eventLabelParts, eventAt } = makeEventText(kit.t)
const EventList = makeEventList(kit)

function ev(over: Partial<ContextEventRecord> & { kind: ContextEventRecord['kind'] }): ContextEventRecord {
  return { seq: 1, time: 0, ...over }
}

describe('makeEventText.eventLabel', () => {
  test('compaction counts the replaced messages; prune, model switch, and mode labels resolve', () => {
    assert.equal(eventLabel(ev({ kind: 'compaction', count: 3 })), 'Context compacted (summary replaced 3 messages)')
    assert.equal(eventLabel(ev({ kind: 'compaction' })), 'Context compacted (summary replaced 0 messages)')
    assert.equal(eventLabel(ev({ kind: 'prune' })), 'Tool output pruned')
    assert.equal(eventLabel(ev({ kind: 'model', from: 'a', to: 'b' })), 'Model switched: a → b')
    assert.equal(eventLabel(ev({ kind: 'model', from: 'a' })), 'Model switched: a → ?')
    assert.equal(eventLabel(ev({ kind: 'model', to: 'b' })), 'Model switched: ? → b')
    assert.equal(eventLabel(ev({ kind: 'mode', name: 'plan.on' })), 'Plan mode on')
    assert.equal(eventLabel(ev({ kind: 'mode', name: 'plan.off' })), 'Plan mode off')
    assert.equal(eventLabel(ev({ kind: 'mode' })), 'ev.mode.?')
  })

  test('inject labels: skill injects name the skill, plain injects label their form then append name and detail', () => {
    assert.equal(eventLabel(ev({ kind: 'inject', sub: 'skill', name: 'code-review' })), 'Skill Injection · code-review')
    assert.equal(eventLabel(ev({ kind: 'inject', sub: 'skill' })), 'Skill Injection · ?')
    assert.equal(eventLabel(ev({ kind: 'inject' })), 'Context Injection')
    assert.equal(eventLabel(ev({ kind: 'inject', form: 'notice' })), 'Notice')
    assert.equal(eventLabel(ev({ kind: 'inject', form: 'notice', name: 'hook' })), 'Notice · hook')
    assert.equal(eventLabel(ev({ kind: 'inject', detail: 'from the producer' })), 'Context Injection · from the producer')
    assert.equal(eventLabel(ev({ kind: 'inject', form: 'notice', name: 'hook', detail: 'd' })), 'Notice · hook · d')
  })
})

describe('makeEventText.eventLabelParts', () => {
  test('an injection leads with its context form and trails its source name and account; other kinds are all tail', () => {
    assert.deepEqual(eventLabelParts(ev({ kind: 'inject', form: 'notice' })), { lead: 'Notice', tail: '' })
    assert.deepEqual(
      eventLabelParts(ev({ kind: 'inject', form: 'notice', name: 'hook', detail: 'd' })),
      { lead: 'Notice', tail: ' · hook · d' },
    )
    assert.deepEqual(
      eventLabelParts(ev({ kind: 'inject', sub: 'skill', name: 'code-review' })),
      { lead: 'Skill Injection', tail: ' · code-review' },
    )
    assert.deepEqual(
      eventLabelParts(ev({ kind: 'compaction', count: 2 })),
      { lead: '', tail: 'Context compacted (summary replaced 2 messages)' },
    )
  })
})

describe('makeEventText.eventAt', () => {
  test('boundary events label the gap or their single point; a partial from-side and missing turn/step degrade', () => {
    assert.equal(eventAt(ev({ kind: 'compaction', turn: 2, step: 4, fromTurn: 2, fromStep: 3 })), 'T2 S3→4')
    assert.equal(eventAt(ev({ kind: 'prune', turn: 51, step: 1, fromTurn: 50, fromStep: 8 })), 'T50 S8 → T51 S1')
    assert.equal(eventAt(ev({ kind: 'compaction', turn: 2, step: 3 })), 'T2 S3')
    assert.equal(eventAt(ev({ kind: 'compaction', turn: 2, step: 3, fromTurn: 2 })), 'T2 S3')
    assert.equal(eventAt(ev({ kind: 'compaction' })), null)
    assert.equal(eventAt(ev({ kind: 'prune', turn: 1 })), null)
    assert.equal(eventAt(ev({ kind: 'inject', turn: 1, step: 2 })), 'T1 S2')
    assert.equal(eventAt(ev({ kind: 'model' })), null)
  })
})

describe('EventList', () => {
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

    assert.ok(text(rows[0]).includes('Context Injection'))
    assert.equal(query(rows[0], '.lc-event-label b').textContent, 'Context Injection')
    assert.equal(queryAll(rows[0], '.lc-event-tokens').length, 0)

    assert.equal(query(rows[1], '.lc-event-icon').textContent, '•')
    assert.equal(query(rows[1], '.lc-kind').textContent, 'kind.mystery')

    assert.equal(query(rows[2], '.lc-event-icon').textContent, '✂')
    const down = query(rows[2], '.lc-event-tokens')
    assert.ok(down.className.includes('lc-down'))
    assert.equal(down.textContent, '−100')
    assert.equal(queryAll(rows[2], '.lc-event-at').length, 0)

    assert.ok(query(rows[3], '.lc-event-icon svg') instanceof SVGElement)
    assert.ok(text(rows[3]).includes('Model switched: a → b'))
    assert.equal(rows[3].querySelector('.lc-event-label b'), null, 'only an injection form is emphasized')
    assert.equal(query(rows[3], '.lc-kind').textContent, 'Switch')

    assert.ok(query(rows[4], '.lc-event-icon svg') instanceof SVGElement)
    assert.equal(query(rows[4], '.lc-event-label b').textContent, 'Notice')
    const up = query(rows[4], '.lc-event-tokens')
    assert.ok(up.className.includes('lc-up'))
    assert.equal(up.textContent, '+50')
    assert.equal(query(rows[4], '.lc-event-at').textContent, 'T1 S1')
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

    Object.defineProperty(labels[0], 'scrollWidth', { value: 100, configurable: true })
    Object.defineProperty(labels[1], 'scrollWidth', { value: 100, configurable: true })
    labels[0].textContent = ''
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))
    })
    await settle(20)
    assert.equal(labels[0].getAttribute('title'), '')
    assert.equal(labels[1].getAttribute('title'), 'Notice')
    await m.unmount()
  })

  test('a resize while the list shows a remote state syncs nothing (no root yet)', async () => {
    const m = await mount(h(EventList, { events: [], state: 'loading' }))
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    await settle(20)
    assert.ok(text(m.container).length > 0, 'the loading note stays painted')
    await m.unmount()
  })

  test('unmounting with a resize frame pending cancels it without touching a detached root', async () => {
    const events = [ev({ seq: 1, kind: 'prune' })]
    const m = await mount(h(EventList, { events }))
    Object.defineProperty(query(m.container, '.lc-event-label'), 'scrollWidth', { value: 100, configurable: true })
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      await m.unmount()
    })
    await settle(20)
    assert.ok(true, 'the cancelled frame never touched the detached root')
  })

  test('a resize while the list is empty (no rows, no root) does not throw; empty → non-empty → empty stays stable', async () => {
    const m = await mount(h(EventList, { events: [] }))
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    assert.ok(text(m.container).includes('No context events yet'))
    await m.update(h(EventList, { events: [ev({ seq: 1, kind: 'prune' })] }))
    assert.equal(queryAll(m.container, '.lc-event').length, 1)
    const label = query(m.container, '.lc-event-label')
    Object.defineProperty(label, 'scrollWidth', { value: 100, configurable: true })
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    await settle(20)
    assert.equal(label.getAttribute('title'), 'Tool output pruned')
    await m.update(h(EventList, { events: [] }))
    assert.ok(text(m.container).includes('No context events yet'))
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

    await m.update(h(EventList, { events: [...base, ev({ seq: 3, kind: 'model', from: 'a', to: 'b' })] }))
    const after = queryAll(m.container, '.lc-event')
    assert.equal(after.length, 3)
    assert.ok(after[0] !== before[0], 'the new event prepends a new row')
    assert.equal(after[1], before[0], 'the previously-newest row keeps its DOM node')
    assert.equal(after[2], before[1], 'the oldest row keeps its DOM node')
    await m.unmount()
  })

  test('inject, compaction and prune rows link; other kinds and a handler-less list keep plain labels', async () => {
    const events = [
      ev({ seq: 1, kind: 'inject', form: 'notice', name: 'hook' }),
      ev({ seq: 2, kind: 'compaction', count: 2 }),
      ev({ seq: 3, kind: 'prune' }),
      ev({ seq: 4, kind: 'model', from: 'a', to: 'b' }),
    ]
    const focused: ContextEventRecord[] = []
    const m = await mount(h(EventList, { events, onEventFocus: e => { focused.push(e) } }))
    const rows = queryAll(m.container, '.lc-event')
    assert.equal(rows[0].querySelector('.lc-event-jump'), null)
    assert.equal(query(rows[0], '.lc-event-label').tagName, 'SPAN')
    const prune = query(rows[1], '.lc-event-jump')
    assert.equal(prune.tagName, 'BUTTON')
    assert.equal(prune.textContent, 'Tool output pruned')
    const compaction = query(rows[2], '.lc-event-jump')
    assert.equal(compaction.tagName, 'BUTTON')
    assert.ok(compaction.textContent?.includes('Context compacted'))
    const link = query(rows[3], '.lc-event-jump')
    assert.equal(link.tagName, 'BUTTON')
    assert.equal(link.textContent, 'Notice · hook')
    await click(link)
    await click(compaction)
    await click(prune)
    assert.deepEqual(focused.map(e => e.seq), [1, 2, 3])
    await m.unmount()

    const plain = await mount(h(EventList, { events }))
    assert.equal(queryAll(plain.container, '.lc-event-jump').length, 0)
    assert.equal(queryAll(plain.container, '.lc-event-label').length, 4)
    await plain.unmount()

    const focused2: ContextEventRecord[] = []
    const guarded = await mount(h(EventList, {
      events,
      onEventFocus: e => { focused2.push(e) },
      canEventFocus: e => e.kind === 'inject',
    }))
    const guardedRows = queryAll(guarded.container, '.lc-event')
    assert.equal(guardedRows[2].querySelector('.lc-event-jump'), null, 'the compaction has no landing step')
    assert.equal(query(guardedRows[2], '.lc-event-label').tagName, 'SPAN')
    await click(query(guardedRows[3], '.lc-event-jump'))
    assert.deepEqual(focused2.map(e => e.seq), [1])
    await guarded.unmount()
  })
})

describe('EventList — the split generation detail states', () => {
  test('a pending read shows the loading note; a failed read arms the retry, or falls back to the empty claim', async () => {
    const loading = await mount(h(EventList, { events: [], state: 'loading', onRetry: () => {} }))
    assert.ok(text(loading.container).includes(DICT_EN['detail.loading']))
    assert.ok(!text(loading.container).includes('No context events yet'))
    await loading.unmount()

    let retries = 0
    const m = await mount(h(EventList, { events: [], state: 'failed', onRetry: () => { retries++ } }))
    const retry = query(m.container, '.lc-br-retry')
    assert.ok(text(m.container).includes(DICT_EN['detail.loadFailed']))
    await click(retry)
    assert.equal(retries, 1)

    const inert = await mount(h(EventList, { events: [], state: 'failed' }))
    assert.ok(text(inert.container).includes('No context events yet'), 'no retry wired — the plain empty state')
    await inert.unmount()
    await m.unmount()
  })
})
