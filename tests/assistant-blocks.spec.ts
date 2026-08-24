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
  brSlots[1][1]('assistant')
  brSlots[2][1]('n2')
  let tr = renderView()

  let cards = byClass(tr, 'lc-ts-card')
  assert.equal(cards.length, 4, 'thinking, answer, and two tool calls render as four separate cards')
  assert.match(textOf(cards[0]), /Reasoning/, 'first card titled Reasoning')
  assert.match(textOf(cards[1]), /Response/, 'second card titled Response')
  assert.match(textOf(cards[0]), /THINKING-TRACE/, 'thinking card carries the reasoning text')
  assert.match(textOf(cards[1]), /ANSWER-TEXT/, 'answer card carries the reply text')

  const segsOf = () => byClass(tr, 'lc-ts-card').slice(0, 2).map(c => byClass(c, 'lc-rich-seg')[0])
  assert.ok(segsOf().every(s => s !== undefined), 'each prose card carries its own raw/markdown switch')
  for (const s of segsOf()) {
    assert.match(byClass(s, 'lc-rich-seg-btn')[1].args[1].className, /lc-rich-seg-on/, 'markdown segment active by default')
  }
  assert.equal(byClass(tr, 'lc-md-stub').length, 2, 'both prose cards render markdown by default')

  // Tool-call card: parsed argument rows replace the old count badge (rows already show the args); no raw/markdown switch.
  const callCard = cards[2]
  assert.match(textOf(byClass(callCard, 'lc-ts-card-head')[0]), /→ bash/, 'tool-call card names the tool')
  assert.equal(byClass(callCard, 'lc-ts-card-count').length, 0, 'no argument-count badge on the call card')
  assert.equal(byClass(callCard, 'lc-ts-call-state').length, 0, 'no run-state pill on a pending assistant call')
  const argRow = byClass(callCard, 'lc-ts-arg-row')[0]
  assert.equal(textOf(byClass(argRow, 'lc-ts-param-name')[0]), 'command', 'argument named on the left')
  assert.equal(textOf(byClass(argRow, 'lc-ts-arg-val')[0]), 'ls', 'argument value on the right')
  assert.equal(byClass(callCard, 'lc-ts-param-type').length, 0, 'argument rows carry no type column')
  assert.equal(byClass(callCard, 'lc-rich-seg').length, 0, 'tool-call card has no raw/markdown switch')

  const badCard = cards[3]
  assert.match(textOf(byClass(badCard, 'lc-ts-card-head')[0]), /→ write/, 'fallback card names the tool')
  assert.equal(byClass(badCard, 'lc-ts-arg-row').length, 0, 'fallback card has no argument rows')
  assert.match(textOf(byClass(badCard, 'lc-ts-desc-body')[0]), /\{bad json/, 'fallback card shows the raw payload')

  byClass(segsOf()[0], 'lc-rich-seg-btn')[0].args[1].onClick()
  tr = renderView()
  cards = byClass(tr, 'lc-ts-card')
  assert.equal(byClass(cards[0], 'lc-md-stub').length, 0, 'thinking card drops the markdown renderer')
  assert.match(textOf(byClass(cards[0], 'lc-ts-desc-body')[0]), /THINKING-TRACE/, 'thinking card shows the raw text')
  assert.equal(byClass(cards[1], 'lc-md-stub').length, 1, 'answer card keeps its markdown view')
  assert.match(byClass(segsOf()[1], 'lc-rich-seg-btn')[1].args[1].className, /lc-rich-seg-on/, 'answer switch still on markdown')

  byClass(segsOf()[1], 'lc-rich-seg-btn')[0].args[1].onClick()
  tr = renderView()
  cards = byClass(tr, 'lc-ts-card')
  assert.equal(byClass(tr, 'lc-md-stub').length, 0, 'both prose cards raw after both flips')
  assert.match(textOf(byClass(cards[1], 'lc-ts-desc-body')[0]), /ANSWER-TEXT/, 'answer card shows the raw text')
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
        content: [{ type: 'text', text: 'permission denied\n[exit code: 2]' }],
      },
    ],
  })
  brSlots[1][1]('tool')
  let tr = renderView()

  // Collapsed tool rows: chip + call summary line; failures get the red dot (fold err OR snapshot isError), no ⚠ suffix.
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

  brSlots[2][1]('n3')
  tr = renderView()

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

  const resultCard = byClass(tr, 'lc-ts-card')[1]
  assert.equal(textOf(byClass(resultCard, 'lc-ts-card-meta')[0]), '1 line', 'payload card heads its line count')
  const rightSlots = byClass(resultCard, 'lc-ts-card-right')[0].args.slice(2)
  assert.match(rightSlots[0].args[1].className, /lc-ts-card-meta/, 'line count sits before the switch')
  assert.match(rightSlots[1].args[1].className, /lc-rich-seg/, 'raw/markdown switch sits at the far right')
  assert.match(byClass(resultCard, 'lc-rich-seg-btn')[1].args[1].className, /lc-rich-seg-on/, 'markdown segment active by default')
  assert.equal(byClass(resultCard, 'lc-md-stub').length, 1, 'payload renders markdown by default')
  byClass(resultCard, 'lc-rich-seg-btn')[0].args[1].onClick()
  tr = renderView()
  assert.match(textOf(byClass(tr, 'lc-ts-desc-body')[0]), /RESULT-TEXT/, 'raw view carries the payload text')
  assert.match(byClass(tr, 'lc-rich-seg-btn')[0].args[1].className, /lc-rich-seg-on/, 'raw segment lights up')

  brSlots[2][1]('n5')
  tr = renderView()
  const snapPill = byClass(tr, 'lc-ts-call-err')[0]
  assert.ok(snapPill, 'snapshot-only failure carries the red Failed pill')
  assert.match(textOf(snapPill), /Failed/, 'pill labels the failure')
  assert.doesNotMatch(textOf(snapPill), /exit/, 'no exit code in the pill without a marker')

  brSlots[2][1]('n7')
  tr = renderView()
  const errPill = byClass(tr, 'lc-ts-call-err')[0]
  assert.ok(errPill, 'failed result carries the red Failed pill')
  assert.match(textOf(errPill), /Failed/, 'pill labels the failure')
  assert.match(textOf(errPill), /exit 2/, 'pill surfaces the payload\'s exit code')
  assert.equal(byClass(tr, 'lc-ts-call-ok').length, 0, 'no green pill on the failed result')
  assert.match(textOf(byClass(tr, 'lc-ts-card-meta')[0]), /^2 lines$/, 'two-line payload heads its line count')

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

test('tool result: a trailing exit-code or signal marker marks the run FAILED without err/isError', async () => {
  bed.dataValue = {
    ...snapshot,
    nodes: [
      ...snapshot.nodes,
      // dsh settles a failing COMMAND as a completed call: the fold stamps no `err`, the snapshot carries no
      // `isError` — the trailing marker is the only failure signal (the chat row's terminalFailed does the same).
      { seq: 3, cat: 'tool', tool: 'bash', tokens: 8, time: 66000 },
      { seq: 4, cat: 'tool', tool: 'bash', tokens: 8, time: 67000 },
      // Marker text quoted mid-output (e.g. a cat'ed log) is NOT a failure — the match is end-anchored.
      { seq: 5, cat: 'tool', tool: 'bash', tokens: 8, time: 68000 },
    ],
  }
  bed.useSessionHolder = (sel) => sel({
    nodes: [
      {
        kind: 'tool-result', seq: 3,
        call: { name: 'bash', argsRaw: '{"command":"grep -n x f","description":"GREP"}' },
        content: [{ type: 'text', text: '(no output)\n[exit code: 1]' }],
      },
      {
        kind: 'tool-result', seq: 4,
        call: { name: 'bash', argsRaw: '{"command":"sleep 9","description":"SLEEP"}' },
        content: [{ type: 'text', text: 'partial\n[killed by signal: SIGTERM]' }],
      },
      {
        kind: 'tool-result', seq: 5,
        call: { name: 'bash', argsRaw: '{"command":"cat log","description":"CAT"}' },
        content: [{ type: 'text', text: '[exit code: 1]\nquoted marker text' }],
      },
    ],
  })
  brSlots[1][1]('tool')
  let tr = renderView()
  const toolRows = byClass(tr, 'lc-br-elem-row')
  assert.equal(toolRows.length, 3, 'all three tool results listed (newest first)')
  assert.equal(byClass(toolRows[0], 'lc-br-err-dot').length, 0, 'quoted marker text is not a failure')
  assert.equal(byClass(toolRows[1], 'lc-br-err-dot').length, 1, 'signal-killed row carries the red error dot')
  assert.equal(byClass(toolRows[2], 'lc-br-err-dot').length, 1, 'exit-code row carries the red error dot')

  brSlots[2][1]('n3')
  tr = renderView()
  const errPill = byClass(tr, 'lc-ts-call-err')[0]
  assert.ok(errPill, 'marker-only failure carries the red Failed pill')
  assert.match(textOf(errPill), /exit 1/, 'pill surfaces the marker exit code')
  assert.equal(byClass(tr, 'lc-ts-call-ok').length, 0, 'no green OK pill on the marker failure')

  brSlots[2][1]('n4')
  tr = renderView()
  const sigPill = byClass(tr, 'lc-ts-call-err')[0]
  assert.ok(sigPill, 'signal-killed result carries the red Failed pill')
  assert.doesNotMatch(textOf(sigPill), /exit/, 'no exit code in the pill without the marker')

  brSlots[2][1]('n5')
  tr = renderView()
  assert.ok(byClass(tr, 'lc-ts-call-ok')[0], 'quoted marker text keeps the green OK pill')
  assert.equal(byClass(tr, 'lc-ts-call-err').length, 0, 'no red pill on the quoted-marker result')

  console.log('✔ marker-only failure test passed (exit-code dot+pill, signal dot+pill, quoted marker stays OK)')
})

test('tool result: persistent-shell death markers mark the run FAILED, a clean shell exit stays a notice', async () => {
  bed.dataValue = {
    ...snapshot,
    nodes: [
      ...snapshot.nodes,
      // The persistent shell died with the failing command: `[shell exited: code N]` rides LAST, after the
      // command's own `[exit code: N]` — the command marker must still win the pill's exit number.
      { seq: 3, cat: 'tool', tool: 'bash', tokens: 8, time: 66000 },
      { seq: 4, cat: 'tool', tool: 'bash', tokens: 8, time: 67000 },
      // A clean shell exit (code 0 / code-less) loses the session but is not a command failure.
      { seq: 5, cat: 'tool', tool: 'bash', tokens: 8, time: 68000 },
      { seq: 6, cat: 'tool', tool: 'bash', tokens: 8, time: 69000 },
    ],
  }
  bed.useSessionHolder = (sel) => sel({
    nodes: [
      {
        kind: 'tool-result', seq: 3,
        call: { name: 'bash', argsRaw: '{"command":"kill $$","description":"KILL-SHELL"}' },
        content: [{ type: 'text', text: 'boom\n[exit code: 1]\n[shell exited: code 1]' }],
      },
      {
        kind: 'tool-result', seq: 4,
        call: { name: 'bash', argsRaw: '{"command":"sleep 9","description":"SLEEP"}' },
        content: [{ type: 'text', text: 'partial\n[shell killed by signal: SIGKILL]' }],
      },
      {
        kind: 'tool-result', seq: 5,
        call: { name: 'bash', argsRaw: '{"command":"exit","description":"EXIT"}' },
        content: [{ type: 'text', text: 'done\n[shell exited: code 0]' }],
      },
      {
        kind: 'tool-result', seq: 6,
        call: { name: 'bash', argsRaw: '{"command":"exit","description":"EXIT"}' },
        content: [{ type: 'text', text: 'done\n[shell exited]' }],
      },
    ],
  })
  brSlots[1][1]('tool')
  let tr = renderView()
  const toolRows = byClass(tr, 'lc-br-elem-row')
  assert.equal(toolRows.length, 4, 'all four tool results listed (newest first)')
  assert.equal(byClass(toolRows[0], 'lc-br-err-dot').length, 0, 'code-less shell exit is a notice, not a failure')
  assert.equal(byClass(toolRows[1], 'lc-br-err-dot').length, 0, 'clean shell exit (code 0) is a notice, not a failure')
  assert.equal(byClass(toolRows[2], 'lc-br-err-dot').length, 1, 'signal-killed shell carries the red error dot')
  assert.equal(byClass(toolRows[3], 'lc-br-err-dot').length, 1, 'shell exit with the failed command carries the red error dot')

  brSlots[2][1]('n3')
  tr = renderView()
  const errPill = byClass(tr, 'lc-ts-call-err')[0]
  assert.ok(errPill, 'shell-death result carries the red Failed pill')
  assert.match(textOf(errPill), /exit 1/, 'pill surfaces the command exit code behind the shell marker')

  brSlots[2][1]('n5')
  tr = renderView()
  assert.ok(byClass(tr, 'lc-ts-call-ok')[0], 'clean shell exit keeps the green OK pill')

  console.log('✔ persistent-shell marker test passed (shell death fails, clean exit stays a notice)')
})
