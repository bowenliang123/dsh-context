/**
 * Assistant block cards: a mixed reply splits thinking / answer into
 * SEPARATE cards, each carrying its OWN raw/markdown switch — toggling one
 * card leaves the other untouched; tool calls stay raw.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { bootViewBed, byClass, textOf } from './helpers/viewBed.mjs'

const bed = await bootViewBed()
const { renderView, snapshot } = bed
bed.dataValue = snapshot
renderView() // mount the ContextBrowser fiber before addressing its hooks
const brSlots = bed.brSlots()

test('assistant blocks: thinking/answer split into cards with independent raw/markdown switches', async () => {
  bed.useSessionHolder = (sel) => sel({
    nodes: [{
      kind: 'assistant', seq: 2, blocks: [
        { kind: 'reasoning', text: 'THINKING-TRACE' },
        { kind: 'text', text: 'ANSWER-TEXT' },
        { kind: 'tool-call', name: 'bash', argsRaw: '{"command":"ls"}' },
      ],
    }],
  })
  brSlots[1][1]('assistant') // openCat('assistant')
  brSlots[2][1]('n2')        // expand the assistant element
  let tr = renderView()

  let cards = byClass(tr, 'lc-ts-card')
  assert.equal(cards.length, 2, 'thinking and answer render as two separate cards')
  assert.match(textOf(cards[0]), /Reasoning/, 'first card titled Reasoning')
  assert.match(textOf(cards[1]), /Response/, 'second card titled Response')
  assert.match(textOf(cards[0]), /THINKING-TRACE/, 'thinking card carries the reasoning text')
  assert.match(textOf(cards[1]), /ANSWER-TEXT/, 'answer card carries the reply text')

  // Each card owns a switch; markdown is the default on BOTH.
  const segsOf = () => byClass(tr, 'lc-ts-card').map(c => byClass(c, 'lc-rich-seg')[0])
  assert.ok(segsOf().every(s => s !== undefined), 'each card carries its own raw/markdown switch')
  for (const s of segsOf()) {
    assert.match(byClass(s, 'lc-rich-seg-btn')[1].args[1].className, /lc-rich-seg-on/, 'markdown segment active by default')
  }
  assert.equal(byClass(tr, 'lc-md-stub').length, 2, 'both cards render markdown by default')

  // The tool call keeps its raw form (no card, no switch).
  assert.equal(byClass(tr, 'lc-br-call').length, 1, 'tool call keeps the raw call row')
  assert.match(textOf(byClass(tr, 'lc-br-call')[0]), /→ bash/, 'tool call names the tool')
  assert.match(textOf(byClass(tr, 'lc-br-call')[0]), /"command":"ls"/, 'tool call args stay raw')

  // Flip the THINKING card to raw: only its own view changes.
  byClass(segsOf()[0], 'lc-rich-seg-btn')[0].args[1].onClick()
  tr = renderView()
  cards = byClass(tr, 'lc-ts-card')
  assert.equal(byClass(cards[0], 'lc-md-stub').length, 0, 'thinking card drops the markdown renderer')
  assert.match(textOf(byClass(cards[0], 'lc-ts-desc-body')[0]), /THINKING-TRACE/, 'thinking card shows the raw text')
  assert.equal(byClass(cards[1], 'lc-md-stub').length, 1, 'answer card keeps its markdown view')
  assert.match(byClass(segsOf()[1], 'lc-rich-seg-btn')[1].args[1].className, /lc-rich-seg-on/, 'answer switch still on markdown')

  // Flipping the ANSWER card leaves the thinking card raw.
  byClass(segsOf()[1], 'lc-rich-seg-btn')[0].args[1].onClick()
  tr = renderView()
  cards = byClass(tr, 'lc-ts-card')
  assert.equal(byClass(tr, 'lc-md-stub').length, 0, 'both cards raw after both flips')
  assert.match(textOf(byClass(cards[1], 'lc-ts-desc-body')[0]), /ANSWER-TEXT/, 'answer card shows the raw text')
  // ...and back to markdown independently.
  byClass(segsOf()[0], 'lc-rich-seg-btn')[1].args[1].onClick()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-md-stub').length, 1, 'thinking card flips back to markdown alone')

  console.log('✔ assistant block card test passed (split cards, independent raw/markdown switches)')
})
