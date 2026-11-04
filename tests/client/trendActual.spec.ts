import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { actualMaxOf, actualOf } from '../../src/client/trendActual'
import type { RequestRecord } from '../../src/shared/types'

function req(over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    time: 1700000000000, seq: 1, turn: 1, step: 0,
    system: 100, tools: 50, user: 30, inject: 20, assistant: 40, tool: 60, total: 300,
    ...over,
  }
}

describe('actualOf', () => {
  test('a request that reported usage answers its provider prompt', () => {
    assert.equal(actualOf(req({ prompt: 800 })), 800)
  })

  test('a request without a usable prompt answers nothing', () => {
    assert.equal(actualOf(req()), null, 'no usage')
    assert.equal(actualOf(req({ prompt: Number.NaN })), null, 'a broken prompt')
    assert.equal(actualOf(req({ prompt: 0 })), null, 'a zero prompt')
    assert.equal(actualOf(req({ prompt: -10 })), null, 'a negative prompt')
  })
})

describe('actualMaxOf', () => {
  test('the tallest provider prompt sets the scale', () => {
    assert.equal(actualMaxOf([req({ prompt: 800 }), req({ prompt: 1200 }), req({ prompt: 400 })]), 1200)
  })

  test('a session that never reported usage has no scale to offer', () => {
    assert.equal(actualMaxOf([req(), req({ prompt: 0 })]), 0)
    assert.equal(actualMaxOf([]), 0)
  })
})
