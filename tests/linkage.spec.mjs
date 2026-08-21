/**
 * Trend-chart <-> context-browser linkage: hovering a bar transiently
 * previews its step in the browser; clicking (pin) locks it; leaving or
 * unpinning returns the browser to its own selection.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { bootViewBed, byClass, textOf } from './helpers/viewBed.mjs'

const bed = await bootViewBed()
const { renderView, snapshot } = bed
bed.dataValue = snapshot
let tr = renderView()
const ctxSlots = bed.ctxSlots()
const brSlots = bed.brSlots()

test('trend chart <-> browser linkage: hover previews its step, pin locks it, unpin returns to live', async () => {
  // ---- trend-chart hover linkage: the bar under the pointer transiently
  // previews its step in the browser (picker value + meta follow); leaving
  // the chart returns to the picker's own selection. Driven through
  // ContextView's hoveredSeq state, exactly like TrendChart's onHover. ----
  ctxSlots[1][1](2) // hover the seq-2 bar (Turn 1 · Step 1)
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, '2', 'hovered bar drives the browser picker')
  assert.match(textOf(byClass(tr, 'lc-br-meta')[0]), /Turn 1 · Step 1/, 'meta shows the hovered step')
  assert.match(textOf(byClass(tr, 'lc-br-meta')[0]), /preview/, 'hover preview is marked')
  ctxSlots[1][1](3)
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, '3', 'hover moves across bars')
  ctxSlots[1][1](9999)
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, 'live', 'an unknown (trimmed) preview seq is ignored')
  ctxSlots[1][1](null)
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, 'live', 'leaving the chart returns to the picker selection')

  console.log('✔ hover linkage test passed (bar hover previews its step, unknown seq ignored, picker resumes)')

  // ---- trend-chart pin linkage: clicking a bar locks its step in the browser
  // too (the picker follows the pin); unpinning (selectedSeq back to null)
  // returns the browser to the live step. Driven through ContextView's
  // selectedSeq state + the browser's pin-linkage effect (hook slot 8). ----
  ctxSlots[0][1](2) // pin the seq-2 bar (Turn 1 · Step 1)
  tr = renderView()
  brSlots[8].effect() // the pin effect applies the new pinSeq
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, '2', 'pinned bar drives the browser picker')
  assert.match(textOf(byClass(tr, 'lc-br-meta')[0]), /Turn 1 · Step 1/, 'meta shows the pinned step')
  ctxSlots[1][1](3) // hovering another bar still previews transiently over the pin
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, '3', 'hover previews over the pin')
  ctxSlots[1][1](null)
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, '2', 'leaving the chart returns to the pinned step')
  ctxSlots[0][1](null) // unpin
  tr = renderView()
  brSlots[8].effect()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, 'live', 'unpinning returns the browser to live')

  console.log('✔ pin linkage test passed (pinned bar drives the browser picker, hover previews over the pin, unpin returns to live)')
})
