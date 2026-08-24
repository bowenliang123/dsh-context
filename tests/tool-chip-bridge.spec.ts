import assert from 'node:assert/strict'
import { test } from 'vitest'
import { bootViewBed, byClass, textOf } from './helpers/viewBed'

const bed = await bootViewBed()
const { renderView, snapshot } = bed
bed.dataValue = snapshot
let tr = renderView()
const ctxSlots = bed.ctxSlots()
const brSlots = bed.brSlots()

test('overview tool-chip bridge: label opens the tools category, chip expands the tool row, one-shot focus clears', async () => {
  // One-shot tool bridge: brSlots[9] (toolFocus effect) applies then clears the request.
  bed.dataValue = {
    ...snapshot,
    toolList: [
      { name: 'bash', tokens: 5 },
      { name: 'rg', tokens: 3 },
    ],
  }
  bed.headersValue = {
    headers: [{
      seq: 1, time: 900,
      tools: [{ name: 'bash', tokens: 5, description: 'run a command', schema: { name: 'bash', parameters: { type: 'object' } } }],
    }],
  }
  brSlots[2][1](null)
  tr = renderView()
  const toolsLabel = byClass(tr, 'lc-tools-label')[0]
  assert.ok(toolsLabel, '"工具定义 Top" label rendered as a button')
  assert.equal(typeof toolsLabel.args[1].onClick, 'function', 'tools label is clickable')
  let chips = byClass(tr, 'lc-tool-chip')
  assert.equal(chips.length, 2, 'tool chips rendered (two tools)')
  assert.ok(chips.every(c => typeof c.args[1].onClick === 'function'), 'every tool chip is clickable')
  toolsLabel.args[1].onClick()
  tr = renderView()
  assert.deepEqual(ctxSlots[8][0], {}, 'label click records a category-only focus')
  brSlots[9].effect()
  tr = renderView()
  assert.equal(ctxSlots[8][0], null, 'one-shot focus is cleared once applied')
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, 'live', 'focus switches the browser to the live step')
  assert.equal(byClass(tr, 'lc-br-body').length, 1, 'tools category opens in the browser')
  assert.match(textOf(byClass(tr, 'lc-br-body')[0]), /bash/, 'tools category lists the schema rows')
  assert.equal(byClass(tr, 'lc-br-content').length, 0, 'category-only focus expands no specific tool')
  chips = byClass(tr, 'lc-tool-chip')[0].args[1].onClick()
  tr = renderView()
  assert.deepEqual(ctxSlots[8][0], { tool: 'bash' }, 'chip click records a specific-tool focus')
  brSlots[9].effect()
  tr = renderView()
  assert.equal(ctxSlots[8][0], null, 'tool focus cleared once applied')
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, 'live', 'stays on the live step')
  const bridgeContent = byClass(tr, 'lc-br-content')
  assert.equal(bridgeContent.length, 1, 'the clicked tool row expands open')
  assert.match(textOf(bridgeContent[0]), /run a command/, 'the expanded body carries the clicked tool description')
  bed.dataValue = {
    ...snapshot,
    toolList: ['a', 'b', 'c', 'd', 'e', 'f'].map((name, i) => ({ name, tokens: 10 - i })),
  }
  brSlots[1][1](null)
  brSlots[2][1](null)
  tr = renderView()
  const moreBtn = byClass(tr, 'lc-tools-more')[0]
  assert.ok(moreBtn, '"等 N 个" overflow link rendered as a button')
  assert.equal(byClass(tr, 'lc-tool-chip').length, 5, 'still shows only the top five chips')
  assert.equal(typeof moreBtn.args[1].onClick, 'function', 'the overflow link is clickable')
  moreBtn.args[1].onClick()
  tr = renderView()
  assert.deepEqual(ctxSlots[8][0], {}, 'overflow link opens the tools category (no specific tool)')
  brSlots[9].effect()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, 'live', 'stays on the live step')
  assert.equal(byClass(tr, 'lc-br-body').length, 1, 'tools category opens in the browser')

  console.log('✔ overview tool-chip bridge test passed (label opens the tools category, chip expands the tool row, overflow link opens the category too, one-shot focus clears)')
})
