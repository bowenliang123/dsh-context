// The official-listing alias table (src/client/officialPrices.ts): which first-party catalog entry a mirror's model id maps onto.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { officialFaceOf } from '../../src/client/officialPrices'

describe('officialFaceOf', () => {
  test('the GLM-5.3 tiers alias onto z.ai, whatever date suffix the host appends', () => {
    const face = { pid: 'zai', mid: 'glm-5.3-flash' }
    assert.deepEqual(officialFaceOf('glm-5.3-flash'), face)
    assert.deepEqual(officialFaceOf('glm-5-3-flash-260828'), face)
    assert.deepEqual(officialFaceOf('z-ai/glm-5.3-flash'), face)
    assert.deepEqual(officialFaceOf('GLM-5-3-Flash'), face)
    assert.deepEqual(officialFaceOf('glm-5.3-flash-new'), face)
    assert.equal(officialFaceOf('glm-5.3-flashx'), null, 'a distinct model is not a suffix variant')
    assert.deepEqual(officialFaceOf('glm-5.3'), { pid: 'zai', mid: 'glm-5.3' }, 'the non-flash tier has its own first-party listing')
    assert.equal(officialFaceOf('glm-5.3-highspeed'), null, 'a repriced tier is its own listing')
    assert.equal(officialFaceOf('z-ai/glm-5.3-flash-apex'), null, 'a repriced variant is its own listing')
  })

  test('DeepSeek flash aliases onto deepseek, keeping the deliberate version segment', () => {
    const face = { pid: 'deepseek', mid: 'deepseek-flash' }
    assert.deepEqual(officialFaceOf('deepseek-flash'), face)
    assert.deepEqual(officialFaceOf('deepseek-v4.1-flash'), face)
    assert.deepEqual(officialFaceOf('DeepSeek-V4.1-Flash-1017'), face)
    assert.deepEqual(officialFaceOf('deepseek-v4.1-flash-1017'), face)
    assert.deepEqual(officialFaceOf('DeepSeek-V4.1-Flash-1017-New'), face, 'a host release tag still prices the vendor listing')
    assert.deepEqual(officialFaceOf('deepseek-v4-1-flash-261017'), face, 'a hyphenated version segment is the same model')
    assert.equal(officialFaceOf('deepseek-v4-pro'), null)
  })

  test('Claude Sonnet 5.5 aliases onto anthropic, dot or dash, and any @variant suffix', () => {
    const face = { pid: 'anthropic', mid: 'claude-sonnet-5-5' }
    assert.deepEqual(officialFaceOf('claude-sonnet-5-5'), face)
    assert.deepEqual(officialFaceOf('claude-sonnet-5.5'), face)
    assert.deepEqual(officialFaceOf('anthropic/claude-sonnet-5.5'), face)
    assert.deepEqual(officialFaceOf('claude-sonnet-5.5@default'), face)
    assert.equal(officialFaceOf('claude-opus-5-5'), null)
    assert.equal(officialFaceOf('claude-sonnet-5'), null)
  })

  test('an id no mirror renamed has no alias, so it keeps its own listing', () => {
    assert.equal(officialFaceOf('gpt-6.1-sol'), null)
    assert.equal(officialFaceOf('gemini-3.8-flash'), null)
    assert.equal(officialFaceOf(''), null)
  })
})
