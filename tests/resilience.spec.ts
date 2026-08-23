/**
 * Backend-parse-failure resilience: a corrupt/foreign contextTimeline value
 * must never white-screen the tab — the projection is sanitized into a
 * render-safe shape and residual render errors land in the error boundary's
 * styled card.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { bootViewBed, byClass, textOf } from './helpers/viewBed'

const bed = await bootViewBed()
const { classInstances, evaluate, modalComponent, renderView, snapshot, viewComponent } = bed
bed.dataValue = snapshot
let tr = renderView()

test('backend-parse-failure resilience: sanitized render of corrupt payloads, degraded modal, error boundary card', async () => {
  // ---- backend-parse-failure resilience: a corrupt/foreign `contextTimeline`
  // value must never white-screen the tab. The projection is sanitized into a
  // render-safe shape — the tab shows the WHOLE UI with every usable piece —
  // and any residual render error is caught by the error boundary (a styled
  // error card, not an unmounted conversation view). ----

  // A non-record value (capability absent, nothing delivered yet): loading.
  bed.dataValue = 'not-even-an-object'
  tr = renderView()
  assert.equal(textOf(byClass(tr, 'lc-empty')[0]), '…', 'a non-record value keeps the loading screen')

  // A garbage payload: wrong-typed scalars drop, non-list collections degrade
  // to [], non-object entries are dropped, and the breakdown zeroes out.
  bed.dataValue = {
    ok: false,
    model: 42,
    current: null,
    requests: ['junk', { seq: 1, turn: 1, time: 10, system: 1, tools: 2, user: 3, inject: 0, assistant: 4, tool: 0, total: 10 }],
    events: [null, { kind: 'inject', seq: 1, time: 5 }],
    nodes: [null, { seq: 1, cat: 'user', tokens: 10, text: 'talk', time: NaN }],
    archive: { bogus: true },
    toolList: [null, { name: 'bash', tokens: 5 }],
    droppedNodes: -3,
    cost: ['not-a-record'],
    surfaceFloor: 'x',
  }
  tr = renderView() // must not throw
  assert.equal(byClass(tr, 'lc-bar').length, 1, 'the usable request entry still renders a trend bar')
  assert.equal(byClass(tr, 'lc-stat-value').length, 9, 'stats board still renders')
  const statValsM = byClass(tr, 'lc-stat-value').map(n => n.args[2])
  assert.equal(statValsM[0], '1', 'turns count survives (non-array requests degraded, entries filtered)')
  assert.equal(statValsM[1], '1', 'steps count survives')
  assert.equal(statValsM[5], '0', 'tool-call cell falls back to zero when absent')
  assert.equal(statValsM[6], '0', 'image cell falls back to zero when absent')
  assert.equal(statValsM[7], '—', 'cache hit degrades to a dash')
  assert.equal(statValsM[8], '—', 'cost degrades to a dash (non-record cost dropped)')
  assert.equal(byClass(tr, 'lc-event').length, 1, 'the usable event entry still shows')
  assert.equal(byClass(tr, 'lc-node').length, 1, 'the usable node entry still shows')
  assert.equal(textOf(byClass(tr, 'lc-node-time')[0]), '—', 'an invalid timestamp shows a dash instead of throwing')
  assert.equal(byClass(tr, 'lc-tool-chip').length, 1, 'the usable tool entry still shows')
  assert.equal(byClass(tr, 'lc-br-cat-row').length, 6, 'the context browser still renders all six sections')

  // The /context modal degrades identically: sanitized empty data renders the
  // dialog shell with full sections instead of throwing.
  const brokenModalTree = evaluate(modalComponent({
    sessionId: 's1',
    useProjection: (key) => (key === 'contextTimeline'
      ? { current: 'x', requests: 5, nodes: null, toolList: 7, events: {}, archive: 'z' }
      : undefined),
    useContextModal: (sel) => sel(true),
  }))
  assert.equal(byClass(brokenModalTree, 'lc-modal-card').length, 1, 'the modal shell stays intact')
  assert.equal(byClass(brokenModalTree, 'lc-br-cat-row').length, 6, 'the modal degrades to full sections with sanitized data')

  // A projection reader that THROWS (a broker/framework failure) lands in the
  // error boundary's styled card — not a white screen — with the boundary
  // protocol recording the offending error.
  const boomTree = evaluate(viewComponent({
    sessionId: 's1',
    useProjection: () => { throw new Error('boom-parse') },
  }))
  assert.equal(byClass(boomTree, 'lc-error').length, 1, 'a throwing reader degrades to the error card')
  assert.match(textOf(byClass(boomTree, 'lc-error')[0]), /ERR:.*boom-parse/, 'the card carries the offending message')
  assert.equal(byClass(boomTree, 'lc-error-retry').length, 1, 'the card offers Retry')
  const boundaryKey = [...classInstances.keys()].find(k => k.includes('ErrorBoundary'))
  assert.ok(boundaryKey, 'boundary instance registered')
  assert.match(classInstances.get(boundaryKey).state.error.message, /boom-parse/, 'the boundary protocol recorded the error')

  // restore state for any later tests
  bed.dataValue = snapshot
  tr = renderView()
  assert.equal(byClass(tr, 'lc-bar').length, 4, 'snapshot restored after the resilience tests')

  console.log('✔ backend-parse-failure resilience test passed (sanitized render of corrupt payloads, degraded modal, error boundary card)')
})
