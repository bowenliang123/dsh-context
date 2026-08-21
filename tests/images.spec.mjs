/**
 * Image attachment cards: prose stays in the text card, durable image refs
 * render as thumbnail cards, unrecognized blocks keep a raw JSON card;
 * thumbnails resolve through the conversation service when present.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { bootViewBed, byClass, textOf } from './helpers/viewBed.mjs'

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
  brSlots[2][1]('n1')   // expand the user element
  let trImg = renderView()
  // Metadata-only degradation (no conversation service armed): two attachment
  // cards (images + other), two image items, placeholder tiles, no <img>.
  assert.equal(byClass(trImg, 'lc-ts-card').length, 2, 'images card + other-content card rendered')
  assert.equal(byClass(trImg, 'lc-att-item').length, 2, 'one item per image ref')
  assert.equal(byClass(trImg, 'lc-att-thumb').length, 2, 'one tile per image')
  assert.equal(byClass(trImg, 'lc-att-ph').length, 2, 'placeholder tiles without the loader')
  const imgCardText = textOf(byClass(trImg, 'lc-ts-card')[0])
  assert.match(imgCardText, /screenshot\.png/, 'named image shows its display name')
  assert.match(imgCardText, /2048×1365/, 'normalized dims shown')
  assert.match(imgCardText, /original 6000×4000/, 'pre-normalization dims shown when present')
  assert.match(imgCardText, /153\.6 kB/, 'stored byte size shown')
  assert.match(imgCardText, /Image/, 'unnamed image falls back to the generic label')
  assert.match(imgCardText, /800×600/, 'second image dims shown')
  assert.match(textOf(byClass(trImg, 'lc-ts-card')[1]), /file:\/\/x/, 'unrecognized blocks keep the raw JSON card')
  assert.match(textOf(byClass(trImg, 'lc-br-content')[0]), /WHAT-IS-THIS/, 'prose stays in the text card')
  assert.equal(byClass(trImg, 'lc-att-thumb')[0].args.slice(2).filter(c => c !== null && typeof c === 'object' && c.args[0] === 'img').length, 0, 'no thumbnail img without the loader')
  // Arm the conversation service: the loader resolves a display URL per ref.
  bed.conversationHolder = { resolveImage: async (sid, att) => 'blob:' + att.attachmentId }
  trImg = renderView()
  // Drive every ImageCard's load effect (slot 3 = its useEffect), then flush.
  for (const [key, slots] of hookStates) {
    if (key.includes('ImageCard') && slots[3] !== undefined) slots[3].effect()
  }
  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))
  trImg = renderView()
  const thumbImgs = byClass(trImg, 'lc-att-thumb')
    .flatMap(t => t.args.slice(2))
    .filter(c => c !== null && typeof c === 'object' && c.args[0] === 'img')
  assert.deepEqual(thumbImgs.map(i => i.args[1].src), ['blob:a1', 'blob:a2'], 'thumbnails resolve through resolveImage')

  console.log('✔ image attachment card test passed (card layout, metadata degradation, resolveImage thumbnails)')
})
