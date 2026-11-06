import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeAttachmentSection } from '../../../src/client/components/attachments'
import type { AttachmentOpener, ImageLoader } from '../../../src/client/services'
import type { AttachmentRef } from '../../../src/shared/attachment'
import { click, flush, makeKit, mount, query, queryAll, text } from '../helpers/kit'

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
