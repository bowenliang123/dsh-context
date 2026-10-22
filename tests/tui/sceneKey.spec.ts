import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { BrowserRow } from '../../src/tui/browser'
import { initialSceneState, sceneDefaultsOf, sceneKey, sceneTabOf, type SceneCounts, type SceneState } from '../../src/tui/scene'

const counts: SceneCounts = { columns: 4, rows: [], events: 3, files: 2, page: 10 }
const start = initialSceneState({ granularity: 'step', fileSort: 'count' }, undefined)

function on(tab: SceneState['tab'], over: Partial<SceneState> = {}): SceneState {
  return { ...start, tab, ...over }
}

function next(state: SceneState, input: string, key = {}, c: SceneCounts = counts): SceneState {
  const result = sceneKey(state, input, key, c)
  assert.ok(typeof result === 'object' && !('openFile' in result), `expected a state for ${JSON.stringify([input, key])}`)
  return result
}

describe('scene keyboard', () => {
  test('Esc and q close; Tab, Shift+Tab and 1-5 switch tabs; anything else on a tab without it is ignored', () => {
    assert.equal(sceneKey(start, '', { escape: true }, counts), 'close')
    assert.equal(sceneKey(start, 'q', {}, counts), 'close')
    assert.equal(next(start, '', { tab: true }).tab, 'trend')
    assert.equal(next(start, '', { tab: true, shift: true }).tab, 'files')
    assert.equal(next(start, '3').tab, 'browser')
    assert.equal(sceneKey(start, '6', {}, counts), undefined)
    assert.equal(sceneKey(start, '12', {}, counts), undefined)
    assert.equal(sceneKey(start, 'x', {}, counts), undefined)
  })

  test('trend: ←/→ walk the columns (→ off the end follows the newest), Home/End, t toggles the granularity', () => {
    const trend = on('trend')
    const left = next(trend, '', { leftArrow: true })
    assert.deepEqual([left.column, left.live], [2, false])
    assert.equal(next(left, '', { rightArrow: true }).column, 3)
    assert.equal(next(on('trend', { column: 3 }), '', { rightArrow: true }).column, null)
    assert.equal(next(on('trend', { column: 0 }), '', { leftArrow: true }).column, 0)
    assert.equal(next(trend, '', { home: true }).column, 0)
    assert.equal(next(on('trend', { column: 1 }), '', { end: true }).column, null)
    const turned = next(on('trend', { column: 1 }), 't')
    assert.deepEqual([turned.granularity, turned.column], ['turn', null])
    assert.equal(next(turned, 't').granularity, 'step')
    assert.equal(sceneKey(trend, 'z', {}, counts), undefined)
  })

  test('browser: ↑/↓ move, Enter toggles a category or an item, l toggles live', () => {
    const category = { kind: 'category', id: 'cat:user' } as BrowserRow
    const preview = { kind: 'line', id: 'node:1:0', itemId: 'node:1', text: 'x' } as BrowserRow
    const rows: SceneCounts = { ...counts, rows: [category, { kind: 'item', id: 'node:1' } as BrowserRow, preview] }
    const browser = on('browser')
    assert.equal(next(browser, '', { downArrow: true }, rows).browserCursor, 1)
    assert.equal(next(on('browser', { browserCursor: 2 }), '', { downArrow: true }, rows).browserCursor, 2)
    assert.equal(next(browser, '', { upArrow: true }, rows).browserCursor, 0)
    const opened = next(browser, '', { return: true }, rows)
    assert.ok(opened.expanded.has('cat:user'))
    assert.ok(!next(opened, '', { return: true }, rows).expanded.has('cat:user'))
    const folded = next(on('browser', { browserCursor: 2, expanded: new Set(['node:1']) }), '', { return: true }, rows)
    assert.deepEqual([folded.expanded.has('node:1'), folded.browserCursor], [false, 1], 'a preview line folds its item and lands on it')
    assert.equal(sceneKey(browser, '', { return: true }, counts), undefined, 'no rows')
    const stepped = next(on('browser', { browserCursor: 2 }), 'l', {}, rows)
    assert.deepEqual([stepped.live, stepped.browserCursor], [false, 0])
    assert.equal(next(browser, '', { downArrow: true }, counts).browserCursor, 0, 'an empty tree clamps')
  })

  test('events: ↑/↓ move, f cycles the kind filter through every kind and back', () => {
    const events = on('events')
    assert.equal(next(events, '', { downArrow: true }).eventCursor, 1)
    let state = on('events', { eventCursor: 2 })
    const kinds: unknown[] = []
    for (let i = 0; i < 6; i++) {
      state = next(state, 'f')
      kinds.push(state.eventKind)
      assert.equal(state.eventCursor, 0)
    }
    assert.deepEqual(kinds, ['inject', 'compaction', 'prune', 'model', 'mode', undefined])
    assert.equal(sceneKey(events, 'z', {}, counts), undefined)
  })

  test('files: ↑/↓ move, s cycles the sort, Enter asks to open the selected file', () => {
    const files = on('files')
    assert.equal(next(files, '', { downArrow: true }).fileCursor, 1)
    assert.equal(next(files, 's').fileSort, 'lines')
    assert.equal(next(on('files', { fileSort: 'name' }), 's').fileSort, 'count')
    assert.deepEqual(sceneKey(on('files', { fileCursor: 1 }), '', { return: true }, counts), { openFile: 1 })
    assert.equal(sceneKey(files, '', { return: true }, { ...counts, files: 0 }), undefined)
    assert.equal(sceneKey(files, 'z', {}, counts), undefined)
  })

  test('a cursor left past a shrunken list moves and acts from its last row', () => {
    const rows = { ...counts, rows: [{ kind: 'category', id: 'cat:user' } as BrowserRow, { kind: 'category', id: 'cat:tool' } as BrowserRow] }
    assert.equal(next(on('browser', { browserCursor: 100 }), '', { upArrow: true }, rows).browserCursor, 0)
    assert.equal(next(on('browser', { browserCursor: 100 }), '', { downArrow: true }, rows).browserCursor, 1)
    assert.ok(next(on('browser', { browserCursor: 100 }), '', { return: true }, rows).expanded.has('cat:tool'))
    assert.equal(next(on('events', { eventCursor: 9 }), '', { upArrow: true }).eventCursor, 1)
    assert.deepEqual(sceneKey(on('files', { fileCursor: 7 }), '', { return: true }, counts), { openFile: 1 })
  })

  test('PgUp/PgDn move a page, clamped to the list', () => {
    const long: SceneCounts = { ...counts, events: 25, page: 10 }
    assert.equal(next(on('events'), '', { pageDown: true }, long).eventCursor, 10)
    assert.equal(next(on('events', { eventCursor: 20 }), '', { pageDown: true }, long).eventCursor, 24)
    assert.equal(next(on('events', { eventCursor: 5 }), '', { pageUp: true }, long).eventCursor, 0)
    assert.equal(next(on('files'), '', { pageDown: true }).fileCursor, 1)
  })

  test('stored preferences parse into scene defaults, anything else taking the schema default', () => {
    assert.deepEqual(sceneDefaultsOf({ granularity: 'turn', fileSort: 'lines' }), { granularity: 'turn', fileSort: 'lines' })
    assert.deepEqual(sceneDefaultsOf({ granularity: { get: () => 'turn' }, fileSort: 'bogus' }), { granularity: 'step', fileSort: 'count' })
    assert.deepEqual(sceneDefaultsOf({}), { granularity: 'step', fileSort: 'count' })
  })

  test('the overview has no keys of its own', () => {
    assert.equal(sceneKey(start, '', { downArrow: true }, counts), undefined)
  })

  test('tab names parse leniently from command input and params', () => {
    assert.equal(sceneTabOf(' Trend '), 'trend')
    assert.equal(sceneTabOf('files'), 'files')
    assert.equal(sceneTabOf('nope'), undefined)
    assert.equal(sceneTabOf(''), undefined)
    assert.equal(sceneTabOf(7), undefined)
    assert.equal(initialSceneState({ granularity: 'turn', fileSort: 'path' }, 'events').tab, 'events')
  })
})
