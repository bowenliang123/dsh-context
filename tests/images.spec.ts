/**
 * Image attachment cards: prose stays in the text card, durable image refs
 * render as thumbnail cards, unrecognized blocks keep a raw JSON card;
 * thumbnails resolve through the conversation service when present.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { bootViewBed, byClass, textOf } from './helpers/viewBed'

const bed = await bootViewBed()
const { hookStates, renderView, snapshot } = bed
bed.dataValue = snapshot
renderView() // mount the ContextBrowser fiber before addressing its hooks
const brSlots = bed.brSlots()

test('image attachment cards: card layout, metadata degradation, resolveImage thumbnails', async () => {
  // ---- Image attachment cards: a user message carrying durable image refs
  // renders the card layout — prose in the text card, images as thumbnail
  // cards (name + dims + stored size), unrecognized blocks in a raw JSON
  // card. Thumbnails load through the conversation service's resolveImage;
  // without that service the cards degrade to metadata-only. ----
  bed.useSessionHolder = (sel) => sel({
    nodes: [{
      kind: 'user', seq: 1, content: [
        { type: 'text', text: 'WHAT-IS-THIS' },
        { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 153600, width: 2048, height: 1365, name: 'screenshot.png', originalDimensions: { width: 6000, height: 4000 } } },
        { type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/jpeg', bytes: 512000, width: 800, height: 600 } },
        { type: 'file', uri: 'file://x' },
      ],
    }],
  })
  bed.dataValue = snapshot
  brSlots[1][1]('user') // openCat('user')
  // The collapsed row of an image-carrying user message gains an Image chip
  // (count appended when several); the chip leaves once the expanded body
  // shows the image grid itself.
  const trCollapsed = renderView()
  const chips = byClass(trCollapsed, 'lc-br-tag')
  assert.equal(chips.length, 1, 'one Image chip on the collapsed row')
  assert.equal(textOf(chips[0]), 'Image ×2', 'chip names the attachment count')
  brSlots[2][1]('n1')   // expand the user element
  let trImg = renderView()
  assert.equal(byClass(trImg, 'lc-br-tag').length, 0, 'chip leaves once the body shows the image grid')
  // Metadata-only degradation (no conversation service armed): three section
  // cards (content text + images + other), two image items, placeholder
  // tiles, no <img>.
  assert.equal(byClass(trImg, 'lc-ts-card').length, 3, 'content + images + other-content cards rendered')
  assert.equal(byClass(trImg, 'lc-att-item').length, 2, 'one item per image ref')
  assert.equal(byClass(trImg, 'lc-att-thumb').length, 2, 'one tile per image')
  assert.equal(byClass(trImg, 'lc-att-ph').length, 2, 'placeholder tiles without the loader')
  const imgCardText = textOf(byClass(trImg, 'lc-ts-card')[1])
  assert.match(imgCardText, /screenshot\.png/, 'named image shows its display name')
  assert.match(imgCardText, /Raw6000×4000/, 'pre-normalization dims shown when present')
  assert.match(imgCardText, /Sent2048×1365 · 153\.6 kB/, 'normalized dims + stored byte size shown')
  assert.match(imgCardText, /Image/, 'unnamed image falls back to the generic label')
  assert.match(imgCardText, /Sent800×600 · 512\.0 kB/, 'second image dims + size shown')
  // Token-cost rows: the official DeepSeek image calculator on the stored
  // dims (2048×1365 → 313, 800×600 → 341), shown on every card.
  assert.match(imgCardText, /Token≈313/, 'first image shows its estimated token cost')
  assert.match(imgCardText, /Token≈341/, 'second image shows its estimated token cost')
  // Labeled rows: raw + sent + token on the first card, sent + token on the
  // second (no originalDimensions recorded → no Raw row).
  assert.equal(byClass(trImg, 'lc-att-row').length, 5, 'one labeled row per known fact')
  assert.match(textOf(byClass(trImg, 'lc-ts-card')[2]), /file:\/\/x/, 'unrecognized blocks keep the raw JSON card')
  assert.match(textOf(byClass(trImg, 'lc-br-content')[0]), /WHAT-IS-THIS/, 'prose stays in the text card')
  assert.equal(byClass(trImg, 'lc-att-thumb')[0].args.slice(2).filter(c => c !== null && typeof c === 'object' && c.args[0] === 'img').length, 0, 'no thumbnail img without the loader')
  // The whole card is the click target (a single button wrapping tile +
  // metadata); clicking before anything loads opens nothing.
  const cardEl = byClass(trImg, 'lc-att-item')[0]
  assert.equal(cardEl.args[0], 'button', 'the whole card is one button')
  cardEl.args[1].onClick()
  trImg = renderView()
  assert.equal(byClass(trImg, 'lc-att-lightbox').length, 0, 'no preview without a loaded image')
  // Arm the conversation service: the loader resolves a display URL per ref.
  bed.conversationHolder = { resolveImage: async (sid, att) => 'blob:' + att.attachmentId }
  trImg = renderView()
  // Drive every ImageCard's load effect (slot 4 = its useEffect, after the
  // src/error/attempt/preview states), then flush.
  for (const [key, slots] of hookStates) {
    if (key.includes('ImageCard') && slots[4] !== undefined) slots[4].effect()
  }
  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))
  trImg = renderView()
  const thumbImgs = byClass(trImg, 'lc-att-thumb')
    .flatMap(t => t.args.slice(2))
    .filter(c => c !== null && typeof c === 'object' && c.args[0] === 'img')
  assert.deepEqual(thumbImgs.map(i => i.args[1].src), ['blob:a1', 'blob:a2'], 'thumbnails resolve through resolveImage')
  // Clicking the loaded card opens the chat-style lightbox preview (no new
  // tab); the mask press closes it again.
  byClass(trImg, 'lc-att-item')[0].args[1].onClick()
  trImg = renderView()
  assert.equal(byClass(trImg, 'lc-att-lightbox').length, 1, 'click opens the lightbox preview')
  assert.equal(byClass(trImg, 'lc-att-lightbox-img')[0].args[1].src, 'blob:a1', 'lightbox shows the clicked image')
  assert.equal(byClass(trImg, 'lc-att-lightbox-close').length, 1, 'lightbox has a close control')
  byClass(trImg, 'lc-att-lightbox-mask')[0].args[1].onMouseDown()
  trImg = renderView()
  assert.equal(byClass(trImg, 'lc-att-lightbox').length, 0, 'mask press closes the preview')

  console.log('✔ image attachment card test passed (card layout, metadata degradation, resolveImage thumbnails, lightbox preview)')
})
