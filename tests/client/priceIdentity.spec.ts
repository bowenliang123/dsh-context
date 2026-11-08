import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  bareModelOf,
  familyVendorOf,
  isSubscriptionPlanProvider,
  labOf,
  lowerModelId,
  normalizeModelId,
  orgOf,
  suffixKeys,
} from '../../src/shared/priceIdentity'

describe('path helpers', () => {
  test('lowercases and trims the lookup key', () => {
    assert.equal(lowerModelId('  Claude-Sonnet-4.5 '), 'claude-sonnet-4.5')
  })

  test('bareModelOf keeps the last segment', () => {
    assert.equal(bareModelOf('anthropic/claude-sonnet-5'), 'claude-sonnet-5')
    assert.equal(bareModelOf('openrouter/anthropic/claude-sonnet-5'), 'claude-sonnet-5')
    assert.equal(bareModelOf('/claude-sonnet-5'), 'claude-sonnet-5')
    assert.equal(bareModelOf('claude-sonnet-5'), 'claude-sonnet-5')
  })

  test('orgOf returns the first segment only when there is one', () => {
    assert.equal(orgOf('google-vertex/gemini-4-argon'), 'google-vertex')
    assert.equal(orgOf('openrouter/anthropic/claude'), 'openrouter')
    assert.equal(orgOf('gemini-4-argon'), undefined)
    assert.equal(orgOf('/gemini-4-argon'), undefined)
  })

  test('labOf reads the lab from a canonical id', () => {
    assert.equal(labOf('anthropic/claude-sonnet-5'), 'anthropic')
    assert.equal(labOf('claude-sonnet-5'), undefined)
    assert.equal(labOf('/claude-sonnet-5'), undefined)
  })
})

describe('normalizeModelId', () => {
  test('strips gateway paths, billing variants, and resource decorations', () => {
    assert.equal(normalizeModelId('workers-ai/@cf/zai-org/GLM-5.2:free@default'), 'zai-org/glm-5-2:free')
    assert.equal(normalizeModelId('accounts/fireworks/models/deepseek-v4p1-flash'), 'deepseek-v4-1-flash')
    assert.equal(normalizeModelId('accounts/fireworks/routers/kimi-k3-fast'), 'kimi-k3-fast')
    assert.equal(normalizeModelId('hf:zai-org/GLM-5.2'), 'zai-org/glm-5-2')
    assert.equal(normalizeModelId('global.anthropic.claude-opus-4-6-v1:0'), 'anthropic-claude-opus-4-6')
    assert.equal(normalizeModelId('us.anthropic.claude-opus-4-6-v1:0'), 'anthropic-claude-opus-4-6')
    assert.equal(normalizeModelId('eu.mistral-large'), 'mistral-large')
    assert.equal(normalizeModelId('apac.gemini-2.5-pro'), 'gemini-2-5-pro')
    assert.equal(normalizeModelId('claude-sonnet-4-5@20250929'), 'claude-sonnet-4-5')
    assert.equal(normalizeModelId('claude-sonnet-4-5@default'), 'claude-sonnet-4-5')
    assert.equal(normalizeModelId('gpt-5.6-sol-20260709'), 'gpt-5-6-sol')
    assert.equal(normalizeModelId('gpt-5.6-sol-260709'), 'gpt-5-6-sol')
    assert.equal(normalizeModelId('claude-sonnet-4.5'), 'claude-sonnet-4-5')
    assert.equal(normalizeModelId('claude-sonnet-4.5:free'), 'claude-sonnet-4-5:free')
    assert.equal(normalizeModelId('claude-sonnet-4.5:batch'), 'claude-sonnet-4-5:batch')
    assert.equal(normalizeModelId('claude-sonnet-4.5-latest'), 'claude-sonnet-4-5')
    assert.equal(normalizeModelId('deepseek-v4p1-flash'), 'deepseek-v4-1-flash')
    assert.equal(normalizeModelId('__weird__--model__'), 'weird-model')
  })
})

describe('suffix and form helpers', () => {
  test('suffixKeys emits slash/dash tails', () => {
    assert.deepEqual(suffixKeys('kimi-k3'), ['k3'])
    assert.deepEqual(suffixKeys('anthropic/claude-fable-5'), ['claude-fable-5', 'fable-5', '5'])
    assert.deepEqual(suffixKeys('a-a'), ['a'])
    assert.deepEqual(suffixKeys('single'), [])
  })

})

describe('isSubscriptionPlanProvider', () => {
  test('recognizes plan branches but not ordinary routes or subscription products', () => {
    assert.equal(isSubscriptionPlanProvider('kimi-code-plan-global'), true)
    assert.equal(isSubscriptionPlanProvider('zai-coding-plan'), true)
    assert.equal(isSubscriptionPlanProvider('alibaba-token-plan-cn'), true)
    assert.equal(isSubscriptionPlanProvider('xiaomi-token-plan-ams'), true)
    assert.equal(isSubscriptionPlanProvider('kimi-coding'), false)
    assert.equal(isSubscriptionPlanProvider('opencode'), false)
    assert.equal(isSubscriptionPlanProvider('github-copilot'), false)
    assert.equal(isSubscriptionPlanProvider('moonshotai'), false)
  })
})

describe('familyVendorOf', () => {
  test('maps mainstream families to their maker; unknown families have no vendor hint', () => {
    assert.equal(familyVendorOf('anthropic/claude-sonnet-4.5'), 'anthropic')
    assert.equal(familyVendorOf('openai/gpt-5.6-sol'), 'openai')
    assert.equal(familyVendorOf('o1-preview'), 'openai')
    assert.equal(familyVendorOf('gemini-4-argon'), 'google')
    assert.equal(familyVendorOf('gemma-3-27b'), 'google')
    assert.equal(familyVendorOf('deepseek-v4-pro'), 'deepseek')
    assert.equal(familyVendorOf('kimi-k3'), 'moonshotai')
    assert.equal(familyVendorOf('z-ai/glm-5.3'), 'zhipuai')
    assert.equal(familyVendorOf('Qwen3.8-Max'), 'alibaba')
    assert.equal(familyVendorOf('x-ai/grok-4.6'), 'xai')
    assert.equal(familyVendorOf('meta-llama/Llama-4'), 'meta')
    assert.equal(familyVendorOf('MiniMax-M2.5'), 'minimax')
    assert.equal(familyVendorOf('mimo-v2.5'), 'xiaomi')
    assert.equal(familyVendorOf('mistral-large'), 'mistral')
    assert.equal(familyVendorOf('codestral-2'), 'mistral')
    assert.equal(familyVendorOf('pixtral-large'), 'mistral')
    assert.equal(familyVendorOf('command-a'), 'cohere')
    assert.equal(familyVendorOf('nemotron-4'), 'nvidia')
    assert.equal(familyVendorOf('k3'), undefined)
    assert.equal(familyVendorOf('mystery-model'), undefined)
  })
})
