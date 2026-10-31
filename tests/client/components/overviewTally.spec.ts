import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeOverviewTally } from '../../../src/client/components/overviewTally'
import { nameColorOf } from '../../../src/client/nameColor'
import { click, makeKit, mount, query, queryAll, text } from '../helpers/kit'
import { statOf } from '../overview.fixtures'

const Tally = makeOverviewTally(makeKit('en'))

const NOW = Date.UTC(2026, 8, 20, 12)

describe('OverviewTally', () => {
  test('a tool card renders the tally rows with the shared row parts and the tool summary', async () => {
    const m = await mount(h(Tally, {
      kind: 'tool',
      stats: [statOf('read', 8, NOW - 3600_000, 3), statOf('bash', 2, NOW - 40_000)],
      now: NOW,
    }))
    assert.equal(text(query(m.container, '.lc-card-title-text')), 'Tool Calls')
    assert.ok(text(query(m.container, '.lc-ov-tally-sub')).includes('2 tools · 10 calls'))
    const rows = queryAll<HTMLButtonElement>(m.container, 'button.lc-ov-tally')
    assert.equal(rows.length, 2)
    assert.equal(text(query(rows[0], '.lc-ov-tally-name')), 'read')
    assert.equal(text(query(rows[0], '.lc-ov-tally-count')), '×8')
    assert.equal(text(query(rows[0], '.lc-ov-tally-last')), '1h ago')
    assert.ok(query<HTMLElement>(rows[0], '.lc-ov-tally-dot').getAttribute('style')?.includes(nameColorOf('read')))
    assert.ok(query<HTMLElement>(rows[0], '.lc-ov-tally-bar').getAttribute('style')?.includes('calc(100% - 12px)'))
    assert.ok(query<HTMLElement>(rows[1], '.lc-ov-tally-bar').getAttribute('style')?.includes('calc(25% - 3px)'))
    assert.equal(rows[0].title, '8 calls · 3 sessions')
    assert.equal(rows[0].getAttribute('aria-pressed'), 'false')
    await m.unmount()
  })

  test('a command card speaks in program runs and sessions', async () => {
    const m = await mount(h(Tally, {
      kind: 'command',
      stats: [statOf('git', 4, NOW - 5000), statOf('pnpm', 1, NOW - 10_000)],
      now: NOW,
    }))
    assert.equal(text(query(m.container, '.lc-card-title-text')), 'Command Executions')
    assert.ok(text(query(m.container, '.lc-ov-tally-sub')).includes('2 programs · 5 runs'))
    assert.equal(query<HTMLElement>(m.container, 'button.lc-ov-tally').title, '4 runs · 1 sessions')
    await m.unmount()
  })

  test('a row click relays the pin and the pinned row releases it', async () => {
    const picks: (string | null)[] = []
    const m = await mount(h(Tally, {
      kind: 'tool',
      stats: [statOf('read', 3, NOW), statOf('grep', 1, NOW)],
      selected: 'read',
      onSelect: (name) => { picks.push(name) },
      now: NOW,
    }))
    const rows = queryAll<HTMLButtonElement>(m.container, 'button.lc-ov-tally')
    assert.equal(rows[0].getAttribute('aria-pressed'), 'true')
    await click(rows[1])
    assert.deepEqual(picks, ['grep'])
    await click(rows[0])
    assert.deepEqual(picks, ['grep', null])
    await m.unmount()
  })

  test('an empty scope keeps the summary line and the body note, and the day sub rides the title', async () => {
    const empty = await mount(h(Tally, { kind: 'command', stats: [], day: '2026-09-19', now: NOW }))
    assert.ok(text(query(empty.container, '.lc-ov-tally-sub')).includes('0 programs · 0 runs'))
    assert.ok(text(query(empty.container, '.lc-card-sub')).includes('2026-09-19'))
    assert.ok(text(empty.container).includes('No commands in this range'))
    assert.equal(queryAll(empty.container, 'button.lc-ov-tally').length, 0)
    await empty.unmount()
  })

  test('the row list caps at 24 with a more note; the summary still counts every tally', async () => {
    const stats = Array.from({ length: 30 }, (_, i) => statOf(`tool-${i}`, 30 - i, NOW - i * 1000))
    const m = await mount(h(Tally, { kind: 'tool', stats, now: NOW }))
    assert.equal(queryAll(m.container, 'button.lc-ov-tally').length, 24)
    assert.ok(text(query(m.container, '.lc-ov-tally-more')).includes('6 more tools'))
    assert.ok(text(query(m.container, '.lc-ov-tally-sub')).includes('30 tools · 465 calls'))
    await m.unmount()

    const commands = await mount(h(Tally, { kind: 'command', stats, now: NOW }))
    assert.ok(text(query(commands.container, '.lc-ov-tally-more')).includes('6 more programs'))
    await commands.unmount()
  })
})
