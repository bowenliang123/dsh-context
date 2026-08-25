// images.tsx — imageRefOf narrowing (pure) plus ImageCard and the
// AttachmentLightbox rendered with real React (portal to document.body).

import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { act } from 'react'
import { h } from '../../../src/client/react'
import { imageRefOf, makeImageCard } from '../../../src/client/components/images'
import type { ImageRefLike } from '../../../src/client/services'
import { estimateImageTokens } from '../../../src/shared/imageTokens'
import { click, flush, keydown, makeKit, mount, query, queryAll } from '../helpers/kit'

const kit = makeKit()
const ImageCard = makeImageCard(kit)

async function mousedown(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  })
}

describe('imageRefOf', () => {
  test('rejects non-objects and non-image blocks', () => {
    assert.equal(imageRefOf(null), null)
    assert.equal(imageRefOf('image'), null)
    assert.equal(imageRefOf(42), null)
    assert.equal(imageRefOf({}), null)
    assert.equal(imageRefOf({ type: 'text', attachment: { attachmentId: 'a' } }), null)
  })

  test('accepts both type:image and kind:image shapes', () => {
    const attachment = { attachmentId: 'a1' }
    assert.deepEqual(imageRefOf({ type: 'image', attachment }), { attachmentId: 'a1' })
    assert.deepEqual(imageRefOf({ kind: 'image', attachment }), { attachmentId: 'a1' })
  })

  test('rejects a missing or malformed attachment', () => {
    assert.equal(imageRefOf({ type: 'image' }), null)
    assert.equal(imageRefOf({ type: 'image', attachment: null }), null)
    assert.equal(imageRefOf({ type: 'image', attachment: 'x' }), null)
    assert.equal(imageRefOf({ type: 'image', attachment: {} }), null)
    assert.equal(imageRefOf({ type: 'image', attachment: { attachmentId: '' } }), null)
    assert.equal(imageRefOf({ type: 'image', attachment: { attachmentId: 42 } }), null)
  })

  test('keeps only well-formed optional facts', () => {
    assert.deepEqual(
      imageRefOf({
        type: 'image',
        attachment: {
          attachmentId: 'a1',
          name: '',
          bytes: '500',
          width: NaN,
          height: 0,
          originalDimensions: 'big',
        },
      }),
      { attachmentId: 'a1' },
    )
    assert.deepEqual(
      imageRefOf({ type: 'image', attachment: { attachmentId: 'a1', bytes: -5, originalDimensions: null } }),
      { attachmentId: 'a1' },
    )
    assert.deepEqual(
      imageRefOf({ type: 'image', attachment: { attachmentId: 'a1', originalDimensions: { width: 100 } } }),
      { attachmentId: 'a1' },
    )
    assert.deepEqual(
      imageRefOf({ type: 'image', attachment: { attachmentId: 'a1', originalDimensions: { width: 0, height: 10 } } }),
      { attachmentId: 'a1' },
    )
  })

  test('passes a fully populated attachment through', () => {
    assert.deepEqual(
      imageRefOf({
        kind: 'image',
        attachment: {
          attachmentId: 'a1',
          name: 'photo.png',
          bytes: 500,
          width: 100,
          height: 100,
          originalDimensions: { width: 4000, height: 3000 },
        },
      }),
      {
        attachmentId: 'a1',
        name: 'photo.png',
        bytes: 500,
        width: 100,
        height: 100,
        originalDimensions: { width: 4000, height: 3000 },
      },
    )
  })
})

const FULL: ImageRefLike = {
  attachmentId: 'a1',
  name: 'photo.png',
  bytes: 500,
  width: 100,
  height: 100,
  originalDimensions: { width: 4000, height: 3000 },
}

describe('ImageCard metadata', () => {
  test('without a loader: placeholder tile, metadata rows, click is a no-op', async () => {
    const m = await mount(h(ImageCard, { attachment: FULL }))
    const card = query(m.container, '.lc-att-item')
    assert.equal(card.getAttribute('title'), 'Open full image')
    assert.equal(query(m.container, '.lc-att-ph').textContent, '🖼')
    assert.equal(query(m.container, '.lc-att-name').textContent, 'photo.png')
    const rows = queryAll(m.container, '.lc-att-row')
    assert.equal(rows.length, 3)
    assert.equal(rows[0].textContent, 'Raw4000×3000')
    assert.equal(rows[1].textContent, 'Sent100×100 · 500 B')
    assert.equal(rows[2].textContent, `Token≈${estimateImageTokens(100, 100)}`)
    assert.ok(rows[2].getAttribute('title')!.includes('384'))
    assert.equal(rows[0].getAttribute('title'), null)
    await click(card)
    assert.equal(queryAll(document.body, '.lc-att-lightbox').length, 0)
    await m.unmount()
  })

  test('without a name the generic label applies; without dimensions no rows render', async () => {
    const m = await mount(h(ImageCard, { attachment: { attachmentId: 'a2' } }))
    const name = query(m.container, '.lc-att-name')
    assert.equal(name.textContent, 'Image')
    assert.equal(name.getAttribute('title'), 'Image')
    assert.equal(queryAll(m.container, '.lc-att-row').length, 0)
    await m.unmount()
  })

  test('sent row without a byte size shows dimensions only', async () => {
    const m = await mount(h(ImageCard, { attachment: { attachmentId: 'a3', name: 'n.png', width: 200, height: 50 } }))
    const rows = queryAll(m.container, '.lc-att-row')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].textContent, 'Sent200×50')
    assert.equal(rows[1].textContent, `Token≈${estimateImageTokens(200, 50)}`)
    await m.unmount()
  })
})

describe('ImageCard loading', () => {
  test('a resolving loader swaps the placeholder for the image', async () => {
    const load = vi.fn((_att: ImageRefLike) => Promise.resolve('blob:x'))
    const m = await mount(h(ImageCard, { attachment: FULL, load }))
    await flush()
    const img = query<HTMLImageElement>(m.container, '.lc-att-thumb img')
    assert.equal(img.getAttribute('src'), 'blob:x')
    assert.equal(img.getAttribute('alt'), 'photo.png')
    assert.equal(load.mock.calls.length, 1)
    assert.deepEqual(load.mock.calls[0][0], FULL)
    await m.unmount()
  })

  test('a pending loader shows the loading glyph', async () => {
    const load = () => new Promise<string>(() => {})
    const m = await mount(h(ImageCard, { attachment: FULL, load }))
    assert.equal(query(m.container, '.lc-att-ph').textContent, '…')
    await m.unmount()
  })

  test('a rejecting loader shows the error tile; clicking retries the load', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('blob:y')
    const m = await mount(h(ImageCard, { attachment: FULL, load }))
    await flush()
    assert.equal(query(m.container, '.lc-att-err').textContent, '⚠')
    assert.equal(query(m.container, '.lc-att-item').getAttribute('title'), 'Load failed · click to retry')
    await click(query(m.container, '.lc-att-item'))
    await flush()
    assert.equal(load.mock.calls.length, 2)
    const img = query<HTMLImageElement>(m.container, '.lc-att-thumb img')
    assert.equal(img.getAttribute('src'), 'blob:y')
    assert.equal(query(m.container, '.lc-att-item').getAttribute('title'), 'Open full image')
    await m.unmount()
  })

  test('a late answer after unmount is dropped (resolve and reject alike)', async () => {
    let resolveLoad: ((url: string) => void) | null = null
    const m = await mount(h(ImageCard, { attachment: FULL, load: () => new Promise<string>((r) => { resolveLoad = r }) }))
    await m.unmount()
    resolveLoad!('blob:z')
    await flush()

    let rejectLoad: ((err: unknown) => void) | null = null
    const m2 = await mount(h(ImageCard, {
      attachment: FULL,
      load: () => new Promise<string>((_, rej) => { rejectLoad = rej }),
    }))
    await m2.unmount()
    rejectLoad!(new Error('late'))
    await flush()
  })
})

describe('AttachmentLightbox', () => {
  async function mountOpenable() {
    const load = () => Promise.resolve('blob:x')
    const m = await mount(h(ImageCard, { attachment: FULL, load }))
    await flush()
    return m
  }

  test('click opens the body portal; Escape closes it and restores focus', async () => {
    const m = await mountOpenable()
    const card = query(m.container, '.lc-att-item')
    card.focus()
    assert.equal(document.activeElement, card)
    await click(card)
    const box = query(document.body, '.lc-att-lightbox')
    assert.equal(box.getAttribute('role'), 'dialog')
    assert.equal(box.getAttribute('aria-label'), 'Image preview')
    assert.equal(query<HTMLImageElement>(box, '.lc-att-lightbox-img').getAttribute('src'), 'blob:x')
    const close = query(box, '.lc-att-lightbox-close')
    assert.equal(close.getAttribute('aria-label'), 'Close')
    assert.ok(query(box, 'svg') instanceof SVGElement) // real IconCloseOutline16
    assert.equal(document.activeElement, close) // focus moved into the dialog
    await keydown('Enter') // non-Escape keys keep it open
    assert.equal(queryAll(document.body, '.lc-att-lightbox').length, 1)
    await keydown('Escape')
    assert.equal(queryAll(document.body, '.lc-att-lightbox').length, 0)
    assert.equal(document.activeElement, card) // focus restored to the opener
    await m.unmount()
  })

  test('mask mousedown closes the lightbox', async () => {
    const m = await mountOpenable()
    await click(query(m.container, '.lc-att-item'))
    await mousedown(query(document.body, '.lc-att-lightbox-mask'))
    assert.equal(queryAll(document.body, '.lc-att-lightbox').length, 0)
    await m.unmount()
  })

  test('the close button closes the lightbox', async () => {
    const m = await mountOpenable()
    await click(query(m.container, '.lc-att-item'))
    await click(query(document.body, '.lc-att-lightbox-close'))
    assert.equal(queryAll(document.body, '.lc-att-lightbox').length, 0)
    await m.unmount()
  })

  test('without a focused opener there is nothing to restore to', async () => {
    // jsdom always reports <body> as activeElement; force the null arm of the
    // `instanceof HTMLElement` guard.
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement')
    Object.defineProperty(document, 'activeElement', { get: () => null, configurable: true })
    try {
      const m = await mountOpenable()
      await click(query(m.container, '.lc-att-item'))
      assert.equal(queryAll(document.body, '.lc-att-lightbox').length, 1)
      await keydown('Escape')
      assert.equal(queryAll(document.body, '.lc-att-lightbox').length, 0)
      await m.unmount()
    } finally {
      delete (document as { activeElement?: unknown }).activeElement
      if (descriptor) Object.defineProperty(Document.prototype, 'activeElement', descriptor)
    }
  })

  test('switching the attachment while open closes the preview', async () => {
    const load = () => Promise.resolve('blob:x')
    const m = await mount(h(ImageCard, { attachment: FULL, load }))
    await flush()
    await click(query(m.container, '.lc-att-item'))
    assert.equal(queryAll(document.body, '.lc-att-lightbox').length, 1)
    // New attachment with a pending load: src resets, preview drops out.
    await m.update(h(ImageCard, { attachment: { ...FULL, attachmentId: 'a2' }, load: () => new Promise<string>(() => {}) }))
    assert.equal(queryAll(document.body, '.lc-att-lightbox').length, 0)
    await m.unmount()
  })
})
