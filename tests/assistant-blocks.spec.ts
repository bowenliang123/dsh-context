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

  // The tool call is its own card: head names the tool, the body lists
  // parsed arguments as name/value rows — and no raw/markdown switch.
  // The argument count badge is gone (the rows already show the arguments).
  const callCard = cards[2]
  assert.match(textOf(byClass(callCard, 'lc-ts-card-head')[0]), /→ bash/, 'tool-call card names the tool')
  assert.equal(byClass(callCard, 'lc-ts-card-count').length, 0, 'no argument-count badge on the call card')
  assert.equal(byClass(callCard, 'lc-ts-call-state').length, 0, 'no run-state pill on a pending assistant call')
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

test('tool result: the call half renders as a card with a run-state pill and the payload heads its line count', async () => {
  bed.dataValue = {
    ...snapshot,
    nodes: [
      ...snapshot.nodes,
      { seq: 3, cat: 'tool', tool: 'bash', tokens: 8, time: 66000 },
      // A text-less assistant turn (a pure tool call): its collapsed row
      // previews with the call's own description line.
      { seq: 4, cat: 'assistant', tokens: 5, calls: ['bash'], time: 67000 },
      // Path-taking tools (read / edit) preview with the target path.
      // seq 5 FAILS via the SNAPSHOT only (`isError` on the joined node) —
      // the fold never stamped `err` on the surface node, as happens when a
      // tool reports a failure without error info.
      { seq: 5, cat: 'tool', tool: 'read', tokens: 6, time: 68000 },
      { seq: 6, cat: 'assistant', tokens: 5, calls: ['edit'], time: 69000 },
      // A FAILED tool result on BOTH paths: the fold stamps `err`, the
      // snapshot mirrors `isError`, and the payload carries the dsh
      // `[exit code: N]` marker.
      { seq: 7, cat: 'tool', tool: 'bash', tokens: 9, time: 70000, err: true },
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
        kind: 'tool-result', seq: 5, isError: true,
        call: { name: 'read', argsRaw: '{"file_path":"/tmp/a.ts"}' },
        content: [{ type: 'text', text: 'FILE-CONTENT' }],
      },
      {
        kind: 'assistant', seq: 6,
        blocks: [{ kind: 'tool-call', name: 'edit', argsRaw: '{"file_path":"/tmp/b.ts","old_string":"x","new_string":"y"}' }],
      },
      {
        kind: 'tool-result', seq: 7, isError: true,
        call: { name: 'bash', argsRaw: '{"command":"rm -rf /"}' },
        content: [{ type: 'text', text: '[exit code: 2]\npermission denied' }],
      },
    ],
  })
  brSlots[1][1]('tool') // openCat('tool')
  let tr = renderView()

  // The collapsed row leads with the tool-name chip, then previews with the
  // call's own summary line instead of the generic result label: bash's
  // `description`, a read call's target path. FAILED rows carry the red
  // run-state dot right after the chevron — via the fold `err` stamp OR the
  // snapshot's `isError` alone — and no ⚠ suffix (the dot marks failures).
  const toolRows = byClass(tr, 'lc-br-elem-row')
  assert.equal(toolRows.length, 3, 'all three tool results listed (newest first)')
  assert.equal(byClass(toolRows[0], 'lc-br-err-dot').length, 1, 'failed result carries the red error dot')
  assert.equal(byClass(toolRows[1], 'lc-br-err-dot').length, 1, 'snapshot-only failure carries the red error dot too')
  assert.equal(byClass(toolRows[2], 'lc-br-err-dot').length, 0, 'healthy rows carry no error dot')
  const failedCells = toolRows[0].args.slice(2)
  const chevIdx = failedCells.findIndex(n => n !== null && typeof n === 'object' && (n.args[1]?.className ?? '').includes('lc-br-chev'))
  const dotIdx = failedCells.findIndex(n => n !== null && typeof n === 'object' && (n.args[1]?.className ?? '').includes('lc-br-err-dot'))
  assert.ok(chevIdx >= 0 && dotIdx === chevIdx + 1, 'the red dot sits right after the chevron')
  const readRowText = textOf(toolRows[1])
  assert.ok(readRowText.includes('/tmp/a.ts'), 'read result previews the target path')
  assert.doesNotMatch(readRowText, /node\.toolResult/, 'generic result label replaced by the path')
  assert.equal(textOf(byClass(toolRows[1], 'lc-br-tag')[0]), 'read', 'failed read row leads with its bare tool-name chip')
  assert.doesNotMatch(textOf(toolRows[1]), /⚠/, 'no ⚠ suffix on failed rows (the dot marks failures)')
  const toolRow = toolRows[2]
  const rowText = textOf(toolRow)
  assert.match(rowText, /LIST-FILES/, 'collapsed row previews the call description')
  assert.doesNotMatch(rowText, /node\.toolResult/, 'generic result label replaced')
  const toolTag = byClass(toolRow, 'lc-br-tag')[0]
  assert.equal(textOf(toolTag), 'bash', 'tool row leads with the tool-name chip')
  assert.ok(!/lc-br-tag-inv/.test(toolTag.args[1].className), 'tool-name chip uses the shared subtle tag style')

  brSlots[2][1]('n3')   // expand the tool-result element
  tr = renderView()

  // Card 1: the call — named with the result arrow, NO argument-count
  // badge (the rows already show the arguments), a green OK pill in the
  // head's right edge.
  const callCard = byClass(tr, 'lc-ts-card')[0]
  assert.ok(callCard, 'the tool result opens with a call card')
  assert.match(textOf(byClass(callCard, 'lc-ts-card-head')[0]), /← bash/, 'call card names the tool with the result arrow')
  assert.equal(byClass(callCard, 'lc-ts-card-count').length, 0, 'no argument-count badge on the call card')
  const okPill = byClass(callCard, 'lc-ts-call-ok')[0]
  assert.ok(okPill, 'settled call carries the green OK pill')
  assert.match(textOf(okPill), /OK/, 'OK pill labels the settled call')
  assert.equal(byClass(callCard, 'lc-ts-call-err').length, 0, 'no red pill on a healthy result')
  const argRow = byClass(callCard, 'lc-ts-arg-row')[0]
  assert.equal(textOf(byClass(argRow, 'lc-ts-param-name')[0]), 'command', 'argument named on the left')
  assert.equal(textOf(byClass(argRow, 'lc-ts-arg-val')[0]), 'ls -la', 'argument value on the right')
  assert.equal(byClass(callCard, 'lc-ts-param-type').length, 0, 'no type column')

  // Card 2: the payload — heads its line count BEFORE the raw/markdown
  // switch (the switch stays at the far right), markdown active by default
  // like every prose card.
  const resultCard = byClass(tr, 'lc-ts-card')[1]
  assert.equal(textOf(byClass(resultCard, 'lc-ts-card-meta')[0]), '1 line', 'payload card heads its line count')
  const rightSlots = byClass(resultCard, 'lc-ts-card-right')[0].args.slice(2)
  assert.match(rightSlots[0].args[1].className, /lc-ts-card-meta/, 'line count sits before the switch')
  assert.match(rightSlots[1].args[1].className, /lc-rich-seg/, 'raw/markdown switch sits at the far right')
  assert.match(byClass(resultCard, 'lc-rich-seg-btn')[1].args[1].className, /lc-rich-seg-on/, 'markdown segment active by default')
  assert.equal(byClass(resultCard, 'lc-md-stub').length, 1, 'payload renders markdown by default')
  byClass(resultCard, 'lc-rich-seg-btn')[0].args[1].onClick() // flip to raw
  tr = renderView()
  assert.match(textOf(byClass(tr, 'lc-ts-desc-body')[0]), /RESULT-TEXT/, 'raw view carries the payload text')
  assert.match(byClass(tr, 'lc-rich-seg-btn')[0].args[1].className, /lc-rich-seg-on/, 'raw segment lights up')

  // A SNAPSHOT-only failure (no surface `err` stamp): the expanded call
  // card still swaps the pill for the red Failed pill.
  brSlots[2][1]('n5')   // expand the snapshot-failed element
  tr = renderView()
  const snapPill = byClass(tr, 'lc-ts-call-err')[0]
  assert.ok(snapPill, 'snapshot-only failure carries the red Failed pill')
  assert.match(textOf(snapPill), /Failed/, 'pill labels the failure')
  assert.doesNotMatch(textOf(snapPill), /exit/, 'no exit code in the pill without a marker')

  // A FAILED result on both paths: red Failed pill with the exit code.
  brSlots[2][1]('n7')   // expand the failed element
  tr = renderView()
  const errPill = byClass(tr, 'lc-ts-call-err')[0]
  assert.ok(errPill, 'failed result carries the red Failed pill')
  assert.match(textOf(errPill), /Failed/, 'pill labels the failure')
  assert.match(textOf(errPill), /exit 2/, 'pill surfaces the payload\'s exit code')
  assert.equal(byClass(tr, 'lc-ts-call-ok').length, 0, 'no green pill on the failed result')
  assert.match(textOf(byClass(tr, 'lc-ts-card-meta')[0]), /^2 lines$/, 'two-line payload heads its line count')

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

  console.log('✔ tool-result call card test passed (← card, run-state pill, line count, raw/markdown switch)')
})
