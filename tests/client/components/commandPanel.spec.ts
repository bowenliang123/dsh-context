import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { type Command } from '../../../src/client/commands'
import { mount, query, queryAll, text, click, until } from '../helpers/kit'
import { type ConversationNodeLike } from '../../../src/client/services'
import { Panel, T0, chipCounts, cmd, rowTexts, typeSearch, typeInto } from './commandPanelHarness'

describe('commandPanel', () => {

afterEach(() => { vi.useRealTimers() })

function richCommands(): Command[] {
  return [
    cmd(1, { cmd: 'git status --short', description: 'check the tree', resultSeq: 51, cwd: '/repo' }),
    cmd(2, {
      cmd: 'pnpm exec vitest run tests/client',
      description: 'run the affected tests',
      status: 'failed',
      exit: 1,
      start: T0 + 2000,
      end: T0 + 22000,
      resultSeq: 52,
      stderr: true,
      outChars: 6200,
    }),
    cmd(3, { cmd: 'node .tmp/serve.mjs', status: 'running', background: true, end: undefined, resultSeq: 53 }),
    cmd(4, {
      cmd: "cd /repo && python3 - <<'PY'\nprint('hi')\nPY",
      description: 'inline script',
      start: T0 + 4000,
      end: T0 + 4400,
      derived: true,
      resultSeq: 54,
    }),
  ]
}

describe('CommandPanel — rendering', () => {
  test('rows render time-first with status, duration, badges, the step stamp, and whole-log tallies', async () => {
    const m = await mount(h(Panel, { commands: richCommands(), workspace: '/repo', stampOf: seq => ({ turn: 1, step: seq - 50 }), }))
    const rows = rowTexts(m.container)
    assert.equal(rows.length, 4)
    assert.ok(rows[0].includes("python3 - <<'PY'"), 'the workspace cd prefix is hidden')
    assert.ok(!rows[0].includes('cd /repo'))
    assert.ok(rows[0].includes('3 lines'))
    assert.ok(rows[0].includes('heredoc'))
    assert.ok(rows[0].includes('T1 S4'))
    assert.ok(rows[1].includes('node .tmp/serve.mjs'))
    assert.ok(rows[1].includes('bg'))
    assert.ok(rows[1].includes('Running'))
    assert.equal(text(queryAll(m.container, '.lc-cmd-st-run')[0]), '⏳', 'the running glyph is the hourglass emoji')
    assert.ok(rows[2].includes('pnpm exec vitest run tests/client'))
    assert.ok(rows[2].includes('20.0s'))
    assert.ok(rows[3].includes('git status --short'))
    const kpis = queryAll(m.container, '.lc-cmd-kpi b').map(b => text(b))
    assert.deepEqual(kpis, ['3', '20.5s', '1', '1'])
    await m.unmount()
    const withStats = await mount(h(Panel, { commands: richCommands(), stats: { runs: 128, failed: 9, ms: 42700, bg: 2 }, }))
    assert.deepEqual(queryAll(withStats.container, '.lc-cmd-kpi b').map(b => text(b)), ['128', '42.7s', '9', '2'], 'whole-log stats win')
    await withStats.unmount()
    const withFloor = await mount(h(Panel, { commands: richCommands(), floor: 10 }))
    assert.ok(text(withFloor.container).includes('Covering the latest 4 runs'))
    await withFloor.unmount()
    const without = await mount(h(Panel, { commands: richCommands() }))
    assert.ok(!text(without.container).includes('Covering'))
    await without.unmount()
  })
})

describe('CommandPanel — command coloring', () => {
  test('the collapsed row and the expanded command carry the harness token runs — while uncolored tools and over-long lines render plain', async () => {
    const single = await mount(h(Panel, { commands: [cmd(1, { cmd: 'git status --short', resultSeq: 51 })] }))
    try {
      const preview = query(single.container, '.lc-cmd-cmd')
      const runs = queryAll(preview, 'span')
      assert.ok(runs.length > 1, 'a span per token run')
      assert.equal(runs[0].style.color, 'var(--shiki-token-function)')
      assert.equal(text(preview), 'git status --short', 'the runs carry the preview verbatim')

      await click(query(single.container, '.lc-cmd-row'))
      const full = query(single.container, '.lc-cmd-full')
      assert.ok(queryAll(full, 'span').length > 1, 'the detail colors the whole command')
      assert.equal(text(full), 'git status --short')
    } finally {
      await single.unmount()
    }

    const blank = await mount(h(Panel, { commands: [cmd(1, { cmd: undefined, resultSeq: 51 })] }))
    await click(query(blank.container, '.lc-cmd-row'))
    assert.equal(text(query(blank.container, '.lc-cmd-full')), '', 'a cmd-less record renders an empty command body')
    await blank.unmount()

    const source = "cd /repo && python3 - <<'PY'\nprint('hi')\nPY"
    const m = await mount(h(Panel, { commands: [cmd(1, { cmd: source, resultSeq: 51 })] }))
    await click(query(m.container, '.lc-cmd-row'))
    const full = query(m.container, '.lc-cmd-full')
    assert.equal(text(full), source, 'the runs carry the command text verbatim, newlines included')
    assert.ok(queryAll(full, 'span').length > 3, 'every line carries its token runs')
    await m.unmount()

    const long = 'x'.repeat(1001)
    const plain = await mount(h(Panel, {
      commands: [
        cmd(1, { tool: 'run_code', cmd: 'return 1 + 1' }),
        cmd(2, { cmd: long }),
        cmd(3, { tool: 'pwsh', cmd: 'Get-ChildItem -Recurse' }),
      ],
    }))
    const rows = queryAll(plain.container, '.lc-cmd-cmd')
    assert.ok(text(rows[0]!).endsWith('Get-ChildItem -Recurse'), 'the pwsh preview renders')
    assert.equal(queryAll(rows[1]!, 'span').length, 0)
    assert.equal(text(rows[1]!), long)
    assert.equal(queryAll(rows[2]!, '.lc-cmd-tool').length, 1)
    assert.ok(text(rows[2]!).endsWith('return 1 + 1'), 'the code program stays plain')
    assert.equal(queryAll(rows[2]!, '.lc-cmd-tool + span').length, 0, 'no token runs follow the tool tag')
    await plain.unmount()
  })
})

describe('CommandPanel — filtering, search, sort', () => {
  test('a focus program seeds the lens once and hands the slot back', async () => {
    const handled: string[] = []
    const m = await mount(h(Panel, { commands: richCommands(), focusProgram: 'pnpm', onFocusProgramHandled: () => { handled.push('pnpm') }, }))
    const box = () => query<HTMLInputElement>(m.container, 'input.lc-fa-search').value
    assert.equal(rowTexts(m.container).length, 1, 'the seeded lens narrows to the program')
    assert.ok(rowTexts(m.container)[0].includes('vitest'))
    assert.equal(box(), 'pnpm', 'the box shows the program lens')
    assert.equal(queryAll(m.container, '.lc-cmd-prog-on').length, 1, 'the seeded program is highlighted')
    assert.deepEqual(handled, ['pnpm'], 'the slot is handed back')
    await m.update(h(Panel, {
      commands: richCommands(),
      focusProgram: 'python3',
      onFocusProgramHandled: () => { handled.push('python3') },
    }))
    assert.equal(rowTexts(m.container).length, 1)
    assert.ok(rowTexts(m.container)[0].includes('python3'))
    assert.equal(box(), 'python3')
    assert.deepEqual(handled, ['pnpm', 'python3'])
    await m.update(h(Panel, { commands: richCommands() }))
    assert.equal(rowTexts(m.container).length, 1, 'the seeded lens persists')
    assert.equal(box(), 'python3')
    await m.unmount()
  })

  test('a picked program filters by its own identity, not by the box text', async () => {
    const commands: Command[] = [
      cmd(1, { cmd: 'git status && my\\ cmd --x' }),
      cmd(2, { cmd: 'git diff' }),
    ]
    const m = await mount(h(Panel, { commands }))
    const row = queryAll(m.container, '.lc-cmd-prog').find(b => text(b).startsWith('my cmd'))
    assert.ok(row !== undefined)
    assert.ok(text(row).includes('· 1 run'), 'one record contains the program')
    await click(row)
    assert.equal(rowTexts(m.container).length, 1, 'the label matches the filtered rows')
    assert.ok(rowTexts(m.container)[0].includes('my\\ cmd'), 'the text lens does not hide an escaped name')
    await m.unmount()
  })

  test('the chips filter the list and toggle back off', async () => {
    const m = await mount(h(Panel, { commands: richCommands() }))
    const chip = (label: string) => {
      const hit = queryAll(m.container, '.lc-cmd-chips .lc-gran-btn').find(b => text(b).startsWith(label))
      if (hit === undefined) throw new Error(`chip not found: ${label}`)
      return hit
    }
    for (const [label, cls] of [['All', 'all'], ['Failed', 'failed'], ['Slow', 'slow'], ['Background', 'background']] as const) {
      assert.ok(chip(label).className.includes('lc-cmd-chip-' + cls), `the ${label} chip carries its tone class`)
    }
    assert.ok(chip('All').className.includes('lc-gran-on'), 'All starts active')
    await click(chip('Failed'))
    assert.equal(rowTexts(m.container).length, 1)
    assert.ok(rowTexts(m.container)[0].includes('vitest'))
    assert.ok(!chip('All').className.includes('lc-gran-on') && chip('Failed').className.includes('lc-gran-on'), 'the active tone follows the pick')
    await click(chip('Slow'))
    assert.equal(rowTexts(m.container).length, 1, 'the failed 20s run is also the slow one')
    await click(chip('Background'))
    assert.equal(rowTexts(m.container).length, 1)
    assert.ok(rowTexts(m.container)[0].includes('serve.mjs'))
    await click(chip('Background'))
    assert.equal(rowTexts(m.container).length, 4, 'clicking the active chip resets to all')
    const slowest = queryAll(m.container, '.lc-cmd-ctl .lc-gran-btn').find(b => text(b) === 'Slowest')
    assert.ok(slowest !== undefined)
    await click(slowest)
    const sorted = rowTexts(m.container)
    assert.ok(sorted[0]!.includes('vitest'))
    assert.ok(sorted.at(-1)?.includes('serve.mjs'), 'the running (duration-less) run lands last')
    await m.unmount()
  })

  test('the chips count the filtered rows; the rail stays session-wide and every pick writes the box', async () => {
    const commands: Command[] = [
      cmd(1, { cmd: 'cat README.md' }),
      cmd(2, { cmd: 'echo hi && cat package.json' }),
      cmd(3, { cmd: 'cat missing.txt', status: 'failed', exit: 1, start: T0 + 3000, end: T0 + 15000 }),
      cmd(4, { cmd: 'sleep 20', status: 'running', background: true, end: undefined }),
      cmd(5, { cmd: 'ls -la' }),
    ]
    const m = await mount(h(Panel, { commands }))
    const progs = () => queryAll(m.container, '.lc-cmd-prog').map(p => text(p))
    const attention = () => queryAll(m.container, '.lc-cmd-attn-row').map(r => text(r))
    const ranking = progs()
    const sessionAttention = attention()
    const box = () => query<HTMLInputElement>(m.container, 'input.lc-fa-search').value
    assert.equal(ranking.length, 4, 'cat, echo, sleep, ls')
    assert.ok(ranking.some(p => p.startsWith('cat') && p.includes('×3') && p.includes('3 runs')))
    const echoProgram = queryAll(m.container, '.lc-cmd-prog').find(p => text(p).startsWith('echo'))
    assert.ok(echoProgram !== undefined)
    assert.equal(text(query(echoProgram, '.lc-cmd-prog-runs')), '· 1 run')
    assert.ok(sessionAttention.some(r => r.includes('Slowest') && r.includes('cat missing.txt')))
    assert.ok(sessionAttention.some(r => r.includes('Most failures') && r.includes('cat')))
    assert.ok(sessionAttention.some(r => r.includes('Background')))
    await typeSearch(m.container, 'cat')
    assert.equal(rowTexts(m.container).length, 3)
    assert.deepEqual(chipCounts(m.container), ['3', '1', '1', '0'], 'the chips count the search matches')
    assert.deepEqual(progs(), ranking, 'the search does not move the ranking')
    assert.deepEqual(attention(), sessionAttention, 'the attention facts stay session-wide under the search')
    const progBtn = (name: string) => {
      const hit = queryAll(m.container, '.lc-cmd-prog').find(b => text(b).startsWith(name))
      if (hit === undefined) throw new Error(`program row not found: ${name}`)
      return hit
    }
    await click(progBtn('cat'))
    assert.equal(rowTexts(m.container).length, 3, 'the cat-headed runs and the echo chain all contain cat')
    assert.ok(rowTexts(m.container).some(r => r.includes('cat README.md')))
    assert.ok(rowTexts(m.container).some(r => r.includes('cat package.json')))
    assert.ok(rowTexts(m.container).some(r => r.includes('cat missing.txt')))
    assert.deepEqual(progs(), ranking, 'the pick does not move the ranking')
    assert.deepEqual(attention(), sessionAttention, 'the pick does not move the attention facts')
    assert.deepEqual(chipCounts(m.container), ['3', '1', '1', '0'], 'the chips count the picked scope')
    assert.ok(progBtn('cat').className.includes('lc-cmd-prog-on'))
    assert.equal(progBtn('cat').getAttribute('aria-pressed'), 'true')
    assert.ok((progBtn('cat').getAttribute('title') ?? '').includes('Clear'))
    assert.equal(box(), 'cat', 'the pick writes its name into the filter box')
    await click(progBtn('echo'))
    assert.equal(rowTexts(m.container).length, 1)
    assert.ok(rowTexts(m.container)[0].includes('echo hi && cat package.json'))
    assert.deepEqual(chipCounts(m.container), ['1', '0', '0', '0'])
    assert.equal(box(), 'echo', 'the new pick replaces the box text')
    assert.equal(progBtn('cat').getAttribute('aria-pressed'), 'false')
    assert.ok((progBtn('cat').getAttribute('title') ?? '').includes('Filter'))
    await typeSearch(m.container, 'package')
    assert.equal(rowTexts(m.container).length, 1)
    assert.equal(box(), 'package')
    assert.equal(progBtn('echo').getAttribute('aria-pressed'), 'false', 'editing the box releases the program pick')
    assert.deepEqual(progs(), ranking)
    await typeSearch(m.container, 'cat')
    assert.equal(rowTexts(m.container).length, 3, 'the text lens stands alone')
    await click(progBtn('echo'))
    assert.equal(rowTexts(m.container).length, 1)
    assert.equal(box(), 'echo')
    await click(progBtn('echo'))
    assert.equal(rowTexts(m.container).length, 5, 'the second click clears the program and the box')
    assert.equal(box(), '')
    assert.equal(queryAll(m.container, '.lc-cmd-prog-on').length, 0)
    assert.deepEqual(chipCounts(m.container), ['5', '1', '1', '1'])
    await click(progBtn('cat'))
    assert.equal(rowTexts(m.container).length, 3)
    const failedChip = queryAll(m.container, '.lc-cmd-chips .lc-gran-btn').find(b => text(b).startsWith('Failed'))
    assert.ok(failedChip !== undefined)
    await click(failedChip)
    assert.equal(rowTexts(m.container).length, 1, 'the failed cat run')
    assert.equal(progBtn('cat').getAttribute('aria-pressed'), 'true', 'the chip keeps the pick')
    assert.equal(box(), 'cat', 'the chip does not disturb the box')
    assert.deepEqual(chipCounts(m.container), ['3', '1', '1', '0'])
    const allChip = queryAll(m.container, '.lc-cmd-chips .lc-gran-btn').find(b => text(b).startsWith('All'))
    assert.ok(allChip !== undefined)
    await click(allChip)
    assert.equal(rowTexts(m.container).length, 3)
    await m.update(h(Panel, {
      commands: [
        cmd(2, { cmd: 'echo hi' }),
        cmd(4, { cmd: 'sleep 20', status: 'running', background: true, end: undefined }),
        cmd(5, { cmd: 'ls -la' }),
      ],
    }))
    assert.equal(queryAll(m.container, '.lc-cmd-prog-on').length, 0, 'the vanished pick clears')
    assert.equal(rowTexts(m.container).length, 0, 'no retained command matches the old search')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 3, 'the new retained log re-ranks')
    await m.unmount()

    const outside = await mount(h(Panel, { commands: richCommands(), workspace: '/repo' }))
    const outsideProgs = () => queryAll(outside.container, '.lc-cmd-prog').map(p => text(p))
    const outsideRanking = outsideProgs()
    await typeSearch(outside.container, 'affected')
    assert.equal(rowTexts(outside.container).length, 1, 'the description joins the match')
    await typeSearch(outside.container, '/repo')
    assert.equal(rowTexts(outside.container).length, 2, 'the cwd match joins the command match')
    assert.deepEqual(chipCounts(outside.container), ['2', '0', '0', '0'])
    await typeSearch(outside.container, 'nothing-matches')
    assert.ok(text(outside.container).includes('No commands match the current filters'))
    assert.equal(queryAll(outside.container, '.lc-cmd-attn').length, 1, 'the attention section stays session-wide under the search')
    assert.deepEqual(outsideProgs(), outsideRanking, 'an empty search result keeps the ranking')
    await outside.unmount()
  })

})

describe('CommandPanel — the row detail and actions', () => {
  test('the derived run marks its duration; the reveal bridge fires with the record', async () => {
    const located: Command[] = []
    const m = await mount(h(Panel, { commands: richCommands(), workspace: '/repo', stampOf: seq => ({ turn: 1, step: seq - 50 }), onLocate: rec => { located.push(rec) }, }))
    const first = queryAll(m.container, '.lc-cmd-row')[0]
    assert.ok(text(first).includes('≈'))
    const time = query(first, '.lc-cmd-time')
    await click(time)
    assert.equal(located.length, 1)
    assert.equal(located[0].seq, 4)
    assert.equal(queryAll(m.container, '.lc-cmd-detail').length, 0, 'the reveal does not expand the row')
    await m.unmount()

    const nestedPicks: Command[] = []
    const nested = await mount(h(Panel, {
      commands: [cmd(7, { codeMode: true, parent: 99, cmd: 'git diff', resultSeq: undefined })],
      stampOf: () => ({ turn: 2, step: 3 }),
      onLocate: rec => { nestedPicks.push(rec) },
    }))
    const row = query(nested.container, '.lc-cmd-row')
    assert.ok(text(row).includes('nested'))
    await click(query(row, '.lc-cmd-time'))
    assert.equal(nestedPicks[0].parent, 99)
    await nested.unmount()
  })

  test('the description rides the command card head instead of the command body', async () => {
    const m = await mount(h(Panel, { commands: [cmd(1, { cmd: 'git status', description: 'check the tree' })] }))
    await click(query(m.container, '.lc-cmd-row'))
    const head = query(m.container, '.lc-cmd-detail .lc-ts-card-head')
    const note = query(head, '.lc-ts-card-head-note')
    assert.equal(text(note), 'check the tree')
    assert.equal(note.getAttribute('title'), 'check the tree')
    assert.ok(!text(query(m.container, '.lc-cmd-full')).includes('check the tree'))
    await m.unmount()
  })

})


describe('CommandPanel — the result block', () => {
  const RESULT: ConversationNodeLike = { kind: 'tool', seq: 52, content: [{ type: 'text', text: 'progress 21:40\nVERDICT: PASS' }] }

  test('the result block reads the target node through fetchContent; a cached re-expand skips the loading note', async () => {
    const m = await mount(h(Panel, { commands: richCommands(), fetchContent: async (seq) => (seq === 52 ? RESULT : null), }))
    await click(queryAll(m.container, '.lc-cmd-row')[2])
    const cards = queryAll(m.container, '.lc-cmd-detail .lc-ts-card')
    assert.equal(cards.length, 2, 'one card for the command, one for the result')
    assert.ok(text(cards[1]).includes('VERDICT: PASS'))
    assert.ok(text(cards[1]).includes('2 lines'), 'the result head counts its lines')
    assert.ok(query(cards[1], '.lc-cmd-detail-facts') !== null, 'the facts band closes the result card')
    assert.equal(queryAll(cards[0], '.lc-cmd-detail-facts').length, 0, 'the command card stays clean')
    await click(queryAll(m.container, '.lc-cmd-row')[2])
    assert.equal(queryAll(m.container, '.lc-cmd-detail').length, 0, 'collapse')
    await click(queryAll(m.container, '.lc-cmd-row')[2])
    assert.ok(text(query(m.container, '.lc-cmd-detail')).includes('VERDICT: PASS'), 'the ready text survives the re-expand')
    await m.unmount()

    const bare = await mount(h(Panel, { commands: richCommands() }))
    await click(queryAll(bare.container, '.lc-cmd-row')[2])
    const bareCards = queryAll(bare.container, '.lc-cmd-detail .lc-ts-card')
    assert.equal(bareCards.length, 1, 'no fetcher — no result card')
    assert.ok(query(bareCards[0], '.lc-cmd-detail-facts') !== null, 'the facts band closes the command card')
    await bare.unmount()
  })

  test('keeps only the most recent expanded results so a long session cannot retain every output', async () => {
    const commands = Array.from({ length: 12 }, (_, index) => cmd(index + 1, {
      cmd: `echo out-${index}`,
      resultSeq: 100 + index,
    }))
    const calls: number[] = []
    const outputs = new Map<number, string>()
    for (let seq = 100; seq < 112; seq++) outputs.set(seq, `output-${seq}`)
    const m = await mount(h(Panel, {
      commands,
      fetchContent: async (seq) => {
        calls.push(seq)
        const text = outputs.get(seq)
        return { kind: 'tool', seq, content: [{ type: 'text', text: text ?? '' }] }
      },
    }))
    for (let index = 0; index < 12; index++) {
      const row = queryAll(m.container, '.lc-cmd-item').find(item => text(query(item, '.lc-cmd-cmd')) === `echo out-${index}`)
      assert.ok(row !== undefined)
      await click(query(row, '.lc-cmd-row'))
      await until(() => text(m.container).includes(`output-${100 + index}`), `output ${index} never landed`)
    }
    assert.equal(new Set(calls).size, 12)
    await click(query(queryAll(m.container, '.lc-cmd-item').find(item => text(query(item, '.lc-cmd-cmd')) === 'echo out-0')!, '.lc-cmd-row'))
    await until(() => text(m.container).includes('output-100'), 'the evicted result never re-reads')
    assert.equal(calls.filter(seq => seq === 100).length, 2, 'the oldest result was evicted and read again')
    await m.unmount()
  })

  test('both cards carry the copy and find actions; the result copy writes the result text', async () => {
    const writes: string[] = []
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: (t: string) => { writes.push(t); return Promise.resolve() } },
      configurable: true,
    })
    const m = await mount(h(Panel, { commands: richCommands(), fetchContent: async (seq) => (seq === 52 ? RESULT : null), }))
    await click(queryAll(m.container, '.lc-cmd-row')[2])
    const cards = queryAll(m.container, '.lc-cmd-detail .lc-ts-card')
    assert.equal(cards.length, 2)
    for (const card of cards) {
      assert.ok(query(card, '.lc-rich-copy') !== null, 'the copy rides the head')
      assert.equal(queryAll(card, '.lc-find-btn').length, 1, 'the find toggle rides the head')
    }
    await click(query(cards[1], '.lc-rich-copy'))
    assert.deepEqual(writes, ['progress 21:40\nVERDICT: PASS'], 'the result copy writes the result text')
    await m.unmount()
  })

  test('the find lens opens in a detail card and marks matches inside its own body', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const m = await mount(h(Panel, {
      commands: [cmd(1, { cmd: 'git status --short', description: 'check the tree', resultSeq: 2 })],
      fetchContent: async () => ({ kind: 'tool', seq: 2, content: [{ type: 'text', text: 'nothing here' }] }),
    }))
    await click(query(m.container, '.lc-cmd-row'))
    const cards = queryAll(m.container, '.lc-cmd-detail .lc-ts-card')
    await click(query(cards[0], '.lc-find-btn'))
    const input = query<HTMLInputElement>(cards[0], '.lc-find-input')
    assert.equal(document.activeElement, input, 'the find input takes focus on open')
    const find = async (value: string): Promise<void> => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => { vi.advanceTimersByTime(200) })
    }
    await find('status')
    assert.equal(query(cards[0], '.lc-find-count')?.textContent, '1/1', 'one match in the command card')
    assert.ok(query(cards[0], '.lc-find-mark') !== null, 'the match is marked in the command body')
    assert.equal(queryAll(cards[1], '.lc-find').length, 0, 'the lens stays scoped to its own card')
    await find('git status')
    assert.equal(query(cards[0], '.lc-find-count')?.textContent, '1/1', 'the phrase matches across token runs')
    assert.ok(queryAll(cards[0], '.lc-find-mark').length > 1, 'one mark per run the phrase covers')
    assert.equal(queryAll(cards[0], '.lc-find-mark').map(x => text(x)).join(''), 'git status')
    await m.unmount()
  })

  test('a pending read shows the loading note; a null, rejected, or text-less read shows the miss note', async () => {
    let release: (node: unknown) => void = () => {}
    const deferred = new Promise(resolve => { release = resolve })
    const m = await mount(h(Panel, { commands: [cmd(1, { resultSeq: 2 })], fetchContent: () => deferred as Promise<null>, }))
    await click(query(m.container, '.lc-cmd-row'))
    assert.ok(query(m.container, '.lc-cmd-result-note .lc-skel-note') !== null, 'a pending read paints the loading bar')
    assert.ok(!text(query(m.container, '.lc-cmd-result-note')).includes('Loading history'))
    const resultCard = queryAll(m.container, '.lc-cmd-detail .lc-ts-card')[1]
    assert.equal(queryAll(resultCard, '.lc-rich-copy, .lc-find-btn').length, 0, 'a note-only result card carries no actions')
    await act(async () => { release(null) })
    assert.ok(text(query(m.container, '.lc-cmd-result-note')).includes('outside the loaded message window'), 'a null read misses')
    await m.unmount()
    const rejected = await mount(h(Panel, { commands: [cmd(1, { resultSeq: 2 })], fetchContent: () => Promise.reject(new Error('down')), }))
    await click(query(rejected.container, '.lc-cmd-row'))
    await act(async () => {})
    assert.ok(text(query(rejected.container, '.lc-cmd-result-note')).includes('Result failed to load'), 'a rejection states the failure')
    await rejected.unmount()
    const textless = await mount(h(Panel, { commands: [cmd(1, { resultSeq: 2 })], fetchContent: async () => ({ kind: 'tool', seq: 2, content: [{ type: 'image' }] }), }))
    await click(query(textless.container, '.lc-cmd-row'))
    await act(async () => {})
    assert.ok(text(query(textless.container, '.lc-cmd-result-note')).includes('No text output'), 'no text blocks — the empty note serves')
    await textless.unmount()
  })

  test('a late answer after unmount writes nothing', async () => {
    let settle: (node: ConversationNodeLike | null, reject?: boolean) => void = () => {}
    const fetcher = (): Promise<ConversationNodeLike | null> => new Promise((res, rej) => {
      settle = (node, reject) => (reject === true ? rej(new Error('down')) : res(node))
    })
    for (const [node, reject] of [[RESULT, false], [null, true]] as const) {
      const m = await mount(h(Panel, { commands: [cmd(1, { resultSeq: 2 })], fetchContent: fetcher }))
      await click(query(m.container, '.lc-cmd-row'))
      await m.unmount()
      await act(async () => { settle(node, reject) })
    }
  })

})

describe('CommandPanel — empty and channel states', () => {
  test('an empty log, a loading channel, and a failed channel each render their note', async () => {
    const empty = await mount(h(Panel, { commands: [] }))
    assert.ok(text(empty.container).includes('No commands executed in this session'))
    await empty.unmount()
    const loading = await mount(h(Panel, { commands: [], state: 'loading' }))
    assert.equal(queryAll(loading.container, '.lc-lane.lc-loading-lane.lc-cmd-lane').length, 1, 'the loading lane reserves the log body')
    assert.equal(queryAll(loading.container, '.lc-cmd-rail').length, 0, 'a pending channel owns the full width')
    await loading.unmount()
    const failed = await mount(h(Panel, { commands: [], state: 'failed', onRetry: () => {} }))
    assert.equal(queryAll(failed.container, '.lc-br-retry').length, 1, 'the retry note carries a button')
    assert.equal(queryAll(failed.container, '.lc-cmd-rail').length, 0, 'a failed channel owns the full width')
    await failed.unmount()
    const failedNoRetry = await mount(h(Panel, { commands: [], state: 'failed' }))
    assert.ok(text(failedNoRetry.container).includes('History failed to load'), 'no retry still reads as a failure')
    assert.equal(queryAll(failedNoRetry.container, '.lc-cmd-rail').length, 0)
    await failedNoRetry.unmount()
  })

  test('killed and stopped runs carry their own glyphs; a pwsh run shows its tool tag', async () => {
    const m = await mount(h(Panel, {
      commands: [
        cmd(1, { status: 'killed', signal: 'SIGTERM' }),
        cmd(2, { status: 'killed', stopped: true }),
        cmd(3, { tool: 'pwsh', cmd: 'Get-ChildItem' }),
      ],
    }))
    assert.equal(queryAll(m.container, '.lc-cmd-st-kill').length, 2)
    assert.ok(queryAll(m.container, '.lc-cmd-st-kill').every(el => text(el) === '🛑'), 'the killed glyph is the stop-sign emoji')
    assert.ok(rowTexts(m.container).some(r => r.includes('pwsh')))
    await m.unmount()
  })

  test('the detail lists every fact family and its Reveal action locates the record', async () => {
    const located: Command[] = []
    const full = cmd(9, {
      cmd: 'curl -s https://x',
      description: 'fetch it',
      status: 'failed',
      exit: 28,
      timedOut: true,
      denied: true,
      signal: 'SIGTERM',
      timeoutMs: 40000,
      cwd: '/repo/deep',
      outChars: 30000,
      outTruncated: true,
      stderr: true,
      sandbox: 'full',
      resultSeq: 90,
      start: T0 + 9000,
      end: T0 + 49000,
    })
    const m = await mount(h(Panel, { commands: [full], stampOf: () => ({ turn: 3, step: 2 }), onLocate: rec => { located.push(rec) }, }))
    const row = query(m.container, '.lc-cmd-row')
    await click(row)
    const detail = text(query(m.container, '.lc-cmd-detail'))
    for (const part of ['fetch it', 'exit 28', '40.0s', '/repo/deep', 'timeout 40.0s', '30.0k chars', 'truncated', 'stderr', 'timed out', 'sandbox denied', 'signal SIGTERM', 'asked full']) {
      assert.ok(detail.includes(part), `detail shows: ${part}`)
    }
    assert.ok(text(query(m.container, '.lc-cmd-full')).includes('curl -s https://x'), 'the full command lands verbatim')
    const reveal = query(m.container, '.lc-cmd-detail .lc-find-btn')
    assert.ok((reveal.getAttribute('title') ?? '').includes('T3 S2'), 'the action carries the step stamp')
    await click(reveal)
    assert.deepEqual(located, [full])
    await click(row)
    assert.equal(queryAll(m.container, '.lc-cmd-detail').length, 0, 'clicking again collapses')
    await m.unmount()
  })

  test('the detail hides the exit badge for run_code and shows the inferred ≈', async () => {
    const m = await mount(h(Panel, {
      commands: [
        cmd(1, { tool: 'run_code', cmd: 'await x()', exit: 0, exitInferred: true }),
        cmd(2, { exit: 0, exitInferred: true, resultSeq: 55 }),
      ],
    }))
    const rows = queryAll(m.container, '.lc-cmd-row')
    await click(rows[0])
    assert.ok(text(query(m.container, '.lc-cmd-detail-facts')).includes('exit 0 ≈'), 'the inferred exit is marked')
    await click(rows[0])
    await click(queryAll(m.container, '.lc-cmd-row')[1])
    assert.ok(!text(query(m.container, '.lc-cmd-detail-facts')).includes('exit 0'), 'a code program has no shell exit code')
    await m.unmount()
  })

  test('the copy action needs a clipboard, survives a rejection, and keeps a newer flash through an older timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const m = await mount(h(Panel, { commands: [cmd(1, { resultSeq: 2 }), cmd(2, { cmd: 'git diff', resultSeq: 3 })] }))
    await click(query(m.container, '.lc-cmd-row'))
    const copyBtn = query(m.container, '.lc-cmd-detail .lc-rich-copy')
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: undefined, configurable: true })
    await click(copyBtn)
    assert.equal(copyBtn.getAttribute('title'), 'Copy Raw Text')
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    })
    await click(copyBtn)
    await act(async () => {})
    assert.equal(copyBtn.getAttribute('title'), 'Copy Raw Text')
    const writes: string[] = []
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: (t: string) => { writes.push(t); return Promise.resolve() } },
      configurable: true,
    })
    await click(copyBtn)
    await act(async () => {})
    assert.deepEqual(writes, ['git diff'], 'the command text reaches the clipboard')
    assert.equal(copyBtn.getAttribute('title'), 'Copied')
    await act(async () => { vi.advanceTimersByTime(1300) })
    assert.equal(copyBtn.getAttribute('title'), 'Copy Raw Text')
    const rows = queryAll(m.container, '.lc-cmd-row')
    await click(rows[0]!)
    await click(queryAll(m.container, '.lc-cmd-row')[1]!)
    const secondCopy = query(m.container, '.lc-cmd-detail .lc-rich-copy')
    await click(secondCopy)
    await act(async () => {})
    assert.equal(secondCopy.getAttribute('title'), 'Copied')
    await act(async () => { vi.advanceTimersByTime(1300) })
    assert.equal(secondCopy.getAttribute('title'), 'Copy Raw Text')
    await m.unmount()
  })

  test('the detail of a running, truncated, or stamp-less record renders its honest edges', async () => {
    const m = await mount(h(Panel, {
      commands: [
        cmd(1, { status: 'running', end: undefined, cmd: 'npm run watch' }),
        cmd(2, { cmd: 'x'.repeat(30), cmdTruncated: true, derived: true, resultSeq: 60 }),
        cmd(3, { cmd: 'node -e "console.log(1)"', resultSeq: 61 }),
      ],
      onLocate: () => {},
    }))
    const rows = queryAll(m.container, '.lc-cmd-row')
    assert.ok(text(rows[0]).includes('inline'))
    assert.equal(queryAll(rows.at(-1)!, '.lc-cmd-time-link').length, 0)
    assert.equal(queryAll(rows.at(-1)!, '.lc-cmd-time').length, 1)
    await click(rows.at(-1)!)
    let detail = query(m.container, '.lc-cmd-detail')
    assert.ok(text(detail).includes('npm run watch'))
    assert.ok(!text(detail).includes('≈'))
    await click(rows.at(-1)!)
    await click(queryAll(m.container, '.lc-cmd-row')[1])
    detail = query(m.container, '.lc-cmd-detail')
    assert.ok(text(detail).includes('≈'))
    assert.ok(text(query(m.container, '.lc-cmd-full')).includes('…'))
    assert.ok(query(m.container, '.lc-cmd-detail .lc-find-btn') !== null, 'no stamp suffix when the stamp lookup misses')
    await m.unmount()
  })

})
})

describe('commandPanel.rail', () => {

describe('CommandPanel — the summary rail', () => {
  function railCommands(): Command[] {
    return [
      cmd(1, { cmd: 'cd /repo && git status', resultSeq: 51 }),
      cmd(2, { cmd: 'cd /repo && git diff', resultSeq: 52 }),
      cmd(3, { cmd: 'cd /repo && git status', resultSeq: 53 }),
      cmd(4, {
        cmd: 'cd /repo && pnpm exec vitest run tests/client/components/commandPanel.spec.ts --reporter=verbose',
        status: 'failed',
        exit: 1,
        start: T0 + 4000,
        end: T0 + 94000,
        resultSeq: 54,
      }),
      cmd(5, { cmd: 'pnpm dev', status: 'running', background: true, end: undefined }),
    ]
  }

  test('with two failing programs, the Most failures row lands on exactly its own program’s failures', async () => {
    const commands: Command[] = [
      cmd(1, { cmd: 'vitest run a', status: 'failed', exit: 1 }),
      cmd(2, { cmd: 'vitest run b', status: 'failed', exit: 1 }),
      cmd(3, { cmd: 'eslint src', status: 'failed', exit: 2 }),
      cmd(4, { cmd: 'git status' }),
    ]
    const m = await mount(h(Panel, { commands }))
    const failing = queryAll(m.container, '.lc-cmd-attn-row').find(b => text(b).includes('Most failures'))
    assert.ok(failing !== undefined)
    assert.ok(text(failing).includes('vitest'))
    await click(failing)
    const rows = queryAll(m.container, '.lc-cmd-row')
    assert.equal(rows.length, 2, 'only vitest’s failures show')
    assert.ok(rows.every(r => r.textContent.includes('vitest')))
    assert.equal(query<HTMLInputElement>(m.container, 'input.lc-fa-search').value, 'vitest', 'the box carries the program')
    await m.unmount()
  })

  test('the rail stays session-wide while its lenses drive the list and the filter box', async () => {
    const m = await mount(h(Panel, { commands: railCommands(), workspace: '/repo' }))
    const rail = text(query(m.container, '.lc-cmd-rail'))
    assert.ok(rail.includes('Summary'))
    assert.equal(text(query(m.container, '.lc-cmd-kpi span')), 'runs')
    assert.ok(rail.includes('Program · 2'), 'two distinct programs (git, pnpm)')
    assert.ok(rail.includes('Attention'))
    assert.ok(rail.includes('Slowest'))
    assert.ok(rail.includes('Most failures'))
    assert.ok(rail.includes('Most repeated'))
    assert.ok(rail.includes('Background'))
    const gitProgram = queryAll(m.container, '.lc-cmd-prog').find(b => text(b).startsWith('git'))
    assert.ok(gitProgram !== undefined)
    assert.equal(text(query(gitProgram, '.lc-cmd-prog-runs')), '· 3 runs')
    const rowTextsNow = () => queryAll(m.container, '.lc-cmd-row').map(r => text(r))
    const attentionRows = () => queryAll(m.container, '.lc-cmd-attn-row')
    const attnBtn = (label: string) => {
      const hit = attentionRows().find(b => text(b).includes(label))
      if (hit === undefined) throw new Error(`attention row not found: ${label}`)
      return hit
    }
    const box = () => query<HTMLInputElement>(m.container, 'input.lc-fa-search').value
    assert.equal(attentionRows().length, 4, 'all four session facts are listed')

    const slowestBtn = attnBtn('Slowest')
    await click(slowestBtn)
    assert.ok(rowTextsNow()[0].includes('vitest'))
    assert.equal(box(), 'pnpm exec vitest run tests/client/components/commandPanel.spec.ts --reporter=verbose', 'the slowest lens writes the run’s first line')
    assert.equal(slowestBtn.getAttribute('aria-pressed'), 'true', 'the active lens is marked')
    assert.equal(attentionRows().length, 4, 'the attention list does not follow the lens')
    await click(slowestBtn)
    assert.equal(rowTextsNow().length, 5, 'a second click clears the lens')
    assert.equal(box(), '')

    const failingBtn = attnBtn('Most failures')
    await click(failingBtn)
    assert.equal(rowTextsNow().length, 1)
    assert.ok(rowTextsNow()[0].includes('vitest'))
    assert.equal(box(), 'pnpm', 'the failing lens writes its program')
    const latestChip = queryAll(m.container, '.lc-fa-sort .lc-gran-btn').find(b => text(b).startsWith('Latest'))
    assert.ok(latestChip?.className.includes('lc-gran-on'), 'the previous slowest sort is cleared')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 2, 'the ranking stays global')
    const failingPick = queryAll(m.container, '.lc-cmd-prog-on').find(b => text(b).startsWith('pnpm'))
    assert.ok(failingPick !== undefined, 'the failing program is marked')
    assert.equal(attentionRows().length, 4, 'the attention list stays session-wide under its own lens')
    await click(failingBtn)
    assert.equal(rowTextsNow().length, 5, 'a second click on the active failing lens clears it')
    assert.equal(box(), '')
    assert.equal(queryAll(m.container, '.lc-cmd-prog-on').length, 0)

    const repeatsBtn = attnBtn('Most repeated')
    await click(repeatsBtn)
    const withRepeats = rowTextsNow()
    assert.equal(withRepeats.length, 2, 'both git status runs show')
    assert.ok(withRepeats.every(r => r.includes('git status')))
    const allChip = queryAll(m.container, '.lc-cmd-chips .lc-gran-btn').find(b => text(b).startsWith('All'))
    assert.ok(allChip?.className.includes('lc-gran-on'), 'the All chip is active again')
    assert.equal(box(), 'cd /repo && git status', 'the repeats lens writes its command')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 2, 'the ranking stays global under the search lens')
    assert.equal(attentionRows().length, 4, 'the attention rows never drop out of the rail')
    assert.ok(attentionRows().some(b => text(b).includes('Background')), 'the background fact stays listed')
    await typeSearch(m.container, '')

    const gitBtn = queryAll(m.container, '.lc-cmd-prog').find(b => text(b).startsWith('git'))
    assert.ok(gitBtn !== undefined)
    await click(gitBtn)
    assert.equal(rowTextsNow().length, 3, 'the filtered record count equals the 3 runs label')
    assert.equal(box(), 'git', 'the program pick writes its name')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 2, 'the ranking stays whole')
    assert.equal(queryAll(m.container, '.lc-cmd-prog-on').length, 1, 'the pick is marked')
    assert.equal(gitBtn.getAttribute('aria-pressed'), 'true')
    const picked = queryAll(m.container, '.lc-cmd-prog').find(b => text(b).startsWith('git'))
    assert.ok(picked !== undefined)
    await click(picked)
    assert.equal(rowTextsNow().length, 5)
    assert.equal(box(), '', 'a second click clears the box too')
    assert.equal(queryAll(m.container, '.lc-cmd-prog-on').length, 0)
    const bgBtn = attnBtn('Background')
    await click(bgBtn)
    assert.equal(rowTextsNow().length, 1)
    assert.ok(rowTextsNow()[0].includes('pnpm dev'))
    assert.equal(box(), '', 'the background lens has no text keyword')
    assert.equal(bgBtn.getAttribute('aria-pressed'), 'true')
    await click(bgBtn)
    assert.equal(rowTextsNow().length, 5, 'a second click clears the background lens')
    await m.unmount()
  })

  test('an empty log shows a zero summary and a blank list; a quiet log keeps the real rail', async () => {
    const empty = await mount(h(Panel, { commands: [] }))
    assert.ok(query(empty.container, '.lc-cmd-rail') !== null, 'the summary renders with real zeroes')
    assert.deepEqual(queryAll(empty.container, '.lc-cmd-kpi b').map(b => text(b)), ['0', '0', '0', '0'])
    assert.equal(queryAll(empty.container, '.lc-cmd-progs').length, 0, 'no empty program ranking')
    assert.equal(queryAll(empty.container, '.lc-cmd-attn').length, 0, 'no attention section without notable items')
    assert.equal(queryAll(empty.container, '.lc-cmd-item').length, 0, 'the list stays blank')
    assert.ok(text(empty.container).includes('No commands executed in this session'))
    await empty.unmount()
    const quiet = await mount(h(Panel, { commands: [cmd(1, { start: 0, end: 50 })] }))
    assert.ok(query(quiet.container, '.lc-cmd-rail') !== null, 'the summary still renders')
    assert.equal(queryAll(quiet.container, '.lc-cmd-attn').length, 0, 'no attention section without notable items')
    assert.ok(query(quiet.container, '.lc-cmd-progs') !== null, 'a non-empty log still ranks programs')
    await quiet.unmount()
  })

  test('a long program ranking gets its own search; the duration column heats with wall time', async () => {
    const commands: Command[] = ['grep', 'git', 'pnpm', 'node', 'python3', 'cat', 'sed'].flatMap((prog, i) =>
      Array.from({ length: i + 1 }, (_, j) => cmd(i * 10 + j, { cmd: `${prog} task-${j}` })))
    const m = await mount(h(Panel, {
      commands: [
        ...commands,
        cmd(100, { cmd: 'grep fast', start: 0, end: 500 }),
        cmd(101, { cmd: 'grep one-sec', start: 0, end: 1500 }),
        cmd(102, { cmd: 'grep slow-ish', start: 0, end: 15_000 }),
        cmd(103, { cmd: 'grep very-slow', start: 0, end: 90_000 }),
      ],
    }))
    const search = query<HTMLInputElement>(m.container, '.lc-cmd-prog-search')
    assert.ok(search !== undefined)
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 7, 'all programs listed, not just a top cut')
    const gitProg = queryAll(m.container, '.lc-cmd-prog').find(b => text(b).startsWith('git'))
    assert.ok(gitProg !== undefined)
    await click(gitProg)
    assert.equal(queryAll(m.container, '.lc-cmd-row').length, 2, 'the two git-headed runs')
    await typeInto(m.container, 'input.lc-cmd-prog-search', 'pnpm')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 2, 'pnpm plus the picked git')
    assert.equal(queryAll(m.container, '.lc-cmd-prog-on').length, 1)
    await typeInto(m.container, 'input.lc-cmd-prog-search', 'nothing-matches')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 1, 'the picked program survives the rail search')
    assert.equal(queryAll(m.container, '.lc-cmd-prog-on').length, 1)
    await typeInto(m.container, 'input.lc-cmd-prog-search', '')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 7)
    const gitUnpick = queryAll(m.container, '.lc-cmd-prog').find(b => text(b).startsWith('git'))
    assert.ok(gitUnpick !== undefined)
    await click(gitUnpick)
    assert.equal(queryAll(m.container, '.lc-cmd-row').length, 32)
    await typeInto(m.container, 'input.lc-cmd-prog-search', 'gi')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 1, 'git alone survives the rail search')
    await typeInto(m.container, 'input.lc-cmd-prog-search', 'nothing-matches')
    assert.ok(query(m.container, '.lc-cmd-prog-none') !== null, 'the no-match note renders')
    await typeSearch(m.container, 'grep')
    assert.ok(query(m.container, '.lc-cmd-prog-search') !== null, 'the rail search stays visible')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 0, 'the rail query still applies')
    assert.equal(queryAll(m.container, '.lc-cmd-row').length, 5, 'the list search narrows the rows')
    await typeInto(m.container, 'input.lc-cmd-prog-search', 'grep')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 1)
    await typeInto(m.container, 'input.lc-cmd-prog-search', '')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 7, 'the ranking is still global')
    assert.ok(query(m.container, '.lc-cmd-prog-search') !== null, 'seven programs keep the rail search')
    const durClass = (label: string) => queryAll(m.container, '.lc-cmd-row').find(r => r.textContent.includes(label))?.querySelector('.lc-cmd-dur')?.className ?? ''
    assert.ok(durClass('fast').endsWith('lc-cmd-dur'))
    assert.ok(durClass('one-sec').includes('lc-cmd-dur-1'))
    assert.ok(durClass('slow-ish').includes('lc-cmd-dur-2'))
    assert.ok(durClass('very-slow').includes('lc-cmd-dur-3'))
    await typeInto(m.container, 'input.lc-cmd-prog-search', 'git')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 1)
    await m.update(h(Panel, {
      commands: [
        cmd(10, { cmd: 'git status' }),
        cmd(11, { cmd: 'pnpm build' }),
        cmd(12, { cmd: 'node app.js' }),
      ],
    }))
    assert.ok(query(m.container, '.lc-cmd-prog-search') !== null, 'the typed query keeps its input visible')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 1, 'the query still applies')
    assert.ok(text(queryAll(m.container, '.lc-cmd-prog')[0]).startsWith('git'))
    await typeInto(m.container, 'input.lc-cmd-prog-search', '')
    assert.equal(queryAll(m.container, '.lc-cmd-prog-search').length, 0, 'the input hides below the threshold')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 3)
    await m.unmount()
  })
})
})
