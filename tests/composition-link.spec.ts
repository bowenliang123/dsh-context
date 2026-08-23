/**
 * Current-composition hover link: while the browser shows the LIVE step,
 * hover is shared bidirectionally with the Current Composition card; a
 * pinned/previewed step never leaks hover either way.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { bootViewBed, byClass, catRowOf, textOf } from './helpers/viewBed'

const bed = await bootViewBed()
const { renderView, snapshot } = bed
bed.dataValue = snapshot
let tr = renderView()
const ctxSlots = bed.ctxSlots()
const brSlots = bed.brSlots()

test('current-composition hover link: browser rows + composition bar <-> overview, gated on the live step', async () => {
  // ---- current-composition hover link: while the browser shows the LIVE step,
  // hover is shared bidirectionally with the Current Composition card. A
  // browser category row or the browser's own composition bar lights the
  // overview's segment + legend chip (and the browser echoes back); hovering
  // the overview lights the browser's matching category row and bar segment.
  // A pinned/previewed step has a different composition, so its hover never
  // leaks into the overview and the overview's hover never highlights it. ----
  const brWrap = () => byClass(tr, 'lc-br-bar')[0]
  const brStack = () => byClass(brWrap(), 'lc-stacked')[0]
  const ovrStack = () => byClass(tr, 'lc-stacked').find(s => s.args[1].style.height === '16px')
  const segOf = (stack, key) => stack.args.slice(2).flat().filter(s => s !== null)
    .find(s => s.args[1].key === key)
  const barSegsOn = (stack) => stack.args.slice(2).flat().filter(s => s !== null)
    .filter(s => String(s.args[1].className || '').includes('lc-stacked-seg-on'))
  assert.ok(brStack(), 'browser composition bar present (height 10 wrapper hook)')
  ctxSlots[1][1](null) // no trend hover: the browser is on the live step
  brSlots[1][1](null)
  brSlots[2][1](null)
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-cat-on').length, 0, 'no linked category row before any hover')

  // browser category row -> overview (both bars, the legend, and the row echo)
  const liveUserRow = catRowOf(tr, 'User')
  assert.equal(typeof liveUserRow.args[1].onMouseEnter, 'function', 'live browser rows carry the hover link')
  liveUserRow.args[1].onMouseEnter()
  tr = renderView()
  assert.equal(ctxSlots[7][0], 'user', 'browser row hover updates the shared hover category')
  assert.equal(byClass(tr, 'lc-br-cat-on').length, 1, 'browser row hover links its own row')
  assert.equal(barSegsOn(brStack()).length, 1, 'browser row hover lights the browser bar segment')
  assert.equal(barSegsOn(brStack())[0].args[1].key, 'user', 'the lit browser segment is user')
  assert.equal(barSegsOn(ovrStack()).length, 1, 'browser row hover lights the overview bar segment')
  assert.equal(byClass(tr, 'lc-chip-on').length, 1, 'browser row hover lights the overview legend chip')
  assert.match(textOf(byClass(tr, 'lc-chip-on')[0]), /User/, 'the lit chip is the user category')
  liveUserRow.args[1].onMouseLeave()
  tr = renderView()
  assert.equal(ctxSlots[7][0], null, 'leaving the browser row clears the shared hover')
  assert.equal(byClass(tr, 'lc-br-cat-on').length, 0, 'the row echo clears with the leave')
  assert.equal(byClass(tr, 'lc-stacked-seg-on').length, 0, 'both bars clear with the row leave')
  assert.equal(byClass(tr, 'lc-chip-on').length, 0, 'the legend chip clears with the row leave')

  // overview -> browser: the overview segment lights the browser's category
  // row and bar segment, but only the overview floats its tooltip (the
  // mirrored browser bar stays silent).
  segOf(ovrStack(), 'assistant').args[1].onMouseEnter({ clientX: 80 })
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-cat-on').length, 1, 'overview hover lights the browser category row')
  assert.match(textOf(byClass(tr, 'lc-br-cat-on')[0]), /assistant/, 'the echoed row is the assistant category')
  assert.equal(barSegsOn(brStack()).length, 1, 'the browser bar mirrors the overview hover')
  assert.equal(barSegsOn(brStack())[0].args[1].key, 'assistant', 'the mirrored segment is the assistant')
  assert.equal(byClass(tr, 'lc-bar-tip-on').length, 1, 'exactly one tooltip floats (only over the overview bar)')
  ovrStack().args[1].onMouseLeave()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-cat-on').length, 0, 'overview leave clears the browser row echo')
  assert.equal(byClass(tr, 'lc-stacked-seg-on').length, 0, 'overview leave clears both bars')

  // browser composition bar -> overview (the browser's bart joins the link)
  segOf(brStack(), 'user').args[1].onMouseEnter()
  tr = renderView()
  assert.equal(ctxSlots[7][0], 'user', 'browser bar hover updates the shared hover category')
  assert.equal(barSegsOn(ovrStack()).length, 1, 'browser bar hover lights the overview segment')
  assert.equal(byClass(tr, 'lc-chip-on').length, 1, 'browser bar hover lights the overview legend chip')
  assert.equal(byClass(tr, 'lc-br-cat-on').length, 1, 'browser bar hover links the browser category row too')
  brStack().args[1].onMouseLeave()
  tr = renderView()
  assert.equal(ctxSlots[7][0], null, 'leaving the browser bar clears the shared hover')

  // pinned/previewed step: the compositions differ, so no linkage either way
  ctxSlots[1][1](2) // trend hover previews step 2 in the browser
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, '2', 'browser is previewing a past step')
  assert.equal(catRowOf(tr, 'User').args[1].onMouseEnter, undefined, 'pinned browser rows carry no hover link')
  segOf(brStack(), 'user').args[1].onMouseEnter() // handler exists; the live gate must make it a no-op
  tr = renderView()
  assert.equal(ctxSlots[7][0], null, 'pinned browser bar hover does not leak into the overview')
  segOf(ovrStack(), 'assistant').args[1].onMouseEnter({ clientX: 80 })
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-cat-on').length, 0, 'overview hover does not echo into a pinned step')
  assert.equal(barSegsOn(brStack()).length, 0, 'overview hover does not light the pinned composition bar')
  assert.equal(barSegsOn(ovrStack()).length, 1, 'the overview itself still highlights normally')
  ovrStack().args[1].onMouseLeave()
  tr = renderView()

  // back on the live step the link returns
  ctxSlots[1][1](null)
  tr = renderView()
  assert.equal(typeof catRowOf(tr, 'User').args[1].onMouseEnter, 'function', 'live browser rows carry the link again')

  console.log('✔ current-composition hover link test passed (browser rows + composition bar <-> overview, gated on the live step)')
})
