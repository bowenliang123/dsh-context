import { createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { type ContextBrowserProps } from '../../../src/client/components/browser'
import { type ContextHeaders } from '../../../src/shared/types'
import { click, focus, hover, mount, pinRect, query, queryAll, surfaceNode, text, tipRows, unhover, type Mounted, flush, makeKit } from '../helpers/kit'
import { restoreLayout, stubListRect } from '../helpers/layout'
import { Browser, catRow, elemRows, props, tl } from './browserHarness'
import { makeAttachmentSection } from '../../../src/client/components/attachments'
import { type AttachmentOpener, type ImageLoader } from '../../../src/client/services'
import { type AttachmentRef } from '../../../src/shared/attachment'

describe('browserTreemap', () => {

const mapHeaders: ContextHeaders = {
  headers: [{ seq: 1, time: 1000, systemTokens: 100, tools: [{ name: 'bash', tokens: 50 }, { name: 'write', tokens: 25 }] }],
}

function mapData(): ReturnType<typeof tl> {
  return tl({
    current: { system: 100, tools: 75, user: 20, inject: 10, skill: 0, assistant: 40, tool: 300, total: 545 },
    nodes: [
      surfaceNode({ seq: 2, tokens: 20, time: 2000, text: 'hi' }),
      surfaceNode({ seq: 3, cat: 'tool', tokens: 180, tool: 'bash' }),
      surfaceNode({ seq: 4, cat: 'tool', tokens: 120, tool: 'bash' }),
      surfaceNode({ seq: 5, cat: 'assistant', tokens: 40, text: 'ok' }),
      surfaceNode({ seq: 6, cat: 'inject', tokens: 10, form: 'notice' }),
    ],
  })
}

function mapBtn(m: Mounted): HTMLElement {
  return query(m.container, '.lc-br-map-btn')
}

function regions(m: Mounted): HTMLElement[] {
  return queryAll(m.container, '.lc-map-cat')
}

function blocks(m: Mounted): HTMLElement[] {
  return queryAll(m.container, '.lc-map-block')
}

function blockByText(m: Mounted, txt: string): HTMLElement {
  const found = blocks(m).find(b => text(b).includes(txt))
  assert.ok(found !== undefined, `a block carrying "${txt}"`)
  return found
}

function regionByHead(m: Mounted, label: string): HTMLElement {
  const found = regions(m).find(r => queryAll(r, '.lc-map-cat-label').some(l => l.textContent === label))
  assert.ok(found !== undefined, `a region headed "${label}"`)
  return found
}

describe('ContextBrowser block map', () => {
  test('the bar-right toggle opens the treemap below the bar and closes it again', async () => {
    const m = await mount(h(Browser, props({ data: mapData(), headers: mapHeaders })))
    assert.equal(queryAll(m.container, '.lc-map').length, 0)
    const btn = mapBtn(m)
    assert.equal(btn.getAttribute('aria-label'), 'Toggle the block map')
    assert.equal(btn.getAttribute('aria-pressed'), 'false')
    assert.ok(btn.querySelector('svg') !== null)

    await click(btn)
    assert.equal(btn.getAttribute('aria-pressed'), 'true')
    assert.ok(btn.className.includes('lc-br-map-btn-on'))
    assert.ok(query(m.container, '.lc-map') !== null)
    assert.deepEqual(regions(m).map(r => queryAll(r, '.lc-map-cat-label')[0]?.textContent ?? '(no head)'), [
      'Tool Results', 'System Prompt', 'Tool Schemas', 'Assistant Messages', 'User Messages', '(no head)',
    ])

    await click(btn)
    assert.equal(queryAll(m.container, '.lc-map').length, 0)
    assert.equal(btn.getAttribute('aria-pressed'), 'false')
    await m.unmount()
  })

  test('grouped blocks carry a ×N fold and a figure, tiny blocks render bare, and a click opens the group', async () => {
    const m = await mount(h(Browser, props({ data: mapData(), headers: mapHeaders })))
    await click(mapBtn(m))
    const bash = blockByText(m, 'bash')
    assert.equal(query(bash, '.lc-map-label').textContent, 'bash×2')
    assert.equal(query(bash, '.lc-map-num').textContent, '≈300')
    const notice = blockByText(m, 'Notice')
    assert.equal(queryAll(notice, '.lc-map-num').length, 0)
    assert.equal(text(blockByText(m, 'System Prompt')).includes('≈100'), true)

    await click(bash)
    assert.ok(catRow(m, 'tool').className.includes('lc-br-cat-open'))
    assert.equal(query<HTMLInputElement>(m.container, '.lc-br-tool-search').value, 'bash')
    assert.equal(elemRows(m).length, 2)
    assert.ok(regionByHead(m, 'Tool Results').className.includes('lc-map-cat-open'))
    await m.unmount()
  })

  test('clicking a singleton block opens its exact row', async () => {
    const m = await mount(h(Browser, props({ data: mapData(), headers: mapHeaders })))
    await click(mapBtn(m))
    await click(blockByText(m, '#2'))
    assert.ok(catRow(m, 'user').className.includes('lc-br-cat-open'))
    const on = queryAll(m.container, '.lc-br-elem-on')
    assert.equal(on.length, 1)
    assert.ok(text(on[0]).includes('hi'))
    await m.unmount()
  })

  test('clicking a region header toggles the category like its row does', async () => {
    const m = await mount(h(Browser, props({ data: mapData(), headers: mapHeaders })))
    await click(mapBtn(m))
    const head = query(regionByHead(m, 'System Prompt'), '.lc-map-cat-head')
    await click(head)
    assert.ok(catRow(m, 'system').className.includes('lc-br-cat-open'))
    assert.equal(queryAll(m.container, '.lc-br-body').length, 1)
    await click(head)
    assert.ok(!catRow(m, 'system').className.includes('lc-br-cat-open'))
    await m.unmount()

    const moreData = tl({
      current: { system: 0, tools: 0, user: 1183, inject: 0, skill: 0, assistant: 0, tool: 0, total: 1183 },
      nodes: Array.from({ length: 13 }, (_, i) => surfaceNode({ seq: i + 1, tokens: 100 - i, text: `m${i}` })),
    })
    const more = await mount(h(Browser, props({ data: moreData, headers: null })))
    await click(mapBtn(more))
    await click(blockByText(more, '2 more'))
    assert.ok(catRow(more, 'user').className.includes('lc-br-cat-open'))
    assert.equal(query<HTMLInputElement>(more.container, '.lc-br-tool-search').value, '')
    assert.equal(elemRows(more).length, 13)
    await more.unmount()
  })

  test('hover floats the block bubble and reports its category upward; the region head names the whole category', async () => {
    const hovers: (string | null)[] = []
    const Harness = (p2: Omit<ContextBrowserProps, 'hoverKey' | 'onHoverKey'>) => {
      const [hoverKey, setHoverKey] = useState<string | null>(null)
      return h(Browser, props({ ...p2, hoverKey, onHoverKey: (k) => { setHoverKey(k); hovers.push(k) } }))
    }
    const m = await mount(h(Harness, { data: mapData(), headers: mapHeaders }))
    await click(mapBtn(m))

    const bash = blockByText(m, 'bash')
    await hover(bash)
    assert.deepEqual(tipRows(query(m.container, '.lc-map-tip')), ['bash ×2', '≈300 · 55% of used context', null])
    assert.ok(query(m.container, '.lc-map').className.includes('lc-map-dim'))
    assert.ok(bash.className.includes('lc-map-block-on'))
    assert.deepEqual(hovers, ['tool'])

    const sysHead = query(regionByHead(m, 'System Prompt'), '.lc-map-cat-head')
    await hover(sysHead)
    assert.deepEqual(tipRows(query(m.container, '.lc-map-tip')), ['System Prompt', '≈100 · 18% of used context', '1 Items'])
    assert.deepEqual(hovers, ['tool', 'system'])

    assert.ok(regionByHead(m, 'System Prompt').className.includes('lc-map-cat-on'))
    await unhover(query(m.container, '.lc-map'))
    assert.ok(!query(m.container, '.lc-map-tip').className.includes('lc-map-tip-on'))
    assert.deepEqual(hovers, ['tool', 'system', null])
    await m.unmount()
  })

  test('standalone hovers stay local, focus floats the bubble, DNA drops the upward link, and a removing push retracts it', async () => {
    const standalone = await mount(h(Browser, props({ data: mapData(), headers: mapHeaders })))
    await click(mapBtn(standalone))
    const bash = blockByText(standalone, 'bash')
    await hover(bash)
    assert.ok(query(standalone.container, '.lc-map-tip').className.includes('lc-map-tip-on'))
    await unhover(query(standalone.container, '.lc-map'))
    assert.ok(!query(standalone.container, '.lc-map-tip').className.includes('lc-map-tip-on'))
    await hover(query(regionByHead(standalone, 'System Prompt'), '.lc-map-cat-head'))
    assert.deepEqual(tipRows(query(standalone.container, '.lc-map-tip'))[0], 'System Prompt')
    await unhover(query(standalone.container, '.lc-map'))
    await focus(bash)
    assert.ok(query(standalone.container, '.lc-map-tip').className.includes('lc-map-tip-on'))
    await standalone.unmount()

    const hovers: (string | null)[] = []
    const wired = (over: Partial<ContextBrowserProps>) => h(Browser, props({
      data: mapData(), headers: mapHeaders, dna: true, onDnaChange: () => {},
      hoverKey: null, onHoverKey: (k) => { hovers.push(k) },
      ...over,
    }))
    const dna = await mount(wired({}))
    await click(mapBtn(dna))
    await hover(blockByText(dna, 'bash'))
    assert.deepEqual(hovers, [], 'the map reports nothing upward in DNA mode')
    assert.ok(query(dna.container, '.lc-map-tip').className.includes('lc-map-tip-on'), 'the local bubble still works')
    await hover(blockByText(dna, '#2'))
    assert.deepEqual(hovers, [])
    await dna.update(wired({ hoverKey: 'tool' }))
    assert.ok(regionByHead(dna, 'Tool Results').className.includes('lc-map-cat-on'))
    await dna.unmount()

    const pushedMount = await mount(h(Browser, props({ data: mapData(), headers: mapHeaders })))
    await click(mapBtn(pushedMount))
    await hover(blockByText(pushedMount, 'bash'))
    assert.ok(query(pushedMount.container, '.lc-map-tip').className.includes('lc-map-tip-on'))
    const pushed = mapData()
    pushed.nodes = pushed.nodes.filter(n => n.seq !== 3 && n.seq !== 4)
    pushed.current = { ...pushed.current, tool: 0, total: 245 }
    await pushedMount.update(h(Browser, props({ data: pushed, headers: mapHeaders })))
    assert.ok(!query(pushedMount.container, '.lc-map-tip').className.includes('lc-map-tip-on'))
    assert.ok(!query(pushedMount.container, '.lc-map').className.includes('lc-map-dim'))
    assert.ok(blocks(pushedMount).every(b => !text(b).includes('bash×2')))
    await pushedMount.unmount()
  })

  test('the bubble clamps inside the panel: shifted at the edges, centered and unflipped mid-panel', async () => {
    const m = await mount(h(Browser, props({ data: mapData(), headers: mapHeaders })))
    stubListRect('lc-map', 400, 240)
    await click(mapBtn(m))
    const wrap = query(m.container, '.lc-map')
    const tip = query(m.container, '.lc-map-tip')
    pinRect(tip, 300)
    await m.update(h(Browser, props({ data: mapData(), headers: mapHeaders })))

    await hover(blockByText(m, 'bash'))
    assert.ok(/translateX\(calc\(-50% \+ \d+px\)\)/.test(tip.style.transform), `left-clamped: ${tip.style.transform}`)
    const rightmost = regions(m).reduce((a, b) => (parseFloat(a.style.left) > parseFloat(b.style.left) ? a : b))
    await hover(query(rightmost, '.lc-map-block'))
    assert.ok(/translateX\(calc\(-50% - \d+px\)\)/.test(tip.style.transform), `right-clamped: ${tip.style.transform}`)
    await unhover(wrap)
    assert.equal(tip.style.transform, '')
    pinRect(tip, 60)
    await hover(blockByText(m, '#5'))
    assert.equal(tip.style.transform, 'translateX(-50%) translateY(-100%)')
    await unhover(wrap)
    assert.equal(tip.style.transform, '')
    await m.unmount()
    restoreLayout()
  })

  test('degenerate regions: a sliver category renders a bare frame, a sub-minimum one drops out', async () => {
    const frame = tl({
      current: { system: 10000, tools: 0, user: 190, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10190 },
      systems: [{ seq: 1, time: 1, tokens: 10000 }],
      nodes: [surfaceNode({ seq: 2, tokens: 190 })],
    })
    const m = await mount(h(Browser, props({ data: frame, headers: null })))
    await click(mapBtn(m))
    assert.equal(regions(m).length, 2)
    const sliver = regions(m)[1]
    assert.equal(queryAll(sliver, '.lc-map-cat-head').length, 0)
    assert.equal(queryAll(sliver, '.lc-map-block').length, 0)

    const gone = tl({
      current: { system: 100000, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 100010 },
      systems: [{ seq: 1, time: 1, tokens: 100000 }],
      nodes: [surfaceNode({ seq: 2, tokens: 10 })],
    })
    await m.update(h(Browser, props({ data: gone, headers: null })))
    assert.equal(regions(m).length, 1)
    await m.unmount()

    const tiny = tl({
      current: { system: 200, tools: 41, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 241 },
      systems: [{ seq: 1, time: 1, tokens: 200 }],
    })
    const tinyHeaders: ContextHeaders = {
      headers: [{ seq: 1, time: 1000, systemTokens: 200, tools: [{ name: 'bash', tokens: 40 }, { name: 'tiny', tokens: 1 }] }],
    }
    const tinyMap = await mount(h(Browser, props({ data: tiny, headers: tinyHeaders })))
    await click(mapBtn(tinyMap))
    const toolsBlocks = queryAll(regionByHead(tinyMap, 'Tool Schemas'), '.lc-map-block')
    assert.equal(toolsBlocks.length, 1, 'the 1-token schema sliver drops out')
    assert.ok(text(toolsBlocks[0]).includes('bash'))
    await tinyMap.unmount()
  })

  test('an empty step maps to the empty note', async () => {
    const m = await mount(h(Browser, props({ data: tl({}), headers: null })))
    await click(mapBtn(m))
    assert.equal(text(query(m.container, '.lc-map-empty')), 'Nothing to map — this step’s context is empty')
    await m.unmount()
  })
})
})

describe('attachments', () => {

const kit = makeKit()
const Attachments = makeAttachmentSection(kit)

const CONTENT: AttachmentRef[] = [
  { kind: 'file', attachmentId: 'sha256:f1', name: 'dsh-context-标题.svg', bytes: 2627 },
  { kind: 'file', attachmentId: 'sha256:f2', name: '调研报告.docx', bytes: 778285 },
  { kind: 'file', attachmentId: 'sha256:f3', name: 'REPORT.md', bytes: 47320 },
  { kind: 'image', attachmentId: 'sha256:i1', name: 'result-image-1.jpg', mediaType: 'image/jpeg', bytes: 146227, width: 1568, height: 1350, originalDimensions: { width: 3462, height: 1211 } },
]

const loadImage: ImageLoader = async (att) => {
  if (att.attachmentId === 'sha256:i1') return 'blob:image-1'
  throw new Error('denied')
}

async function mountSection(over: {
  attachments?: readonly AttachmentRef[]
  load?: ImageLoader
  open?: AttachmentOpener
} = {}): Promise<Awaited<ReturnType<typeof mount>>> {
  return await mount(h(Attachments, {
    attachments: over.attachments ?? CONTENT,
    ...(over.load !== undefined ? { load: over.load } : {}),
    ...(over.open !== undefined ? { open: over.open } : {}),
  }))
}

describe('the attachment block', () => {
  test('renders every attachment in message order, one card each', async () => {
    const m = await mountSection({ load: loadImage })
    await flush()
    const cards = queryAll(m.container, '.lc-att-item')
    assert.equal(cards.length, 4)
    assert.deepEqual(
      cards.map(c => text(query(c, '.lc-att-name'))),
      ['dsh-context-标题.svg', '调研报告.docx', 'REPORT.md', 'result-image-1.jpg'],
    )
    assert.deepEqual(text(query(m.container, '.lc-ts-card-head')), 'Attachments4')
    assert.deepEqual(queryAll(m.container, '.lc-att-ext').map(e => text(e)), ['SVG', 'DOCX', 'MD'])
    assert.equal(queryAll<HTMLImageElement>(m.container, '.lc-att-thumb img').length, 1)
    assert.ok(query<HTMLImageElement>(m.container, '.lc-att-thumb img').src.includes('blob:image-1'))
    const imageCard = cards[3]
    assert.ok(text(imageCard).includes('3462×1211'), 'raw dimensions')
    assert.ok(text(imageCard).includes('1568×1350 · 146.2 kB'), 'sent dimensions and size')
    assert.ok(text(imageCard).includes('Token') && text(imageCard).includes('≈988'))
    assert.ok(!text(cards[0]).includes('Type'))
    assert.ok(text(cards[0]).includes('Size') && text(cards[0]).includes('2.6 kB'))
    assert.ok(text(cards[0]).includes('Token') && text(cards[0]).includes('≈58'), 'the handle price')
    assert.ok(
      text(cards[1]).includes('≈56') && text(cards[2]).includes('≈56'),
      'a 778 kB docx costs no more than a 47 kB markdown: only the handle travels',
    )
    const fileTip = queryAll(cards[0], '.lc-att-row').pop()?.getAttribute('title') ?? ''
    assert.ok(fileTip.includes('Estimated') && fileTip.includes('never its contents'), fileTip)
    assert.ok(
      (queryAll(cards[3], '.lc-att-row').pop()?.getAttribute('title') ?? '').includes('image-size conversion'),
      'the image row keeps the vision calculator as its explanation',
    )
    assert.ok(text(cards[3]).includes('Type'), 'an image has no badge, so its type keeps the row')
    assert.ok(queryAll(m.container, '.lc-att-hint').every(hint => text(hint).includes('Click to preview')))
    await m.unmount()
  })

  test('a rejected or absent image loader degrades the thumbnail, never the block', async () => {
    const m = await mountSection({ load: loadImage, attachments: [{ kind: 'image', attachmentId: 'sha256:x', name: 'x.png' }] })
    await flush()
    assert.ok(text(query(m.container, '.lc-att-err')).includes('⚠'))
    await m.unmount()

    const bare = await mountSection({ attachments: [{ kind: 'image', attachmentId: 'sha256:x' }] })
    await flush()
    assert.equal(text(query(bare.container, '.lc-att-ph')), '🖼')
    assert.ok(text(query(bare.container, '.lc-att-name')).includes('Image'))
    await bare.unmount()
  })

  test('an unnamed file names its kind on the badge with no size or token row; an image without sent bytes still shows dimensions', async () => {
    const m = await mountSection({ attachments: [{ kind: 'file', attachmentId: 'sha256:u' }] })
    const card = query(m.container, '.lc-att-item')
    assert.ok(text(query(card, '.lc-att-name')).includes('File'))
    assert.equal(text(query(card, '.lc-att-ext')), 'File', 'the kind stands in for a missing extension')
    assert.ok(!text(card).includes('Size'))
    assert.ok(!text(card).includes('Token'))
    await m.unmount()

    const image = await mountSection({ attachments: [{ kind: 'image', attachmentId: 'sha256:i2', name: 'x.png', width: 10, height: 20 }] })
    assert.ok(text(query(image.container, '.lc-att-item')).includes('10×20'))
    await image.unmount()
  })

  test('a row re-render never re-reads the bytes (the reference is re-proven each render)', async () => {
    let reads = 0
    const counting: ImageLoader = async (att) => {
      reads += 1
      return 'blob:' + att.attachmentId
    }
    const m = await mountSection({ load: counting, attachments: [{ kind: 'image', attachmentId: 'sha256:i1', name: 'a.png', width: 4, height: 4 }] })
    await flush()
    assert.equal(reads, 1)
    await m.update(h(Attachments, { attachments: [{ kind: 'image', attachmentId: 'sha256:i1', name: 'a.png', width: 4, height: 4 }], load: counting }))
    await flush()
    assert.equal(reads, 1)
    assert.ok(query<HTMLImageElement>(m.container, '.lc-att-thumb img').src.includes('blob:sha256:i1'))
    await m.unmount()
  })

  test('an empty block renders nothing at all', async () => {
    const m = await mountSection({ attachments: [] })
    assert.equal(m.container.textContent, '')
    await m.unmount()
  })
})

describe('the card click', () => {
  test('hands every kind to the preview column at once, with no intermediate surface', async () => {
    const opened: string[] = []
    const open: AttachmentOpener = async (att) => {
      opened.push(att.attachmentId)
      return true
    }
    const m = await mountSection({ load: loadImage, open })
    await flush()
    for (const card of queryAll(m.container, '.lc-att-item')) await click(card)
    await flush()
    assert.deepEqual(opened, ['sha256:f1', 'sha256:f2', 'sha256:f3', 'sha256:i1'])
    assert.equal(queryAll(m.container, '.lc-att-fail').length, 0)
    assert.equal(queryAll(m.container, '[role=dialog]').length, 0)
    await m.unmount()
  })

  test('an open in flight shows on its own card, and a refusal leaves the note there', async () => {
    let settle: ((taken: boolean) => void) | undefined
    const open: AttachmentOpener = () => new Promise((resolve) => { settle = resolve })
    const m = await mountSection({ open })
    await click(queryAll(m.container, '.lc-att-item')[2])
    const opening = queryAll(m.container, '.lc-att-item')[2]
    assert.equal(opening.dataset.state, 'opening')
    assert.ok(text(query(opening, '.lc-att-hint')).includes('…'))
    settle?.(false)
    await flush()
    assert.equal(queryAll(m.container, '.lc-att-item')[2].dataset.state, 'failed')
    assert.ok(text(query(queryAll(m.container, '.lc-att-item')[2], '.lc-att-fail')).includes('Preview unavailable'))
    await click(queryAll(m.container, '.lc-att-item')[2])
    settle?.(true)
    await flush()
    assert.equal(queryAll(m.container, '.lc-att-item')[2].dataset.state, 'idle')
    assert.equal(queryAll(m.container, '.lc-att-fail').length, 0)
    await m.unmount()
  })

  test('without an opener every click reports on the card it hit', async () => {
    const m = await mountSection({})
    const cards = queryAll(m.container, '.lc-att-item')
    await click(cards[0])
    assert.equal(text(query(cards[0], '.lc-att-fail')), 'Preview unavailable')
    await click(cards[3])
    assert.equal(queryAll(m.container, '.lc-att-fail').length, 1)
    assert.equal(queryAll(m.container, '.lc-att-item')[3].dataset.state, 'failed')
    await m.unmount()
  })

  test('a content swap drops stale card states, even for an open still in flight', async () => {
    let settle: ((taken: boolean) => void) | undefined
    const m = await mountSection({ open: () => new Promise((resolve) => { settle = resolve }) })
    await click(queryAll(m.container, '.lc-att-item')[0])
    settle?.(false)
    await flush()
    assert.equal(queryAll(m.container, '.lc-att-fail').length, 1)
    await m.update(h(Attachments, { attachments: [{ kind: 'file', attachmentId: 'sha256:new', name: 'new.md', bytes: 1 }] }))
    assert.equal(queryAll(m.container, '.lc-att-fail').length, 0)
    await click(queryAll(m.container, '.lc-att-item')[0])
    await m.update(h(Attachments, { attachments: [{ kind: 'file', attachmentId: 'sha256:other', name: 'other.md', bytes: 2 }] }))
    settle?.(false)
    await flush()
    assert.equal(queryAll(m.container, '.lc-att-fail').length, 0)
    await m.unmount()
  })

  test('a load that settles after unmount never writes state', async () => {
    let settle: ((url: string) => void) | undefined
    let reject: ((err: Error) => void) | undefined
    const lateLoad: ImageLoader = () => new Promise((_resolve, rejectPromise) => {
      settle = _resolve
      reject = rejectPromise
    })
    const m = await mountSection({ load: lateLoad, attachments: [{ kind: 'image', attachmentId: 'sha256:i9', name: 'late.png' }] })
    await m.unmount()
    settle?.('blob:late')
    await flush()

    const failing = await mountSection({ load: lateLoad, attachments: [{ kind: 'image', attachmentId: 'sha256:i8', name: 'late-2.png' }] })
    await failing.unmount()
    reject?.(new Error('denied'))
    await flush()
  })

  test('two opens in flight keep their own cards marked, in landing order', async () => {
    const settles = new Map<string, (taken: boolean) => void>()
    const open: AttachmentOpener = (att) => new Promise((resolve) => { settles.set(att.attachmentId, resolve) })
    const m = await mountSection({ open })
    const cards = queryAll(m.container, '.lc-att-item')
    await click(cards[0])
    await click(cards[1])
    assert.equal(queryAll(m.container, '.lc-att-item')[1].dataset.state, 'opening')
    settles.get('sha256:f1')?.(true)
    await flush()
    assert.equal(queryAll(m.container, '.lc-att-item')[0].dataset.state, 'idle')
    assert.equal(queryAll(m.container, '.lc-att-item')[1].dataset.state, 'opening')
    settles.get('sha256:f2')?.(true)
    await flush()
    assert.equal(queryAll(m.container, '.lc-att-item')[1].dataset.state, 'idle')
    await m.unmount()
  })
})
})
