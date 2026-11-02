import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  fromPartyOf,
  includesAgent,
  initialsOf,
  avatarLabelsOf,
  avatarLabelOf,
  kindGroupOf,
  nameOfParty,
  NAME_PARTY_PREFIX,
  previewOf,
  settledToneOf,
  UNKNOWN_PARTY,
} from '../../src/client/commsModel'
import type { CommsRow } from '../../src/client/fleetDetail'

function row(over: Partial<CommsRow> & { seq: number; to: string; time: number; text: string }): CommsRow {
  return { key: `${over.to}:${over.seq}:${over.time}:relay`, kind: 'relay', ...over }
}

describe('party keys', () => {
  test('an id outranks a name; name-only parties key by name; the bare arrow is unknown; channels are unordered and agent scope matches either side', () => {
    assert.equal(fromPartyOf(row({ seq: 1, to: 'a', time: 1, text: 'x', from: 'b', fromName: 'Bee' })), 'b')
    assert.equal(fromPartyOf(row({ seq: 1, to: 'a', time: 1, text: 'x', fromName: 'Bee' })), NAME_PARTY_PREFIX + 'Bee')
    assert.equal(fromPartyOf(row({ seq: 1, to: 'a', time: 1, text: 'x' })), UNKNOWN_PARTY)
    assert.equal(nameOfParty(NAME_PARTY_PREFIX + 'Bee'), 'Bee')
    assert.equal(nameOfParty('session-a'), undefined)
    const forward = row({ seq: 1, to: 'b', time: 1, text: 'x', from: 'a' })
    assert.equal(includesAgent(forward, 'a'), true)
    assert.equal(includesAgent(forward, 'b'), true)
    assert.equal(includesAgent(forward, 'c'), false)
  })
})

describe('display helpers', () => {
  test('settled tones and kind groups; previews strip fences and markup and cap at 600; initials cover CJK, hyphens, single words, and blanks', () => {
    assert.equal(settledToneOf('finished'), 'done')
    assert.equal(settledToneOf('finishedFinal'), 'done')
    assert.equal(settledToneOf('failed'), 'error')
    assert.equal(settledToneOf('stopped'), 'warning')
    assert.equal(settledToneOf('declined'), 'warning')
    assert.equal(settledToneOf(null), 'idle')
    assert.equal(kindGroupOf(row({ seq: 1, to: 'a', time: 1, text: '' })), 'message')
    assert.equal(kindGroupOf({ key: 'a', seq: 1, to: 'a', time: 1, kind: 'settled', text: '' }), 'report')

    assert.equal(previewOf('# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |'), 'Title a b 1 2')
    assert.equal(previewOf('```js\nconst x = 1\n```'), '```js const x = 1 ```')
    assert.equal(previewOf('`inline` **bold** [link](https://x)'), 'inline bold link')
    const long = previewOf('x'.repeat(800))
    assert.equal(long.length, 601)
    assert.ok(long.endsWith('…'))

    assert.equal(initialsOf('分析 Agent'), '分析')
    assert.equal(initialsOf('修复会话耗时占比统计'), '修复')
    assert.equal(initialsOf('主 Agent'), '主A')
    assert.equal(initialsOf('standard-axis options'), 'SA')
    assert.equal(initialsOf('Review Code'), 'RC')
    assert.equal(initialsOf('host-cleaner'), 'HC')
    assert.equal(initialsOf('lead'), 'LE')
    assert.equal(initialsOf('a'), 'A')
    assert.equal(initialsOf('  '), '?')
    assert.equal(initialsOf(' - '), '?')
  })

  test('avatar labels stay on one line up to three glyphs, then fold onto two', () => {
    assert.deepEqual(avatarLabelOf('CB'), { lines: ['CB'], condensed: false })
    assert.deepEqual(avatarLabelOf('主控'), { lines: ['主控'], condensed: false })
    assert.deepEqual(avatarLabelOf('DS1'), { lines: ['DS1'], condensed: true })
    assert.deepEqual(avatarLabelOf('修复1'), { lines: ['修复1'], condensed: true })
    assert.deepEqual(avatarLabelOf('DS45'), { lines: ['DS', '45'], condensed: false })
    assert.deepEqual(avatarLabelOf('DS108'), { lines: ['DS', '108'], condensed: false })
    assert.deepEqual(avatarLabelOf('ABCD'), { lines: ['AB', 'CD'], condensed: false })
  })

  test('avatar labels keep the plain initials until two agents collide, then digits split them', () => {
    const labels = avatarLabelsOf([
      { id: 'a', name: 'Spec review of timing fix' },
      { id: 'b', name: 'Standards review of diff' },
      { id: 'c', name: '修复会话耗时占比统计' },
      { id: 'd', name: 'worker-bee' },
      { id: 'a', name: 'Spec review of timing fix' },
    ])
    assert.deepEqual([...labels.entries()], [['a', 'SR1'], ['b', 'SR2'], ['c', '修复'], ['d', 'WB']])
    assert.deepEqual([...avatarLabelsOf([]).entries()], [])
    const solo = avatarLabelsOf([{ id: 'a', name: 'Spec review of timing fix' }])
    assert.deepEqual([...solo.entries()], [['a', 'SR']])
  })
})
