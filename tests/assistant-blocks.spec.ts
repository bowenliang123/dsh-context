/**
 * Assistant block cards: a mixed reply splits thinking / answer / tool-call
 * into SEPARATE cards. The prose cards each carry their OWN raw/markdown
 * switch — toggling one leaves the other untouched; the tool-call card
 * parses its arguments into name/value rows (mirroring the tool
 * definition's parameter card), falling back to the raw payload when the
 * arguments are not a parseable JSON object. A tool RESULT renders its
 * call half through the same card (`←` arrow) with the payload below.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { bootViewBed, byClass, textOf } from './helpers/viewBed'

const bed = await bootViewBed()
const { renderView, snapshot } = bed
bed.dataValue = snapshot
renderView() // mount the ContextBrowser fiber before addressing its hooks
const brSlots = bed.brSlots()

test('assistant blocks: thinking/answer/tool-call split into cards, prose switches independent', async () => {
  bed.useSessionHolder = (sel) => sel({
    nodes: [{
      kind: 'assistant', seq: 2, blocks: [
        { kind: 'reasoning', text: 'THINKING-TRACE' },
        { kind: 'text', text: 'ANSWER-TEXT' },
        { kind: 'tool-call', name: 'bash', argsRaw: '{"command":"ls"}' },
        { kind: 'tool-call', name: 'write', argsRaw: '{bad json' },
      ],
    }],
  })
  brSlots[1][1]('assistant') // openCat('assistant')
  brSlots[2][1]('n2')        // expand the assistant element
  let tr = renderView()

  let cards = byClass(tr, 'lc-ts-card')
  assert.equal(cards.length, 4, 'thinking, answer, and two tool calls render as four separate cards')
  assert.match(textOf(cards[0]), /Reasoning/, 'first card titled Reasoning')
  assert.match(textOf(cards[1]), /Response/, 'second card titled Response')
  assert.match(textOf(cards[0]), /THINKING-TRACE/, 'thinking card carries the reasoning text')
  assert.match(textOf(cards[1]), /ANSWER-TEXT/, 'answer card carries the reply text')

  // Each PROSE card owns a switch; markdown is the default on BOTH.
  const segsOf = () => byClass(tr, 'lc-ts-card').slice(0, 2).map(c => byClass(c, 'lc-rich-seg')[0])
  assert.ok(segsOf().every(s => s !== undefined), 'each prose card carries its own raw/markdown switch')
  for (const s of segsOf()) {
    assert.match(byClass(s, 'lc-rich-seg-btn')[1].args[1].className, /lc-rich-seg-on/, 'markdown segment active by default')
  }
  assert.equal(byClass(tr, 'lc-md-stub').length, 2, 'both prose cards render markdown by default')

  // The tool call is its own card: head names the tool with the argument
  // count, the body lists parsed arguments as name/value rows — and no
  // raw/markdown switch.
  const callCard = cards[2]
  assert.match(textOf(byClass(callCard, 'lc-ts-card-head')[0]), /→ bash/, 'tool-call card names the tool')
  assert.match(textOf(byClass(callCard, 'lc-ts-card-count')[0]), /^1$/, 'argument count badge')
  const argRow = byClass(callCard, 'lc-ts-arg-row')[0]
  assert.equal(textOf(byClass(argRow, 'lc-ts-param-name')[0]), 'command', 'argument named on the left')
  assert.equal(textOf(byClass(argRow, 'lc-ts-arg-val')[0]), 'ls', 'argument value on the right')
  assert.equal(byClass(callCard, 'lc-ts-param-type').length, 0, 'argument rows carry no type column')
  assert.equal(byClass(callCard, 'lc-rich-seg').length, 0, 'tool-call card has no raw/markdown switch')

  // Unparseable arguments fall back to the raw payload inside the same card.
  const badCard = cards[3]
  assert.match(textOf(byClass(badCard, 'lc-ts-card-head')[0]), /→ write/, 'fallback card names the tool')
  assert.equal(byClass(badCard, 'lc-ts-arg-row').length, 0, 'fallback card has no argument rows')
  assert.match(textOf(byClass(badCard, 'lc-ts-desc-body')[0]), /\{bad json/, 'fallback card shows the raw payload')

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
  assert.equal(byClass(tr, 'lc-md-stub').length, 0, 'both prose cards raw after both flips')
  assert.match(textOf(byClass(cards[1], 'lc-ts-desc-body')[0]), /ANSWER-TEXT/, 'answer card shows the raw text')
  // ...and back to markdown independently.
  byClass(segsOf()[0], 'lc-rich-seg-btn')[1].args[1].onClick()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-md-stub').length, 1, 'thinking card flips back to markdown alone')

  console.log('✔ assistant block card test passed (split cards, independent switches, parsed call args)')
})

test('tool result: the call half renders as a card with name/value argument rows', async () => {
  bed.dataValue = {
    ...snapshot,
    nodes: [
      ...snapshot.nodes,
      { seq: 3, cat: 'tool', tool: 'bash', tokens: 8, time: 66000 },
      // A text-less assistant turn (a pure tool call): its collapsed row
      // previews with the call's own description line.
      { seq: 4, cat: 'assistant', tokens: 5, calls: ['bash'], time: 67000 },
      // Path-taking tools (read / edit) preview with the target path.
      { seq: 5, cat: 'tool', tool: 'read', tokens: 6, time: 68000 },
      { seq: 6, cat: 'assistant', tokens: 5, calls: ['edit'], time: 69000 },
    ],
  }
  bed.useSessionHolder = (sel) => sel({
    nodes: [
      {
        kind: 'tool-result', seq: 3,
        call: { name: 'bash', argsRaw: '{"command":"ls -la","description":"LIST-FILES"}' },
        content: [{ type: 'text', text: 'RESULT-TEXT' }],
      },
      {
        kind: 'assistant', seq: 4,
        blocks: [{ kind: 'tool-call', name: 'bash', argsRaw: '{"command":"ls","description":"LIST-FILES-ASST"}' }],
      },
      {
        kind: 'tool-result', seq: 5,
        call: { name: 'read', argsRaw: '{"file_path":"/tmp/a.ts"}' },
        content: [{ type: 'text', text: 'FILE-CONTENT' }],
      },
      {
        kind: 'assistant', seq: 6,
        blocks: [{ kind: 'tool-call', name: 'edit', argsRaw: '{"file_path":"/tmp/b.ts","old_string":"x","new_string":"y"}' }],
      },
    ],
  })
  brSlots[1][1]('tool') // openCat('tool')
  let tr = renderView()

  // The collapsed row leads with an INVERTED chip naming the tool, then
  // previews with the call's own summary line instead of the generic
  // result label: bash's `description`, a read call's target path.
  const toolRows = byClass(tr, 'lc-br-elem-row')
  assert.equal(toolRows.length, 2, 'both tool results listed (newest first)')
  const readRowText = textOf(toolRows[0])
  assert.ok(readRowText.includes('/tmp/a.ts'), 'read result previews the target path')
  assert.doesNotMatch(readRowText, /node\.toolResult/, 'generic result label replaced by the path')
  assert.equal(textOf(byClass(toolRows[0], 'lc-br-tag')[0]), 'read', 'read row leads with its tool-name chip')
  const toolRow = toolRows[1]
  const rowText = textOf(toolRow)
  assert.match(rowText, /LIST-FILES/, 'collapsed row previews the call description')
  assert.doesNotMatch(rowText, /node\.toolResult/, 'generic result label replaced')
  const toolTag = byClass(toolRow, 'lc-br-tag')[0]
  assert.equal(textOf(toolTag), 'bash', 'tool row leads with the tool-name chip')
  assert.ok(!/lc-br-tag-inv/.test(toolTag.args[1].className), 'tool-name chip uses the shared subtle tag style')

  brSlots[2][1]('n3')   // expand the tool-result element
  tr = renderView()

  const callCard = byClass(tr, 'lc-ts-card')[0]
  assert.ok(callCard, 'the tool result opens with a call card')
  assert.match(textOf(byClass(callCard, 'lc-ts-card-head')[0]), /← bash/, 'call card names the tool with the result arrow')
  assert.match(textOf(byClass(callCard, 'lc-ts-card-count')[0]), /^2$/, 'both arguments counted')
  const argRow = byClass(callCard, 'lc-ts-arg-row')[0]
  assert.equal(textOf(byClass(argRow, 'lc-ts-param-name')[0]), 'command', 'argument named on the left')
  assert.equal(textOf(byClass(argRow, 'lc-ts-arg-val')[0]), 'ls -la', 'argument value on the right')
  assert.equal(byClass(callCard, 'lc-ts-param-type').length, 0, 'no type column')
  assert.match(textOf(tr), /RESULT-TEXT/, 'the result payload still renders below the card')

  // The text-less ASSISTANT turns preview the same way: a tool-name
  // breadcrumb chip leads, then the call's summary (bash's
  // description, an edit call's target path) — while a turn WITH text
  // keeps the text preview (no chip: it made no calls).
  brSlots[1][1]('assistant')
  tr = renderView()
  const asstRows = byClass(tr, 'lc-br-elem-row')
  assert.equal(asstRows.length, 3, 'all three assistant turns listed (newest first)')
  const editTag = byClass(asstRows[0], 'lc-br-tag')[0]
  assert.equal(textOf(editTag), 'edit', 'edit turn leads with its tool-name chip')
  assert.ok(!/lc-br-tag-inv/.test(editTag.args[1].className), 'assistant chip shares the subtle tag style too')
  assert.ok(textOf(asstRows[0]).includes('/tmp/b.ts'), 'edit turn previews the target path')
  const asstTag = byClass(asstRows[1], 'lc-br-tag')[0]
  assert.equal(textOf(asstTag), 'bash', 'assistant row leads with the tool-name chip')
  assert.match(textOf(asstRows[1]), /LIST-FILES-ASST/, 'text-less turn previews the call description')
  assert.equal(byClass(asstRows[2], 'lc-br-tag').length, 0, 'text-bearing turn carries no chip')
  assert.match(textOf(asstRows[2]), /second message/, 'text-bearing turn keeps its text preview')

  console.log('✔ tool-result call card test passed (← card, name/value rows, payload below)')
})
