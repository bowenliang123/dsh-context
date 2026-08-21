/**
 * Context-browser auto-load: expanding an element whose seq is outside the
 * loaded conversation window pages older history in (via the plugin's own
 * sessions.provide contribution) until the join hits.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { bootViewBed, byClass, textOf } from './helpers/viewBed.mjs'

const bed = await bootViewBed()
const { renderView, snapshot } = bed
let tr

test('context browser auto-load: loading note, one page pulled, joined content, no over-paging', async () => {
  // ---- Context browser auto-load: expanding an element whose seq is outside
  // the loaded conversation window pages older history in (via the plugin's
  // own `sessions.provide` contribution) until the join hits. ----
  let sessionSnap = { nodes: [], hasMore: true, loadingOlder: false }
  let loadCalls = 0
  bed.useSessionHolder = (sel) => sel(sessionSnap)
  bed.loadOlderHolder = async () => {
    loadCalls += 1
    // The page lands: seq 1's full content enters the window, history ends.
    sessionSnap = {
      nodes: [{ kind: 'user', seq: 1, content: [{ type: 'text', text: 'FULL-MESSAGE-TEXT' }] }],
      hasMore: false,
      loadingOlder: false,
    }
  }
  bed.dataValue = snapshot
  // Mount the ContextBrowser fiber before addressing its hook slots.
  tr = renderView()
  const brSlots = bed.brSlots()
  brSlots[1][1]('user') // reopen the user category
  brSlots[2][1]('n1')   // expand the out-of-window element
  tr = renderView()
  assert.match(textOf(byClass(tr, 'lc-br-content')[0]), /loading older history/, 'loading note while the page is being pulled')
  // ContextBrowser hook slots: 0 sel, 1 openCat, 2 openElem, 3 exhausted,
  // 4 pagesRef, 5 reset effect, 6 auto-load effect, 7 history-end effect,
  // 8 pin-linkage effect.
  // React runs effects in order post-render; drive them the same way.
  brSlots[5].effect()
  brSlots[6].effect()
  assert.equal(loadCalls, 1, 'expanding pulls one older page')
  tr = renderView()
  const joined = textOf(byClass(tr, 'lc-br-content')[0])
  assert.match(joined, /FULL-MESSAGE-TEXT/, 'joined content replaces the preview once the page lands')
  assert.ok(!/outside the loaded window/.test(joined), 'window note gone after the join hits')
  // No further pages once the seq joined.
  brSlots[6].effect()
  assert.equal(loadCalls, 1, 'no extra pages after the join hits')
  bed.useSessionHolder = undefined
  bed.loadOlderHolder = undefined

  console.log('✔ context browser auto-load test passed (loading note, one page pulled, joined content, no over-paging)')
})
