/**
 * /context modal spec: centered dialog with the current-composition
 * overview + the shared context browser, driven by the modal store hook;
 * closing consumes the deferred composer token through the session scope.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { bootViewBed, byClass, textOf } from './helpers/viewBed'

const bed = await bootViewBed()
const { bailCalls, evaluate, modalComponent, modalSource, snapshot } = bed

test('/context modal: open/close, current overview, embedded browser, deferred token consume on close', async () => {
  // ---- /context modal render: centered dialog with the current-composition
  // overview + the shared Context browser (which replaced the old last-10-turn
  // trend), driven by the modal store hook ----
  assert.ok(modalComponent !== null, 'overlay component captured')
  const modalData = {
    ...snapshot,
    current: { system: 10, tools: 20, user: 140, inject: 0, assistant: 15, tool: 20, total: 205 },
    // No provider usage on the last request -> the headline falls back to the
    // heuristic total (205), like the old trend-phase fixture.
    requests: snapshot.requests.map(({ prompt, ...r }) => r),
    events: [],
  }
  let modalOpen = false
  const renderModal = () => evaluate(modalComponent({
    sessionId: 's1',
    useProjection: (key) => (key === 'contextTimeline' ? modalData : undefined),
    useContextModal: (sel) => sel(modalOpen),
  }))

  assert.equal(renderModal(), null, 'modal renders nothing while closed')
  modalOpen = true
  const modalTree = renderModal()
  assert.equal(byClass(modalTree, 'lc-modal-backdrop').length, 1, 'centered backdrop rendered')
  const modalOverview = byClass(modalTree, 'lc-overview-num')[0]
  assert.match(textOf(modalOverview), /205/, 'modal headline falls back to the heuristic total (no prompt on last request)')
  assert.match(textOf(modalOverview), /0%/, 'percent against the 128k window')
  // The trend chart is gone; the shared Context browser hosts the modal's step
  // browsing instead (own picker + category accordion, opens on the live step).
  assert.equal(byClass(modalTree, 'lc-modal-trend').length, 0, 'the last-10-turn trend section is gone')
  assert.equal(byClass(modalTree, 'lc-br-cat-row').length, 6, 'context browser renders inside the modal')
  assert.equal(byClass(modalTree, 'lc-br-pick').length, 1, 'browser step picker rides the modal')
  assert.equal(byClass(modalTree, 'lc-br-pick')[0].args[1].value, 'live', 'browser opens on the live step')
  const closeBtn = byClass(modalTree, 'lc-modal-close')[0]
  assert.equal(closeBtn.args[1]['aria-label'], 'Close', 'close button localized')

  // Deferred token consumption: the enter path left `/context` in the draft
  // and recorded a bare-token guard; closing the modal dispatches the scoped
  // consume-token event through the session scope.
  assert.ok(modalSource !== null, 'trigger source registered on this instance')
  await modalSource.matchEnter({ sessionId: 's1' }, '/context', new AbortController().signal)
  const backdrop = byClass(modalTree, 'lc-modal-backdrop')[0]
  backdrop.args[1].onClick()
  assert.equal(bailCalls.length, 1, 'closing the modal dispatches consume-token')
  assert.equal(bailCalls[0][1], 'slash/input-consume-token')
  assert.deepEqual(bailCalls[0][2], { guard: { kind: 'bare-token', token: '/context' } }, 'enter-path guard consumed on close')
  // A second close without a prior open records nothing.
  backdrop.args[1].onClick()
  assert.equal(bailCalls.length, 1, 'no pending guard -> no dispatch')

  modalOpen = false
  assert.equal(renderModal(), null, 'modal closes again')

  console.log('✔ modal render test passed (open/close, current overview, embedded context browser, localized chrome, deferred token consume on close)')
})
