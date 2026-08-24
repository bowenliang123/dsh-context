import assert from 'node:assert/strict'
import { test } from 'vitest'
import { bootViewBed, byClass, textOf } from './helpers/viewBed'

const bed = await bootViewBed()
const { renderView, snapshot } = bed
bed.dataValue = snapshot
let tr = renderView()
const ctxSlots = bed.ctxSlots()
const brSlots = bed.brSlots()

test('trend chart <-> browser linkage: hover previews its step, pin locks it, unpin returns to live', async () => {
  // Hover flow: ctxSlots[1] is hoveredSeq, mirroring TrendChart's onHover.
  ctxSlots[1][1](2)
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

  // Pin flow: ctxSlots[0] is selectedSeq; brSlots[8] is the pin-linkage effect.
  ctxSlots[0][1](2)
  tr = renderView()
  brSlots[8].effect()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, '2', 'pinned bar drives the browser picker')
  assert.match(textOf(byClass(tr, 'lc-br-meta')[0]), /Turn 1 · Step 1/, 'meta shows the pinned step')
  ctxSlots[1][1](3) // hovering another bar still previews transiently over the pin
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, '3', 'hover previews over the pin')
  ctxSlots[1][1](null)
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, '2', 'leaving the chart returns to the pinned step')
  ctxSlots[0][1](null)
  tr = renderView()
  brSlots[8].effect()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, 'live', 'unpinning returns the browser to live')

  console.log('✔ pin linkage test passed (pinned bar drives the browser picker, hover previews over the pin, unpin returns to live)')
})
