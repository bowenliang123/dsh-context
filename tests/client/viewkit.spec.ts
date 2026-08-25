// The view kit (src/client/viewkit.ts): the dependency bag exposes the
// translate/format helpers and the event-text delegates (full event-text
// coverage lives in the events spec — here only one delegation spot-check).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { fmt, fmtTime } from '../../src/client/format'
import { DICT_EN } from '../../src/client/i18n'
import { makeViewKit } from '../../src/client/viewkit'
import type { ContextEventRecord } from '../../src/shared/types'
import { makeKit, makeTranslate } from './helpers/kit'

describe('makeViewKit', () => {
  test('exposes t, fmt, and fmtTime', () => {
    const t = makeTranslate()
    const kit = makeViewKit(t)
    assert.equal(kit.t, t)
    assert.equal(kit.fmt, fmt)
    assert.equal(kit.fmtTime, fmtTime)
  })

  test('catLabel maps through the dictionary', () => {
    const kit = makeKit()
    assert.equal(kit.catLabel('system'), DICT_EN['cat.system'])
    assert.equal(kit.catLabel('tool'), DICT_EN['cat.tool'])
  })

  test('eventLabel delegates to makeEventText (compaction with a count)', () => {
    const kit = makeKit()
    const ev: ContextEventRecord = { seq: 1, time: 1000, kind: 'compaction', count: 3, turn: 2, step: 4 }
    assert.equal(kit.eventLabel(ev), DICT_EN['ev.compaction'].replace('{n}', '3'))
  })

  test('eventAt is null for an event without a turn/step anchor', () => {
    const kit = makeKit()
    const ev: ContextEventRecord = { seq: 2, time: 1000, kind: 'inject', form: 'notice' }
    assert.equal(kit.eventAt(ev), null)
  })
})
