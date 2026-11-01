import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  channelKeyOf,
  channelsOf,
  fromPartyOf,
  includesAgent,
  initialsOf,
  avatarLabelsOf,
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
    const back = row({ seq: 2, to: 'a', time: 2, text: 'y', from: 'b' })
    assert.equal(channelKeyOf(forward), channelKeyOf(back))
    assert.equal(includesAgent(forward, 'a'), true)
    assert.equal(includesAgent(forward, 'b'), true)
    assert.equal(includesAgent(forward, 'c'), false)
  })
})

describe('channelsOf', () => {
  const rows: CommsRow[] = [
    row({ key: 'b:4:400:relay', seq: 4, to: 'b', time: 400, text: 'later', from: 'a' }),
    { key: 'a:3:300:settled', seq: 3, to: 'a', time: 300, kind: 'settled', from: 'b', text: 'done', summary: 'done' },
    row({ key: 'a:2:200:mailbox', seq: 2, to: 'a', time: 200, kind: 'mailbox', from: 'b', text: 'older', fromName: 'Bee' }),
    row({ key: 'b:1:100:relay', seq: 1, to: 'b', time: 100, text: 'first', from: 'a' }),
    row({ key: 'c:1:50:relay', seq: 1, to: 'c', time: 50, text: 'side', fromName: 'legacy' }),
  ]

  test('one channel per unordered pair, anchor first; without an anchor the larger sender leads; self and empty cases hold', () => {
    const channels = channelsOf(rows, 'b')
    assert.equal(channels.length, 2)
    const main = channels[0]!
    assert.equal(main.a, 'b')
    assert.equal(main.b, 'a')
    assert.equal(main.out, 2)
    assert.equal(main.back, 2)
    assert.deepEqual(main.kinds, { relay: 2, mailbox: 1, settled: 1 })
    assert.equal(main.lastTime, 400)
    assert.deepEqual(main.rows.map(item => item.time), [400, 300, 200, 100])
    const side = channels[1]!
    assert.equal(side.a, NAME_PARTY_PREFIX + 'legacy')
    assert.equal(side.b, 'c')
    assert.equal(side.out, 1)
    assert.equal(side.back, 0)

    const unanchored = channelsOf(rows)
    const leader = unanchored.find(channel => channel.key === channelKeyOf(rows[0]!))!
    assert.equal(leader.a, 'a')
    assert.equal(leader.b, 'b')
    const tied = channelsOf([
      row({ key: 'x:1:1:relay', seq: 1, to: 'y', time: 1, text: 'x', from: 'x' }),
      row({ key: 'y:2:2:relay', seq: 2, to: 'x', time: 2, text: 'y', from: 'y' }),
    ])
    assert.equal(tied[0]!.a, 'x')

    const self = channelsOf([row({ key: 'a:1:1:relay', seq: 1, to: 'a', time: 1, text: 'me', from: 'a' })])
    assert.equal(self.length, 1)
    assert.equal(self[0]!.a, 'a')
    assert.equal(self[0]!.b, 'a')
    assert.equal(self[0]!.out, 1)
    assert.equal(self[0]!.back, 0)
    assert.deepEqual(channelsOf([]), [])
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
