import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { type ContextBrowserProps } from '../../../src/client/components/browser'
import { type ContextHeaders, UNKNOWN_TOOL_SOURCE, type HeaderEpochContent } from '../../../src/shared/types'
import { type ConversationNodeLike, type ImageLoader } from '../../../src/client/services'
import { click, flush, mount, query, queryAll, surfaceNode, text, type Mounted } from '../helpers/kit'
import { Browser, catRow, elemRows, filterStat, kit, props, tl, typeToolSearch, pickStep, req, settings } from './browserHarness'

describe('browserMessageCategories', () => {

describe('ContextBrowser message categories', () => {
  const convNodes: ConversationNodeLike[] = [
    { kind: 'user', seq: 1, content: [
      { type: 'image', attachment: { attachmentId: 'a1', name: 'one.png', bytes: 2048, width: 100, height: 50 } },
      { type: 'image', attachment: { attachmentId: 'a2' } },
      { type: 'text', text: 'with images' },
    ] },
    { kind: 'user', seq: 2, content: [
      { type: 'text', text: 'one pic' },
      { kind: 'image', attachment: { attachmentId: 'a3' } },
    ] },
    { kind: 'user', seq: 5 },
    { kind: 'assistant', seq: 68, blocks: [
      { kind: 'text', text: 'final answer' },
      { type: 'reasoning', text: 'thinking hard' },
      { kind: 'tool-call', name: 'bash', argsRaw: '{"command":"ls","timeout":30,"opts":{"a":1}}' },
      { kind: 'tool-call', name: 'broken', argsRaw: 'not json' },
      { type: 'tool-call', arguments: '{"file_path":"x.ts"}' },
      { kind: 'tool-call', name: 'noargs' },
      { type: 'tool-result', content: [
        { type: 'text', text: 'inner result' },
        { type: 'image', attachment: { attachmentId: 'b1' } },
      ] },
      { type: 'tool-result', content: 'not-an-array' },
      { kind: 'image', attachment: { attachmentId: 'b2', name: 'pic.png', bytes: 4096, width: 640, height: 480 } },
      { type: 'mystery', foo: 1 },
      { type: 'text', text: 42 },
      { kind: 'reasoning', text: 42 },
      'plain string block',
      { foo: 'bar' },
    ] },
    { kind: 'assistant', seq: 67, content: [{ type: 'text', text: 'legacy body' }] },
    { kind: 'assistant', seq: 62, blocks: [{ kind: 'tool-call', name: 'write', argsRaw: '{"file_path":"a.ts"}' }] },
    { kind: 'assistant', seq: 63, blocks: [{ kind: 'tool-call', name: 'read', argsRaw: '{}' }] },
    { kind: 'assistant', seq: 64, blocks: [{ kind: 'tool-call', name: 'edit', argsRaw: '{"path":"b.ts"}' }] },
    { kind: 'compaction', seq: 70, summary: 'SUMMARY BODY' },
    { kind: 'compaction', seq: 71, summary: null },
    { kind: 'compaction', seq: 72, summary: '' },
    { kind: 'user', seq: 54, content: [{ type: 'text', text: 'relay body full' }] },
  ]

  const data = tl({
    current: { system: 0, tools: 0, user: 40, inject: 20, skill: 0, assistant: 60, tool: 30, total: 150 },
    nodes: [
      surfaceNode({ seq: 1, tokens: 10, text: 'with images', time: 100 }),
      surfaceNode({ seq: 2, tokens: 9, text: 'one pic', time: 200 }),
      surfaceNode({ seq: 3, tokens: 5, text: 'fallback text', time: 300 }),
      surfaceNode({ seq: 4, tokens: 4, text: '', time: 400 }),
      surfaceNode({ seq: 5, tokens: 4, text: 'no content array', time: 500 }),
      surfaceNode({ seq: 50, cat: 'inject', tokens: 5, form: 'snapshot', text: 'state' }),
      surfaceNode({ seq: 51, cat: 'inject', tokens: 5, form: 'notice', text: 'heads up' }),
      surfaceNode({ seq: 55, cat: 'inject', tokens: 5, form: 'notice', text: '' }),
      surfaceNode({ seq: 56, cat: 'inject', tokens: 5, text: 'no form' }),
      surfaceNode({ seq: 54, cat: 'inject', tokens: 5, form: 'relay', text: 'relay body' }),
      surfaceNode({ seq: 61, cat: 'assistant', tokens: 8, calls: ['bash', 'write'], text: 'done all' }),
      surfaceNode({ seq: 62, cat: 'assistant', tokens: 8, calls: ['write'] }),
      surfaceNode({ seq: 63, cat: 'assistant', tokens: 8, calls: ['read'] }),
      surfaceNode({ seq: 64, cat: 'assistant', tokens: 8 }),
      surfaceNode({ seq: 65, cat: 'assistant', tokens: 8 }),
      surfaceNode({ seq: 66, cat: 'assistant', tokens: 8, calls: [], text: 'plain text' }),
      surfaceNode({ seq: 67, cat: 'assistant', tokens: 8, text: 'legacy' }),
      surfaceNode({ seq: 68, cat: 'assistant', tokens: 20, text: 'full cascade' }),
      surfaceNode({ seq: 70, tokens: 6, text: 'summary node' }),
      surfaceNode({ seq: 71, tokens: 6, text: '' }),
      surfaceNode({ seq: 72, tokens: 6, text: 'empty summary' }),
    ],
  })

  const loadImage: ImageLoader = async (att) => {
    if (att.attachmentId === 'a3' || att.attachmentId === 'b1') throw new Error('denied')
    return 'blob:' + att.attachmentId
  }

  const mountBrowser = async (over: Partial<ContextBrowserProps> = {}) =>
    mount(h(Browser, props({ data, convNodes, loadImage, ...over })))

  test('user rows: image chips on collapsed rows, join content, fallbacks', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'user'))
    const rows = elemRows(m)
    assert.equal(rows.length, 8, 'user + compaction nodes, newest first')
    assert.equal(text(query(rows[0], '.lc-br-preview')), 'empty summary')
    const rowOf = (preview: string) => rows.find(r => text(r).includes(preview)) as HTMLElement
    assert.ok(text(rowOf('with images')).includes('Attachments ×2'))
    assert.ok(text(rowOf('one pic')).includes('Attachments'))
    assert.ok(!text(rowOf('one pic')).includes('×'))
    await click(rowOf('with images'))
    await flush()
    let content = query(m.container, '.lc-br-content')
    assert.ok(!text(elemRows(m).find(r => text(r).includes('with images')) as HTMLElement).includes('Attachments ×2'),
      'expanded row drops the chip')
    assert.ok(text(content).includes('Attachments'))
    const imgs = queryAll<HTMLImageElement>(content, '.lc-att-thumb img')
    assert.equal(imgs.length, 2, 'both loads resolved')
    assert.ok(imgs[0].src.includes('blob:a1'))
    assert.ok(text(content).includes('one.png'))
    assert.ok(text(content).includes('100×50'))
    await click(elemRows(m).find(r => text(r).includes('with images')) as HTMLElement)

    await click(rowOf('one pic'))
    await flush()
    content = query(m.container, '.lc-br-content')
    assert.equal(queryAll(content, '.lc-att-err').length, 1)
    assert.ok(text(query(content, '.lc-att-err')).includes('⚠'))
    await click(elemRows(m).find(r => text(r).includes('one pic')) as HTMLElement)

    await click(rowOf('fallback text'))
    content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('fallback text'))
    assert.ok(text(content).includes('outside the loaded message window'))
    await click(elemRows(m).find(r => text(r).includes('fallback text')) as HTMLElement)

    assert.ok(text(rows[4]).includes('(non-text message)'))
    await click(rows[4])
    content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('outside the loaded message window'))
    assert.ok(!text(content).includes('Content'))
    await click(elemRows(m).find(r => text(r).includes('no content array')) as HTMLElement)
    content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('outside the loaded message window'))
    await m.unmount()

    const noLoader = await mountBrowser({ loadImage: undefined })
    await click(catRow(noLoader, 'user'))
    await click(elemRows(noLoader).find(r => text(r).includes('one pic')) as HTMLElement)
    assert.equal(queryAll(noLoader.container, '.lc-att-ph').length, 1, 'no loader → placeholder')
    await noLoader.unmount()
  })

  test('a single-node category opens its node with the category', async () => {
    const solo = tl({
      current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
      nodes: [surfaceNode({ seq: 1, tokens: 10, text: 'only message', time: 100 })],
    })
    const m = await mount(h(Browser, props({
      data: solo,
      convNodes: [{ kind: 'user', seq: 1, content: [{ type: 'text', text: 'only message' }] }],
    })))
    await click(catRow(m, 'user'))
    assert.equal(elemRows(m).length, 1)
    assert.equal(queryAll(m.container, '.lc-br-content').length, 1, 'the lone node is already expanded')
    assert.ok(text(query(m.container, '.lc-br-content')).includes('only message'))
    await m.unmount()
  })

  test('message rows filter by tag and preview text; another category opens unfiltered', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'user'))
    const input = query<HTMLInputElement>(m.container, '.lc-br-tool-search')
    assert.equal(input.placeholder, 'Filter by message text…')
    const previews = () => elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    assert.equal(filterStat(m), '×8 ≈40')
    await typeToolSearch(m, 'summary')
    assert.deepEqual(previews(), ['empty summary', 'summary node'])
    assert.equal(filterStat(m), '×2 ≈12')
    await typeToolSearch(m, 'zzz')
    assert.equal(elemRows(m).length, 0)
    assert.equal(filterStat(m), '×0 ≈0')
    assert.ok(text(m.container).includes('No rows match the current filter'))
    assert.equal(queryAll(m.container, '.lc-br-tool-search').length, 1)
    await typeToolSearch(m, '')
    assert.equal(elemRows(m).length, 8)
    assert.equal(filterStat(m), '×8 ≈40')

    await click(catRow(m, 'assistant'))
    assert.equal(query<HTMLInputElement>(m.container, '.lc-br-tool-search').value, '', 'another category opens unfiltered')
    assert.equal(filterStat(m), '×8 ≈60')
    await typeToolSearch(m, 'bash')
    assert.deepEqual(previews(), ['full cascade', 'done all'])
    assert.equal(filterStat(m), '×2 ≈28')
    await typeToolSearch(m, 'thinking hard')
    assert.deepEqual(elemRows(m).map(r => text(query(r, '.lc-br-preview'))), ['full cascade'])
    await typeToolSearch(m, '42')
    assert.equal(elemRows(m).length, 0)
    assert.ok(text(query(m.container, '.lc-br-body')).includes('No rows match the current filter'))
    await m.unmount()
  })

  test('assistant kind chips: per-kind counts, click filters, re-click clears, switch resets', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'assistant'))
    const toolctl = query(m.container, '.lc-br-toolctl')
    assert.equal(queryAll(m.container, '.lc-br-toolctl .lc-gran').length, 1, 'only the assistant toolbar carries the kind group')
    assert.equal(query(toolctl, '.lc-gran').getAttribute('title'), kit.t('browser.kindTip'))
    assert.equal(query<HTMLInputElement>(toolctl, '.lc-br-tool-search').placeholder, 'Filter by reply, calls, or thinking…')
    const chips = () => queryAll<HTMLButtonElement>(m.container, '.lc-br-toolctl .lc-gran-btn')
    assert.deepEqual(chips().map(c => text(c)), ['Thinking1', 'Tools5', 'Answer4'])
    const previews = () => elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    assert.equal(elemRows(m).length, 8)

    await typeToolSearch(m, 'bash')
    assert.equal(elemRows(m).length, 2)
    assert.deepEqual(chips().map(c => text(c)), ['Thinking1', 'Tools2', 'Answer2'], 'counts follow the search lens')
    await typeToolSearch(m, '')
    assert.equal(elemRows(m).length, 8)
    assert.deepEqual(chips().map(c => text(c)), ['Thinking1', 'Tools5', 'Answer4'], 'clearing the search restores the step totals')

    await click(chips()[1])
    assert.ok(chips()[1].className.includes('lc-gran-on'))
    assert.deepEqual(previews(), ['full cascade', 'b.ts', '(empty reply)', 'a.ts', 'done all'])
    await typeToolSearch(m, 'done')
    assert.deepEqual(previews(), ['done all'])
    assert.deepEqual(chips().map(c => text(c)), ['Thinking0', 'Tools1', 'Answer1'], 'counts follow the search lens')
    await typeToolSearch(m, 'zzz')
    assert.equal(elemRows(m).length, 0)
    assert.ok(text(query(m.container, '.lc-br-body')).includes('No rows match the current filter'))
    assert.equal(chips().length, 3, 'the chips stay mounted on an empty match')
    assert.deepEqual(chips().map(c => text(c)), ['Thinking0', 'Tools0', 'Answer0'])
    await typeToolSearch(m, '')
    assert.equal(elemRows(m).length, 5)
    assert.deepEqual(chips().map(c => text(c)), ['Thinking1', 'Tools5', 'Answer4'], 'the kind pick does not narrow the restored totals')

    await click(chips()[1])
    assert.equal(elemRows(m).length, 8)
    await click(chips()[0])
    assert.deepEqual(previews(), ['full cascade'])
    await click(chips()[2])
    assert.ok(chips()[2].className.includes('lc-gran-on'))
    assert.ok(!chips()[0].className.includes('lc-gran-on'), 'the kinds are exclusive')
    assert.deepEqual(previews(), ['full cascade', 'legacy', 'Calls ', 'done all'])

    await click(catRow(m, 'user'))
    assert.equal(queryAll(m.container, '.lc-br-toolctl .lc-gran-btn').length, 0)
    await click(catRow(m, 'assistant'))
    assert.deepEqual(chips().map(c => text(c)), ['Thinking1', 'Tools5', 'Answer4'])
    assert.ok(chips().every(c => !c.className.includes('lc-gran-on')))
    assert.equal(elemRows(m).length, 8)
    await m.unmount()
  })

  test('the Answer kind follows the fold-stamped reply text, never a blank join text block', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 16, tool: 0, total: 16 },
      nodes: [
        surfaceNode({ seq: 2, cat: 'assistant', tokens: 8, calls: ['bash'] }),
        surfaceNode({ seq: 3, cat: 'assistant', tokens: 8, text: 'real reply' }),
      ],
    })
    const blankTextConvNodes: ConversationNodeLike[] = [
      { kind: 'assistant', seq: 2, blocks: [
        { kind: 'text', text: '\n\n' },
        { kind: 'tool-call', name: 'bash', argsRaw: '{}' },
      ] },
      { kind: 'assistant', seq: 3, blocks: [{ kind: 'text', text: 'real reply' }] },
    ]
    const m = await mount(h(Browser, props({ data, convNodes: blankTextConvNodes })))
    await click(catRow(m, 'assistant'))
    const chips = () => queryAll<HTMLButtonElement>(m.container, '.lc-br-toolctl .lc-gran-btn')
    assert.deepEqual(chips().map(c => text(c)), ['Thinking0', 'Tools1', 'Answer1'])
    await click(chips()[2])
    assert.deepEqual(elemRows(m).map(r => text(query(r, '.lc-br-preview'))), ['real reply'])
    await m.unmount()
  })

  test('call-name capsules and heads are inert: a click never reveals the schema row', async () => {
    const headers: ContextHeaders = { headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [{ name: 'bash', tokens: 5 }, { name: 'write', tokens: 3 }] }] }
    const m = await mountBrowser({ headers })
    await click(catRow(m, 'assistant'))
    const crumbRow = elemRows(m).find(r => text(r).includes('done all')) as HTMLElement
    await click(query(crumbRow, '.lc-br-tag'))
    assert.ok(!text(query(m.container, '.lc-br-cat-open')).includes('Tool Schemas'), 'no category jump')
    const open = queryAll(m.container, '.lc-br-elem-on')
    assert.equal(open.length, 1)
    assert.ok(text(open[0]).includes('done all'), 'the row toggle fired')
    const cascade = elemRows(m).find(r => text(r).includes('full cascade')) as HTMLElement
    await click(cascade)
    const head = queryAll(m.container, '.lc-ts-card-head b').find(el => text(el) === '→ bash') as HTMLElement
    await click(head)
    assert.ok(!text(query(m.container, '.lc-br-cat-open')).includes('Tool Schemas'), 'no category jump')
    const on = queryAll(m.container, '.lc-br-elem-on')
    assert.equal(on.length, 1)
    assert.ok(text(on[0]).includes('full cascade'), 'the open row never moved')
    await m.unmount()
  })

  test('assistant rows: preview cascade and the full block vocabulary', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'assistant'))
    const rows = elemRows(m)
    const rowOf = (preview: string) => rows.find(r => text(r).includes(preview)) as HTMLElement
    const capsOf = (row: HTMLElement) => queryAll(row, '.lc-br-tag').map(c => text(c))
    assert.deepEqual(capsOf(rowOf('done all')), ['bash', 'write'], 'call breadcrumb: one capsule per distinct call')
    assert.ok(capsOf(rowOf('a.ts')).includes('write'), 'block summary previews a textless turn')
    const tags = rows.map(r => {
      const caps = capsOf(r)
      const preview = text(query(r, '.lc-br-preview'))
      return `${caps.length === 0 ? '∅' : caps.join(',')}$|${preview}`
    })
    assert.ok(tags.includes('read$|(empty reply)'), 'no self-summarizing call → empty marker')
    assert.ok(tags.includes('edit$|b.ts'), 'a textless turn tags the joined call name and previews its summary')
    assert.ok(tags.includes('bash,broken,noargs$|full cascade'), 'a mixed reply tags one capsule per join-recovered call, in order')
    assert.ok(tags.includes('∅$|(empty reply)'), 'no join, no calls → empty marker')
    assert.ok(tags.includes('∅$|Calls '), 'empty call list previews as a bare Calls label (nodeText)')

    await click(rowOf('full cascade'))
    const content = query(m.container, '.lc-br-content')
    const heads = queryAll(content, '.lc-ts-card-head').map(el => text(el))
    assert.ok(heads.some(s => s.includes('Answer')))
    assert.ok(heads.some(s => s.includes('Reasoning')))
    assert.ok(heads.some(s => s.includes('→ bash')))
    assert.ok(heads.some(s => s.includes('→ broken')))
    assert.ok(heads.some(s => s.includes('→ ?')), 'nameless call card')
    assert.ok(heads.some(s => s.includes('→ noargs')))
    assert.ok(heads.some(s => s.includes('Result')), 'nested tool-result text section')
    assert.ok(heads.filter(s => s.includes('Other content')).length === 6, 'unknown blocks render raw JSON')
    assert.ok(heads.some(s => s.includes('Attachments')))
    const argVals = queryAll(content, '.lc-ts-arg-row').map(el => text(el))
    assert.ok(argVals.some(s => s.includes('command') && s.includes('ls')))
    assert.ok(argVals.some(s => s.includes('timeout') && s.includes('30')))
    assert.ok(argVals.some(s => s.includes('opts') && s.includes('{"a":1}')))
    assert.ok(text(content).includes('not json'))
    assert.ok(text(content).includes('inner result'))
    await flush()
    assert.equal(queryAll(content, '.lc-att-err').length, 1)
    assert.equal(queryAll(content, '.lc-att-thumb img').length, 1)

    await click(elemRows(m).find(r => text(r).includes('legacy')) as HTMLElement)
    assert.ok(text(query(m.container, '.lc-br-content')).includes('legacy body'), 'a legacy content array renders the generic section')
    await click(elemRows(m).find(r => text(r).includes('legacy')) as HTMLElement)
    await click(elemRows(m).find(r => text(r).includes('(empty reply)') && !text(r).includes('read')) as HTMLElement)
    assert.ok(text(query(m.container, '.lc-br-content')).includes('outside the loaded message window'), 'no join → only the window note')
    await m.unmount()

    const headers: ContextHeaders = { headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [{ name: 'bash', tokens: 5 }, { name: 'write', tokens: 3 }] }] }
    const repeated = tl({
      current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 8, tool: 0, total: 8 },
      nodes: [surfaceNode({ seq: 2, cat: 'assistant', tokens: 8, calls: ['bash', 'write', 'bash', 'bash'] })],
    })
    const folded = await mount(h(Browser, props({ data: repeated, headers })))
    await click(catRow(folded, 'assistant'))
    assert.deepEqual(queryAll(elemRows(folded)[0], '.lc-br-tag').map(c => text(c)), ['bash ×3', 'write'])
    await folded.unmount()
  })

  test('compaction nodes: summary text, null and empty summaries', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'user'))
    const rows = elemRows(m)
    await click(rows[2])
    let content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('Summary'))
    assert.ok(text(content).includes('SUMMARY BODY'))
    await click(rows[1])
    content = query(m.container, '.lc-br-content')
    assert.equal(text(content), '')
    await click(rows[0])
    content = query(m.container, '.lc-br-content')
    assert.equal(text(content), '')
    await m.unmount()
  })

  test('inject rows: form tags, snapshot prefix, skill injects', async () => {
    const m = await mountBrowser()
    await click(catRow(m, 'inject'))
    const rows = elemRows(m)
    const tags = rows.map(r => {
      const tag = r.querySelector<HTMLElement>('.lc-br-tag')
      return `${tag === null ? '∅' : text(tag)}|${text(query(r, '.lc-br-preview'))}`
    })
    assert.ok(tags.includes('State Snapshot|Snapshot: state'))
    assert.ok(tags.includes('Notice|heads up'))
    assert.ok(tags.includes('Notice|Notice'), 'empty-string text keeps the form label')
    assert.ok(tags.includes('Context Injection|no form'), 'formless inject defaults to the context label')
    assert.ok(tags.includes('Agent Relay|relay body'))
    await click(rows.find(r => text(r).includes('relay body')) as HTMLElement)
    const content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('relay body full'))
    await m.unmount()
  })

  test('inject rows label the fold-stamped source identity; the folded text stays filterable', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 0, inject: 45, skill: 0, assistant: 0, tool: 0, total: 45 },
      nodes: [
        surfaceNode({ seq: 50, cat: 'inject', tokens: 9, form: 'snapshot', name: '@deepseek-ai/dsh-system-prompt', text: 'policy sections' }),
        surfaceNode({ seq: 51, cat: 'inject', tokens: 9, form: 'instructions', name: 'AGENTS.md', text: '<system-reminder> instructions' }),
        surfaceNode({ seq: 52, cat: 'inject', tokens: 9, form: 'snapshot', text: 'state' }),
        surfaceNode({ seq: 53, cat: 'inject', tokens: 9, name: 42 as never, text: 'drift body' }),
        surfaceNode({ seq: 54, cat: 'inject', tokens: 9, name: '', text: 'empty body' }),
      ],
    })
    const m = await mount(h(Browser, props({ data })))
    await click(catRow(m, 'inject'))
    const tags = elemRows(m).map(r => {
      const tag = r.querySelector<HTMLElement>('.lc-br-tag')
      return `${tag === null ? '∅' : text(tag)}|${text(query(r, '.lc-br-preview'))}`
    })
    assert.ok(tags.includes('State Snapshot|@deepseek-ai/dsh-system-prompt'))
    assert.ok(tags.includes('Instructions|AGENTS.md'))
    assert.ok(tags.includes('State Snapshot|Snapshot: state'))
    assert.ok(tags.includes('Context Injection|drift body'))
    assert.ok(tags.includes('Context Injection|empty body'))
    await typeToolSearch(m, 'policy sections')
    assert.deepEqual(elemRows(m).map(r => text(query(r, '.lc-br-preview'))), ['@deepseek-ai/dsh-system-prompt'])
    await typeToolSearch(m, 'AGENTS.md')
    assert.equal(elemRows(m).length, 1)
    await m.unmount()
  })

  test('inject rows append the subagent name carried by the node', async () => {
    const data = tl({
      current: { system: 0, tools: 0, user: 0, inject: 45, skill: 0, assistant: 0, tool: 0, total: 45 },
      nodes: [
        surfaceNode({ seq: 50, cat: 'inject', tokens: 9, form: 'notice', name: 'subagent-settled' }),
        surfaceNode({ seq: 51, cat: 'inject', tokens: 9, form: 'notice', name: 'subagent-settled', text: 'settled body', agent: 'explorer-1' }),
        surfaceNode({ seq: 52, cat: 'inject', tokens: 9, form: 'notice', text: 'plain notice' }),
        surfaceNode({ seq: 53, cat: 'inject', tokens: 9, form: 'relay', name: 'agent-message' }),
        surfaceNode({ seq: 54, cat: 'inject', tokens: 9, form: 'relay', text: 'relay body', agent: 'planner-2' }),
        surfaceNode({ seq: 55, cat: 'inject', tokens: 9, form: 'notice', agent: 'solo-3' }),
      ],
    })
    const m = await mount(h(Browser, props({ data })))
    await click(catRow(m, 'inject'))
    const previews = elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    assert.ok(previews.includes('subagent-settled · explorer-1'), 'name + agent')
    assert.ok(previews.includes('relay body · planner-2'), 'text fallback + agent')
    assert.ok(previews.includes('Notice · solo-3'), 'form-label fallback + agent')
    assert.ok(previews.includes('subagent-settled'), 'no agent → name stays bare')
    assert.ok(previews.includes('plain notice'), 'no agent → text stays bare')
    await typeToolSearch(m, 'explorer-1')
    assert.deepEqual(elemRows(m).map(r => text(query(r, '.lc-br-preview'))), ['subagent-settled · explorer-1'])
    await m.unmount()
  })

  test('skill rows: loads/invocations name themselves, the catalog tags its form', async () => {
    const convNodes: ConversationNodeLike[] = [
      { kind: 'tool-result', seq: 72, call: { name: 'skill', argsRaw: '{"description":"grill the plan"}' }, content: [{ type: 'text', text: 'skill body' }] },
    ]
    const data = tl({
      current: { system: 0, tools: 0, user: 0, inject: 0, skill: 40, assistant: 0, tool: 0, total: 40 },
      nodes: [
        surfaceNode({ seq: 70, cat: 'skill', tokens: 9, skill: 'code-review', text: 'skill body' }),
        surfaceNode({ seq: 71, cat: 'skill', tokens: 9, form: 'catalog' }),
        surfaceNode({ seq: 72, cat: 'skill', tokens: 9, tool: 'skill', skill: 'grilling' }),
        surfaceNode({ seq: 73, cat: 'skill', tokens: 4 }),
        surfaceNode({ seq: 74, cat: 'skill', tokens: 9, form: 'catalog', name: 'skill-catalog', text: 'digest body' }),
      ],
    })
    const m = await mount(h(Browser, props({ data, convNodes })))
    assert.ok(text(catRow(m, 'skill')).includes('Skill Injections'))
    assert.ok(text(catRow(m, 'skill')).includes('5 Items'))
    await click(catRow(m, 'skill'))
    const rows = elemRows(m)
    assert.equal(rows.length, 5)
    const tags = rows.map(r => {
      const tag = r.querySelector<HTMLElement>('.lc-br-tag')
      return `${tag === null ? '∅' : text(tag)}|${text(query(r, '.lc-br-preview'))}`
    })
    assert.ok(tags.includes('Skill · code-review|skill body'), 'the invocation names itself and previews its text')
    assert.ok(tags.includes('Catalog Update|Catalog Update'), 'the textless catalog digest tags its form')
    assert.ok(tags.includes('Skill · grilling|grill the plan'), 'the load previews its call summary')
    assert.ok(tags.includes('Context Injection|Context Injection'), 'a nameless, formless skill row degrades to the context label')
    assert.ok(tags.includes('Catalog Update|skill-catalog'), 'a stamped catalog digest previews its source identity')
    await m.unmount()
  })
})
})

describe('browserToolSchemas', () => {

describe('ContextBrowser tool schemas', () => {
  const headers: ContextHeaders = {
    headers: [{
      seq: 1, time: 1, systemTokens: 3,
      tools: [
        { name: 'omega', tokens: 5, plugin: 'mcp:github' },
        { name: 'rho', tokens: 6 },
        { name: 'theta', tokens: 8 },
        { name: 'zeta', tokens: 10 },
        { name: 'epsilon', tokens: 20 },
        { name: 'delta', tokens: 30 },
        { name: 'gamma', tokens: 40 },
        { name: 'beta', tokens: 50 },
        { name: 'mega', tokens: 100 },
      ],
    }],
  }
  const content: HeaderEpochContent = {
    system: 'SYS',
    tools: [
      { name: 'omega', schema: {} },
      { name: 'rho', schema: 'nope' },
      { name: 'theta', schema: { type: 'object', properties: null } },
      { name: 'zeta', schema: { type: 'object' } },
      { name: 'epsilon', schema: { type: 'object', properties: { z: { type: 'integer' } } } },
      { name: 'delta', schema: { parameters: 'junk', input_schema: { properties: { y: { type: 'integer' } } } } },
      { name: 'gamma', schema: { inputSchema: { properties: 'nope' } } },
      { name: 'beta', schema: { input_schema: { properties: { x: { type: 'string' } } } } },
      {
        name: 'mega', description: 'does everything',
        schema: { name: 'mega', parameters: {
          type: 'object',
          properties: {
            a: { type: 'string', description: 'the a param' },
            b: { type: 'object', properties: { x: {}, y: {} } },
            c: { type: 'array', items: { type: 'number' } },
            d: { type: 'array' },
            d2: { type: 'array', items: null },
            e: { type: 'string', enum: ['x', 'y'] },
            e2: { type: 'string', enum: [] },
            f: { enum: [1, 2] },
            g: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            h: { oneOf: [{ type: 'boolean' }] },
            i: { anyOf: [null, { type: 'string' }] },
            j: { anyOf: [] },
            k: { anyOf: [42, null] },
            l: { type: 'object', properties: {} },
            m: { type: 'object', properties: null },
            n: { type: 'object', properties: 42 },
            o: 'not-an-object',
            p: { description: 42 },
            q: { description: '' },
          },
          required: ['a', 42],
        } },
      },
    ],
  }
  const data = tl({ current: { system: 10, tools: 248, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 258 } })
  const lazyProps = () => props({ data, headers, fetchHeader: () => Promise.resolve(content) })

  test('rows rank by token price; the schema narrowing matrix renders', async () => {
    settings.set('defaultToolSort', 'size')
    const m = await mount(h(Browser, lazyProps()))
    await click(catRow(m, 'tools'))
    await flush()
    const rows = elemRows(m)
    assert.deepEqual(rows.map(r => text(query(r, '.lc-br-preview'))),
      ['mega', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta', 'rho', 'omega'])

    await click(rows[0])
    const body = query(m.container, '.lc-br-content')
    assert.ok(text(body).includes('does everything'), 'description section renders')
    const paramRows = queryAll(body, '.lc-ts-param-row')
    assert.equal(paramRows.length, 18, 'one row per object-valued property')
    const byName = (n: string) => paramRows.find(r => text(query(r, '.lc-ts-param-name')) === n)
    const typeOf = (n: string) => text(query(byName(n) as HTMLElement, '.lc-ts-param-type'))
    assert.equal(typeOf('a'), 'string')
    assert.equal(typeOf('b'), 'object{2}')
    assert.equal(typeOf('c'), 'array<number>')
    assert.equal(typeOf('d'), 'array')
    assert.equal(typeOf('d2'), 'array')
    assert.equal(typeOf('e'), 'string (enum)')
    assert.equal(typeOf('e2'), 'string')
    assert.equal(typeOf('f'), '(enum)')
    assert.equal(typeOf('g'), 'string | number')
    assert.equal(typeOf('h'), 'boolean')
    assert.equal(typeOf('i'), 'string')
    assert.equal(typeOf('j'), 'unknown')
    assert.equal(typeOf('k'), 'unknown')
    assert.equal(typeOf('l'), 'object')
    assert.equal(typeOf('m'), 'object')
    assert.equal(typeOf('n'), 'object')
    assert.equal(typeOf('p'), 'unknown')
    assert.equal(text(query(byName('a') as HTMLElement, '.lc-ts-param-req')), '✓')
    assert.equal(text(query(byName('b') as HTMLElement, '.lc-ts-param-req-off')), '·')
    assert.ok(text(byName('a') as HTMLElement).includes('the a param'))
    assert.equal(queryAll(byName('p') as HTMLElement, '.lc-ts-param-desc').length, 0, 'non-string description hidden')
    assert.equal(queryAll(byName('q') as HTMLElement, '.lc-ts-param-desc').length, 0, 'empty description hidden')

    const toggle = query(body, '.lc-ts-json-toggle')
    assert.ok(text(toggle).includes('View Raw JSON'))
    await click(toggle)
    assert.ok(text(query(body, '.lc-ts-desc-body')).includes('"parameters"'))
    assert.ok(text(query(body, '.lc-ts-json-toggle')).includes('Collapse'))
    await click(query(body, '.lc-ts-json-toggle'))
    assert.equal(queryAll(body, 'pre').length, 0)
    await click(elemRows(m)[0])
    assert.equal(queryAll(m.container, '.lc-br-content').length, 0)

    const open = async (name: string) => {
      const row = rows.find(r => text(query(r, '.lc-br-preview')) === name) as HTMLElement
      await click(row)
      return query(m.container, '.lc-br-content')
    }
    const close = async (name: string) => {
      await click(rows.find(r => text(query(r, '.lc-br-preview')) === name) as HTMLElement)
    }
    let nested = await open('beta')
    assert.equal(queryAll(nested, '.lc-ts-param-row').length, 1)
    assert.ok(!text(nested).includes('Description'), 'no description section without one')
    await close('beta')
    nested = await open('gamma')
    assert.ok(text(nested).includes('(no parameters)'))
    await close('gamma')
    nested = await open('delta')
    assert.equal(queryAll(nested, '.lc-ts-param-row').length, 1)
    await close('delta')
    nested = await open('epsilon')
    assert.equal(queryAll(nested, '.lc-ts-param-row').length, 1)
    assert.ok(text(nested).includes('integer'))
    await close('epsilon')
    nested = await open('zeta')
    assert.equal(queryAll(nested, '.lc-ts-param-row').length, 0)
    assert.ok(!text(nested).includes('(no parameters)'))
    assert.ok(queryAll(nested, '.lc-ts-json-toggle').length === 1, 'raw JSON still available')
    await close('zeta')
    nested = await open('theta')
    assert.ok(text(nested).includes('(no parameters)'))
    await close('theta')
    nested = await open('rho')
    assert.equal(queryAll(nested, '.lc-ts-param-row').length, 0)
    await click(query(nested, '.lc-ts-json-toggle'))
    assert.ok(text(query(nested, 'pre')).includes('"nope"'))
    await close('rho')
    nested = await open('omega')
    assert.equal(queryAll(nested, '.lc-ts-param-row').length, 0)
    assert.ok(!text(nested).includes('does everything'))
    assert.ok(queryAll(nested, '.lc-ts-json-toggle').length === 1)
    await m.unmount()
    settings.set('defaultToolSort', 'count')
  })

  test('a text filter and the size/name sort narrow and re-rank the rows', async () => {
    settings.set('defaultToolSort', 'size')
    const m = await mount(h(Browser, lazyProps()))
    await click(catRow(m, 'tools'))
    await flush()
    const input = query<HTMLInputElement>(m.container, '.lc-br-tool-search')
    assert.equal(input.placeholder, 'Filter by name, description, or parameters…')
    const sortBtns = queryAll(m.container, '.lc-br-toolctl .lc-gran-btn')
    assert.equal(sortBtns.length, 3)
    assert.ok(sortBtns[0].className.includes('lc-gran-on'), 'size is the default sort')
    const names = () => elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    assert.equal(filterStat(m), '×9 ≈248')

    await typeToolSearch(m, 'gamma')
    assert.deepEqual(names(), ['gamma'])
    assert.equal(filterStat(m), '×1 ≈37')
    await typeToolSearch(m, 'everything')
    assert.deepEqual(names(), ['mega'])
    assert.equal(filterStat(m), '×1 ≈92')
    await typeToolSearch(m, 'the a param')
    assert.deepEqual(names(), ['mega'])
    await typeToolSearch(m, 'github')
    assert.deepEqual(names(), ['omega'])
    assert.equal(filterStat(m), '×1 ≈5')
    await typeToolSearch(m, 'properties')
    assert.equal(elemRows(m).length, 6)
    assert.equal(filterStat(m), '×6 ≈229')
    await typeToolSearch(m, ':')
    assert.deepEqual(names(), ['mega', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta', 'omega'])
    assert.equal(filterStat(m), '×8 ≈242', 'a larger subset reports a larger share of the block total')
    await typeToolSearch(m, 'e')
    assert.equal(elemRows(m).length, 9)
    assert.equal(filterStat(m), '×9 ≈248', 'a query that keeps the whole set still mirrors the block total')
    await typeToolSearch(m, 'zzz')
    assert.equal(elemRows(m).length, 0)
    assert.equal(filterStat(m), '×0 ≈0')
    assert.ok(text(m.container).includes('No tools match the current filter'))
    await typeToolSearch(m, '')
    assert.equal(elemRows(m).length, 9)
    assert.equal(filterStat(m), '×9 ≈248')

    await click(sortBtns[2])
    assert.ok(sortBtns[2].className.includes('lc-gran-on'))
    assert.deepEqual(names(), ['beta', 'delta', 'epsilon', 'gamma', 'mega', 'omega', 'rho', 'theta', 'zeta'])
    await click(sortBtns[1])
    assert.ok(sortBtns[1].className.includes('lc-gran-on'))
    assert.deepEqual(names(), ['beta', 'delta', 'epsilon', 'gamma', 'mega', 'omega', 'rho', 'theta', 'zeta'])
    await click(sortBtns[0])
    assert.deepEqual(names(), ['mega', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta', 'rho', 'omega'])
    await m.unmount()
    settings.set('defaultToolSort', 'count')
  })

  test('count sort ranks by call hits on the shown surface; collapsed rows carry the tally', async () => {
    settings.set('defaultToolSort', 'size')
    const hitHeaders: ContextHeaders = { headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [
      { name: 'alpha', tokens: 100 },
      { name: 'beta', tokens: 10 },
      { name: 'gamma', tokens: 30 },
      { name: 'delta', tokens: 20 },
    ] }] }
    const data = tl({
      current: { system: 10, tools: 160, user: 0, inject: 0, skill: 0, assistant: 10, tool: 80, total: 260 },
      requests: [req({ seq: 4, turn: 1, step: 0 })],
      nodes: [
        surfaceNode({ seq: 2, cat: 'assistant', tokens: 10 }),
        surfaceNode({ seq: 3, cat: 'tool', tool: 'beta', tokens: 20 }),
        surfaceNode({ seq: 5, cat: 'tool', tool: 'beta', tokens: 20 }),
        surfaceNode({ seq: 6, cat: 'tool', tool: 'gamma', tokens: 20 }),
        surfaceNode({ seq: 7, cat: 'tool', tool: 'delta', tokens: 20 }),
        surfaceNode({ seq: 8, cat: 'tool', tokens: 20 }),
      ],
    })
    const m = await mount(h(Browser, props({ data, headers: hitHeaders, fetchHeader: () => Promise.resolve({ tools: [] }) })))
    await click(catRow(m, 'tools'))
    await flush()
    const names = () => elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    const hits = () => elemRows(m).map(r => text(query(r, '.lc-br-hits')))
    assert.deepEqual(names(), ['alpha', 'gamma', 'delta', 'beta'])
    assert.deepEqual(hits(), ['×0', '×1', '×1', '×2'])
    assert.equal(query(m.container, '.lc-br-hits').title, 'Times this tool was called and answered within the shown step’s context')
    const sortBtns = queryAll(m.container, '.lc-br-toolctl .lc-gran-btn')
    await click(sortBtns[1])
    assert.deepEqual(names(), ['beta', 'delta', 'gamma', 'alpha'])
    assert.deepEqual(hits(), ['×2', '×1', '×1', '×0'])
    await pickStep(m, '4')
    await click(catRow(m, 'tools'))
    await flush()
    assert.deepEqual(names(), ['beta', 'alpha', 'delta', 'gamma'])
    assert.deepEqual(hits(), ['×1', '×0', '×0', '×0'])
    await m.unmount()
    settings.set('defaultToolSort', 'count')
  })

  test('the mount-time default tool sort comes from the plugin settings', async () => {
    const pair: ContextHeaders = { headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [
      { name: 'zzz', tokens: 1 },
      { name: 'aaa', tokens: 100 },
    ] }] }
    const data = tl({
      current: { system: 10, tools: 101, user: 0, inject: 0, skill: 0, assistant: 0, tool: 10, total: 121 },
      nodes: [surfaceNode({ seq: 2, cat: 'tool', tool: 'zzz', tokens: 10 })],
    })
    const names = (m: Mounted) => elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    const sortBtns = (container: ParentNode) => queryAll(container, '.lc-br-toolctl .lc-gran-btn')
    const mountWith = async (sort: string) => {
      settings.set('defaultToolSort', sort)
      const m = await mount(h(Browser, props({ data, headers: pair, fetchHeader: () => Promise.resolve({ tools: [] }) })))
      await click(catRow(m, 'tools'))
      return m
    }

    for (const [sort, idx, order] of [
      ['count', 1, ['zzz', 'aaa']],
      ['size', 0, ['aaa', 'zzz']],
      ['name', 2, ['aaa', 'zzz']],
    ] as const) {
      const m = await mountWith(sort)
      assert.ok(sortBtns(m.container)[idx].className.includes('lc-gran-on'))
      assert.deepEqual(names(m), order)
      await m.unmount()
    }

    const m = await mountWith('count')
    await click(sortBtns(m.container)[0])
    assert.equal(settings.store.getSnapshot().toolSort, 'count')
    await m.unmount()
    settings.set('defaultToolSort', 'count')
  })

  test('before the epoch content loads, the filter scans names and plugins only', async () => {
    const m = await mount(h(Browser, props({ data, headers, fetchHeader: () => new Promise(() => {}) })))
    await click(catRow(m, 'tools'))
    const names = () => elemRows(m).map(r => text(query(r, '.lc-br-preview')))
    await typeToolSearch(m, 'github')
    assert.deepEqual(names(), ['omega'])
    await typeToolSearch(m, 'everything')
    assert.equal(names().length, 0)
    assert.ok(text(m.container).includes('No tools match the current filter'))
    await m.unmount()

    const cyclic: Record<string, unknown> = { type: 'object' }
    cyclic['self'] = cyclic
    const hostile: ContextHeaders = { headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [
      { name: 'loop', tokens: 3 }, { name: 'nully', tokens: 1 }, { name: 'plain', tokens: 2 },
    ] }] }
    const hostileContent: HeaderEpochContent = { system: 'SYS', tools: [
      { name: 'loop', schema: cyclic }, { name: 'nully', schema: null }, { name: 'plain', schema: {} },
    ] }
    const hostileMount = await mount(h(Browser, props({ data, headers: hostile, fetchHeader: () => Promise.resolve(hostileContent) })))
    await click(catRow(hostileMount, 'tools'))
    await flush()
    assert.equal(elemRows(hostileMount).length, 3)
    await typeToolSearch(hostileMount, 'loop')
    assert.deepEqual(elemRows(hostileMount).map(r => text(query(r, '.lc-br-preview'))), ['loop'])
    await typeToolSearch(hostileMount, 'properties')
    assert.equal(elemRows(hostileMount).length, 0)
    assert.ok(text(hostileMount.container).includes('No tools match the current filter'))
    await hostileMount.unmount()

    const partial: HeaderEpochContent = { system: 'SYS', tools: [{ name: 'other', schema: {} }] }
    const missing = await mount(h(Browser, props({ data, headers, fetchHeader: () => Promise.resolve(partial) })))
    await click(catRow(missing, 'tools'))
    await flush()
    await click(elemRows(missing).find(r => text(query(r, '.lc-br-preview')) === 'mega') as HTMLElement)
    assert.ok(text(query(missing.container, '.lc-br-content')).includes('not in the session log'))
    await missing.unmount()
  })

  test('tool rows tag the registering plugin when attribution exists', async () => {
    settings.set('defaultToolSort', 'size')
    const attributed: ContextHeaders = {
      headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [
        { name: 'write', tokens: 5, plugin: '@deepseek-ai/dsh-tool-fs' },
        { name: 'mcp__github__get_issue', tokens: 3, plugin: 'mcp:github' },
        { name: 'agent_teams_add_member', tokens: 2 },
        { name: 'claim_files', tokens: 2, plugin: UNKNOWN_TOOL_SOURCE },
      ] }],
    }
    const data = tl({ current: { system: 0, tools: 10, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 } })
    const m = await mount(h(Browser, props({ data, headers: attributed })))
    await click(catRow(m, 'tools'))
    const rows = elemRows(m)
    assert.equal(rows.length, 4)
    const chips = queryAll(m.container, '.lc-br-tool-plugin')
    assert.equal(chips.length, 3, 'only attributed tools chip')
    assert.ok(text(chips[0]).includes('@deepseek-ai/dsh-tool-fs'))
    assert.ok(text(chips[1]).includes('mcp:github'))
    assert.ok((chips[0] as HTMLElement).title.includes('The registering plugin of this tool'), 'the chip carries the i18n tooltip')
    assert.ok(!text(rows[2]).includes('@'), 'unattributed tools stay untagged')
    assert.equal(chips[2].textContent, 'Unknown plugin')
    assert.ok((chips[2] as HTMLElement).title.includes('registered before the context plugin loaded'), 'unknown chips explain the boot gap')
    assert.equal(text(query(rows[0], '.lc-br-preview')), 'write', 'tool name leads')
    const chip = chips[0] as HTMLElement
    assert.equal(chip.previousElementSibling, query(rows[0], '.lc-br-preview'), 'plugin chip sits right after the tool name')
    assert.ok(chip.parentElement!.classList.contains('lc-br-elem-row'), 'plugin chip is a single frame, a direct row child')
    assert.equal(queryAll(chip, '.lc-br-tag').length, 0, 'no nested tag wrapper')
    await m.unmount()
    settings.set('defaultToolSort', 'count')
  })

  test('a single-tool category opens its schema row with the category; multi stays collapsed', async () => {
    const lone: ContextHeaders = {
      headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [
        { name: 'only', tokens: 5 },
      ] }],
    }
    const loneContent: HeaderEpochContent = {
      system: 'SYS',
      tools: [{ name: 'only', schema: { type: 'object', properties: { x: { type: 'string' } } } }],
    }
    const data = tl({ current: { system: 10, tools: 5, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 15 } })
    const m = await mount(h(Browser, props({ data, headers: lone, fetchHeader: () => Promise.resolve(loneContent) })))
    await click(catRow(m, 'tools'))
    await flush()
    assert.equal(elemRows(m).length, 1)
    const content = queryAll(m.container, '.lc-br-content')
    assert.equal(content.length, 1, 'the lone tool schema is already expanded')
    assert.equal(queryAll(content[0], '.lc-ts-param-row').length, 1, 'the schema body renders directly')
    await click(catRow(m, 'tools'))
    assert.equal(queryAll(m.container, '.lc-br-content').length, 0, 'toggling shut closes the row too')
    await m.unmount()

    const pair: ContextHeaders = {
      headers: [{ seq: 1, time: 1, systemTokens: 3, tools: [{ name: 'a', tokens: 2 }, { name: 'b', tokens: 1 }] }],
    }
    const m2 = await mount(h(Browser, props({ data, headers: pair })))
    await click(catRow(m2, 'tools'))
    assert.equal(elemRows(m2).length, 2)
    assert.equal(queryAll(m2.container, '.lc-br-content').length, 0, 'multi-tool categories open collapsed')
    await m2.unmount()
  })
})
})
