import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DEFAULT_BOUNDS } from '../../src/host/config'
import { apply, inject, name } from '../../src/host/index'
import { buildTimelineHead } from '../../src/host/foldWire'
import { kitOf, surfaceFactsOf } from '../../src/tui/detect'
import { CATS } from '../../src/client/categories'
import { DICT_EN, DICT_ZH } from '../../src/client/i18n'
import { TUI_EN, TUI_ZH, langOf, translatorOf } from '../../src/tui/i18n'
import { EVENT_KINDS } from '../../src/client/eventText'
import { FILE_SORTS } from '../../src/client/fileActivity'
import { SCENE_TABS } from '../../src/tui/scene'
import { createContextSource, createDetailReader } from '../../src/tui/source'
import type { ContextTimelineDetail } from '../../src/shared/types'
import { fakeKit, fakeWatch, headersFixture, panelUi, timelineFixture } from './helpers'

describe('kitOf', () => {
  test('the kit only when every drawn member is present; memo components (objects) count', () => {
    assert.equal(kitOf(panelUi), panelUi)
    assert.ok(kitOf({ ...panelUi, Table: { $$typeof: Symbol.for('react.memo') } as never }) !== undefined)
    assert.equal(kitOf({ Box: panelUi.Box, Text: panelUi.Text }), undefined, 'an older host: no kit at all')
    assert.equal(kitOf({ ...panelUi, Legend: null as never }), undefined)
    assert.equal(kitOf({ ...panelUi, hashSeries: undefined }), undefined)
    assert.equal(kitOf({ ...panelUi, format: undefined }), undefined)
    assert.equal(kitOf({ ...panelUi, format: { ...fakeKit.format, cells: 1 as never } }), undefined)
  })
})

describe('surfaceFactsOf', () => {
  test('re-proves every snapshot field', () => {
    const facts = surfaceFactsOf({
      snapshot: () => ({
        sessionId: 's9',
        cwd: '/w',
        lang: 'zh-CN',
        usage: {
          occupancy: { usedTokens: 10, contextWindow: 100, source: 'projection' },
          breakdown: { systemTokens: 1, toolsTokens: 2, messageTokens: 3 },
          tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
          cost: { currency: 'USD', amount: 0.5, source: 'estimate' },
        },
      }),
    })
    assert.deepEqual(facts, {
      sessionId: 's9',
      cwd: '/w',
      lang: 'zh',
      usage: {
        occupancy: { usedTokens: 10, contextWindow: 100 },
        breakdown: { systemTokens: 1, toolsTokens: 2, messageTokens: 3 },
        cost: { currency: 'USD', amount: 0.5 },
      },
    })
  })

  test('hostile or absent snapshots degrade field by field, never throw', () => {
    assert.deepEqual(surfaceFactsOf(undefined), { lang: 'en', usage: {} })
    assert.deepEqual(surfaceFactsOf({}), { lang: 'en', usage: {} })
    assert.deepEqual(surfaceFactsOf({ snapshot: () => { throw new Error('boom') } }), { lang: 'en', usage: {} })
    assert.deepEqual(surfaceFactsOf({
      snapshot: () => ({ sessionId: '', cwd: 7, lang: 42, usage: { occupancy: { usedTokens: -1 }, breakdown: { systemTokens: 'x' }, cost: { currency: '', amount: 1 } } }),
    }), { lang: 'en', usage: {} })
    assert.deepEqual(surfaceFactsOf({
      snapshot: () => ({ usage: { occupancy: { usedTokens: 5, contextWindow: 0 }, cost: { currency: 'USD', amount: Number.NaN } } }),
    }), { lang: 'en', usage: { occupancy: { usedTokens: 5 } } })
    assert.deepEqual(surfaceFactsOf({ snapshot: () => ({ usage: { occupancy: 'full', cost: { currency: 'USD', amount: -1 } } }) }), { lang: 'en', usage: {} })
    assert.deepEqual(surfaceFactsOf({ snapshot: () => ({ usage: { occupancy: { usedTokens: Infinity } } }) }), { lang: 'en', usage: {} })
  })
})

describe('i18n', () => {
  test('both locales carry every terminal key with the same placeholders', () => {
    const holes = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
    assert.deepEqual(Object.keys(TUI_EN).sort(), Object.keys(TUI_ZH).sort())
    for (const [key, value] of Object.entries(TUI_ZH)) assert.deepEqual(holes(value), holes(TUI_EN[key as keyof typeof TUI_ZH]), key)
  })

  test('every terminal key a view uses exists in both locales, and every one is used', () => {
    const sources = readdirSync('src/tui').filter(f => f.endsWith('.ts') && f !== 'i18n.ts').map(f => readFileSync(join('src/tui', f), 'utf8'))
    const used = new Set(sources.flatMap(text => [...text.matchAll(/'(tui\.[A-Za-z]+(?:\.[A-Za-z]+)*)'/g)].map(m => m[1])))
    for (const tab of SCENE_TABS) used.add(`tui.tab.${tab}`).add(`tui.hint.${tab}`)
    assert.deepEqual([...used].sort(), Object.keys(TUI_EN).sort())
    assert.deepEqual([...used].sort(), Object.keys(TUI_ZH).sort())
    const composed = [
      ...CATS.map(c => `cat.${c.key}`), ...EVENT_KINDS.map(k => `kind.${k}`), ...FILE_SORTS.map(s => `files.sort.${s}`), 'gran.step', 'gran.turn',
    ]
    for (const key of composed) assert.ok(key in DICT_EN && key in DICT_ZH, key)
  })

  test('the translator layers terminal strings over the client dictionary, interpolates, and falls back to the key', () => {
    const zh = translatorOf('zh')
    assert.equal(zh, translatorOf('zh'), 'one translator per language')
    assert.equal(zh('cat.system'), '系统提示词')
    assert.equal(zh('tui.tab.trend'), '趋势')
    assert.equal(translatorOf('en')('tui.openFailed', { path: 'a/b' }), 'Cannot open a/b')
    assert.equal(translatorOf('en')('no.such.key'), 'no.such.key')
    assert.equal(langOf('ZH-tw'), 'zh')
    assert.equal(langOf('fr'), 'en')
    assert.equal(langOf(undefined), 'en')
  })
})

describe('createContextSource', () => {
  const detail: ContextTimelineDetail = {
    rev: 7,
    requests: timelineFixture().requests,
    events: timelineFixture().events,
    nodes: timelineFixture().nodes,
    droppedNodes: 1,
    archive: [],
    surfaceFloor: 2,
    archiveFloor: 1,
    fileOps: timelineFixture().fileOps,
    fileOpsFloor: 3,
    spans: [],
  }

  test('an inline value passes through re-proved; the read is reference-stable until a raw value moves', () => {
    const timeline = fakeWatch(timelineFixture())
    const headers = fakeWatch(headersFixture())
    const source = createContextSource(timeline, headers, () => assert.fail('an inline value never reads the detail'))
    const first = source.read()
    assert.equal(first.sessionId, 's1')
    assert.equal(first.partial, false)
    assert.equal(first.timeline?.requests.length, 3)
    assert.equal(first.headers?.headers.length, 1)
    assert.equal(source.read(), first)
    let pings = 0
    const off = source.subscribe(() => { pings++ })
    headers.set(null)
    assert.notEqual(source.read(), first)
    assert.equal(source.read().headers, null)
    timeline.set(timelineFixture(), 's2')
    assert.equal(source.read().sessionId, 's2')
    assert.equal(pings, 2)
    off()
    assert.equal(timeline.listeners.size + headers.listeners.size, 0)
  })

  test('hostile wire values degrade to the loading state or a sanitized timeline, never a throw', () => {
    const source = createContextSource(fakeWatch('garbage'), undefined, () => null)
    assert.deepEqual(source.read(), { sessionId: 's1', timeline: null, headers: null, partial: false })
    const sanitized = createContextSource(fakeWatch({ current: { total: 'x' }, requests: [null, 3], events: 'no' }), fakeWatch({ headers: [{ tools: 'x' }] }), () => null).read()
    assert.equal(sanitized.timeline?.current.total, 0)
    assert.deepEqual(sanitized.timeline?.requests, [])
    assert.equal(sanitized.headers, null)
    const off = createContextSource(fakeWatch(null), undefined, () => null).subscribe(() => {})
    off()
  })

  test('a slim head merges the in-process detail; an unreadable detail keeps the totals and flags partial', () => {
    const head = { ...timelineFixture(), requests: [], events: [], nodes: [], fileOps: undefined, detailRev: 7 }
    const reads: [string, number][] = []
    const merged = createContextSource(fakeWatch(head), undefined, (sessionId, rev) => {
      reads.push([sessionId, rev])
      return detail
    }).read()
    assert.deepEqual(reads, [['s1', 7]])
    assert.equal(merged.partial, false)
    assert.equal(merged.timeline?.requests.length, 3)
    assert.deepEqual([merged.timeline?.surfaceFloor, merged.timeline?.archiveFloor, merged.timeline?.fileOpsFloor, merged.timeline?.droppedNodes], [2, 1, 3, 1])
    const missing = createContextSource(fakeWatch(head), undefined, () => null).read()
    assert.equal(missing.partial, true)
    assert.equal(missing.timeline?.requests.length, 0)
    const unbound = createContextSource({ ...fakeWatch(head), sessionId: undefined }, undefined, () => assert.fail('no session to read')).read()
    assert.equal(unbound.partial, true)
    const newerHead = { ...head, counts: { turns: 9, steps: 9, injects: 0, compactions: 0, prunes: 0 }, detailRev: 8 }
    const ahead = createContextSource(fakeWatch(head), undefined, () => ({ ...detail, rev: 8, head: newerHead })).read()
    assert.deepEqual(ahead.timeline?.counts, newerHead.counts, 'collections pair with the head of their own cut')
    // A cached payload's head trails a same-revision push that moved head-only fields.
    const cachedHead = { ...head, model: 'older', counts: newerHead.counts }
    const same = createContextSource(fakeWatch(head), undefined, () => ({ ...detail, head: cachedHead })).read()
    assert.equal(same.timeline?.model, head.model)
    assert.deepEqual(same.timeline?.counts, head.counts)
  })
})

describe('createDetailReader (in-process, the code behind the detail route)', () => {
  async function boot() {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin({ name, inject, apply } as never, {} as never)
    return ctx
  }

  test('builds the live session detail from the registry state and caches it per revision', async () => {
    const ctx = await boot()
    const session = ctx.sessions.create()
    session.append('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } as never, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 0, message: { content: [{ type: 'text', text: 'hello' }] }, usage: { inputTokens: 10, outputTokens: 5 },
    } as never, { surfaceOp: 'append' })
    const read = createDetailReader(ctx, DEFAULT_BOUNDS)
    const state = ctx.sessionProjections.stateOf(session, 'contextTimeline')
    assert.ok(state !== undefined)
    const rev = buildTimelineHead(state).detailRev ?? 0
    const detail = read(session.id, rev)
    assert.ok(detail !== null)
    assert.equal(detail.nodes.length, 2)
    assert.equal(detail.rev, rev)
    assert.deepEqual(detail.head, buildTimelineHead(state))
    assert.equal(read(session.id, rev), detail, 'same revision, same payload')
    assert.equal(read('nope', rev), null, 'not a live session')
    // A head pushed before the latest append asks for an older revision: a cached payload of exactly that revision still
    // pairs with it, and an uncached read answers at the state's own, newer cut.
    session.append('user/message', { content: [{ type: 'text', text: 'more' }], source: { kind: 'user' } } as never, { surfaceOp: 'append' })
    assert.equal(read(session.id, rev), detail)
    const fresh = createDetailReader(ctx, DEFAULT_BOUNDS)
    const ahead = fresh(session.id, rev)
    assert.ok(ahead !== null)
    assert.ok(ahead.rev > rev, 'the payload carries the revision it was folded at')
    assert.equal(ahead.nodes.length, 3)
    assert.equal(fresh(session.id, ahead.rev), ahead, 'cached under its own revision')
  })

  test('no sessions service, a hostile one, or an unregistered unit read as null', async () => {
    const bare = new Context()
    await bare.plugin(SessionProjectionRegistry)
    assert.equal(createDetailReader(bare, DEFAULT_BOUNDS)('s', 0), null)
    const hostile = new Context()
    hostile.provide('sessions', { get: () => { throw new Error('boom') } })
    await hostile.plugin(SessionProjectionRegistry)
    assert.equal(createDetailReader(hostile, DEFAULT_BOUNDS)('s', 0), null)
    const unregistered = new Context()
    await unregistered.plugin(SessionStore)
    await unregistered.plugin(SessionProjectionRegistry)
    const session = unregistered.sessions.create()
    assert.equal(createDetailReader(unregistered, DEFAULT_BOUNDS)(session.id, 0), null)
  })
})
