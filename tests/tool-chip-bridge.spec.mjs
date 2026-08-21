/**
 * Overview tool-chip bridge: the tools label, each tool chip, and the
 * overflow link are one-shot bridges into the context browser (open the
 * tools category, optionally expanding one tool row).
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

test('overview tool-chip bridge: label opens the tools category, chip expands the tool row, one-shot focus clears', async () => {
  // ---- overview tool-chip bridge: the "工具定义 Top" label and each tool chip
  // are clickable buttons that link into the Context browser — the label opens
  // the tools category, a chip also expands that specific tool's row. The
  // request is one-shot: applied by the browser's toolFocus effect (hook slot
  // 9) and cleared back so the same chip can be clicked again. ----
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
  brSlots[2][1](null) // no element open from the previous test
  tr = renderView()
  const toolsLabel = byClass(tr, 'lc-tools-label')[0]
  assert.ok(toolsLabel, '"工具定义 Top" label rendered as a button')
  assert.equal(typeof toolsLabel.args[1].onClick, 'function', 'tools label is clickable')
  let chips = byClass(tr, 'lc-tool-chip')
  assert.equal(chips.length, 2, 'tool chips rendered (two tools)')
  assert.ok(chips.every(c => typeof c.args[1].onClick === 'function'), 'every tool chip is clickable')
  // Clicking the label opens the tools category only (no specific tool).
  toolsLabel.args[1].onClick()
  tr = renderView()
  assert.deepEqual(ctxSlots[8][0], {}, 'label click records a category-only focus')
  brSlots[9].effect() // the tool-bridge effect applies the one-shot request
  tr = renderView()
  assert.equal(ctxSlots[8][0], null, 'one-shot focus is cleared once applied')
  assert.equal(byClass(tr, 'lc-br-pick')[0].args[1].value, 'live', 'focus switches the browser to the live step')
  assert.equal(byClass(tr, 'lc-br-body').length, 1, 'tools category opens in the browser')
  assert.match(textOf(byClass(tr, 'lc-br-body')[0]), /bash/, 'tools category lists the schema rows')
  assert.equal(byClass(tr, 'lc-br-content').length, 0, 'category-only focus expands no specific tool')
  // Clicking a specific tool also expands that tool's row.
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
  // The "等 N 个" overflow link (more than five tools) also opens the category.
  bed.dataValue = {
    ...snapshot,
    toolList: ['a', 'b', 'c', 'd', 'e', 'f'].map((name, i) => ({ name, tokens: 10 - i })),
  }
  brSlots[1][1](null) // retract the previously opened category
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
