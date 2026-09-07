// DetailNote (src/client/components/detailNote.tsx): the split generation's
// detail-pending note — loading strip, the failed state's retry button, and
// the inert plain-text failure when no retry is wired.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeDetailNote } from '../../../src/client/components/detailNote'
import { DICT_EN, DICT_ZH } from '../../../src/client/i18n'
import { click, makeKit, mount, query, text } from '../helpers/kit'

const DetailNote = makeDetailNote(makeKit())
const DetailNoteZh = makeDetailNote(makeKit('zh'))

describe('DetailNote', () => {
  test('the loading strip names the pending read', async () => {
    const m = await mount(h(DetailNote, { state: 'loading' as const }))
    assert.equal(text(m.container), DICT_EN['detail.loading'])
    assert.equal(query(m.container, 'div').className, 'lc-empty', 'the default well class')
    await m.unmount()
  })

  test('the failed strip arms the retry button; the caller class applies', async () => {
    let retries = 0
    const m = await mount(h(DetailNote, {
      state: 'failed' as const,
      onRetry: () => { retries++ },
      className: 'lc-br-note',
    }))
    assert.equal(query(m.container, 'div').className, 'lc-br-note')
    await click(query(m.container, '.lc-br-retry'))
    assert.equal(retries, 1)
    await m.unmount()
  })

  test('a failed note without a retry callback renders the inert text', async () => {
    const m = await mount(h(DetailNote, { state: 'failed' as const }))
    assert.equal(text(m.container), DICT_EN['detail.loadFailed'])
    assert.equal(m.container.querySelector('button'), null)
    await m.unmount()
  })

  test('the zh locale localizes both states', async () => {
    const m = await mount(h(DetailNoteZh, { state: 'loading' as const }))
    assert.equal(text(m.container), DICT_ZH['detail.loading'])
    await m.unmount()
  })
})
