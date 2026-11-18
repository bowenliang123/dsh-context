import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  hostSessionFromMaterialization,
  materializedSessionOf,
  parseSessionMaterialization,
  revisionOf,
  stableHashOf,
  type HeaderFacts,
  type SessionMaterialization,
} from '../../src/host/overviewCorpus'
import { activityOf, currentOf } from '../../src/host/overviewDecode'

const facts: HeaderFacts = {
  id: 'session-a',
  createdAt: 10,
  cwd: '/repo/project',
  parentSession: 'parent',
  origin: 'subagent',
}

function block(): { asOfSeq: number; values: Record<string, unknown> } {
  return {
    asOfSeq: 8,
    values: {
      contextTimeline: {
        ok: true,
        current: {
          system: 1, tools: 2, user: 3, inject: 0, skill: 0, assistant: 4, tool: 5, total: 15,
        },
        counts: { turns: 2, steps: 3, injects: 0, compactions: 0, prunes: 0 },
        contextWindow: 128000,
        maxOutputTokens: 8192,
        model: 'model',
        lastUser: 'prompt',
        timing: {
          wallMs: 100,
          ttftMs: 10,
          genMs: 80,
          calls: 1,
          toolsMs: 20,
          toolCalls: 1,
          tools: { bash: { calls: 1, ms: 20 } },
          reasoningMs: 5,
          toolBusyMs: 60,
        },
        generatedReasoning: 1,
        generatedAnswerTokens: 2,
        generatedCallTokens: 3,
        costRead: { usd: 1, ready: true },
      },
      contextActivity: { days: { '2026-11-01': { tokens: 15, requests: 1 } } },
      title: 'Title',
      sessionListMetadata: { blank: false, lastPromptAt: 20 },
    },
  }
}

describe('session materialization', () => {
  test('derives one shared host graph and strips serve-time pricing reads', () => {
    const session = materializedSessionOf(facts.id, facts, 'signature', block())
    assert.ok(session.materialization !== undefined)
    assert.equal(session.id, facts.id)
    assert.equal(session.title, 'Title')
    assert.equal(session.updatedAt, 20)
    assert.equal(session.parentSession, 'parent')
    assert.equal(session.origin, 'subagent')
    assert.equal(session.timeline?.total, 15)
    assert.equal(session.timeline?.turns, 2)
    assert.equal(session.timeline?.steps, 3)
    assert.equal(session.timeline?.contextWindow, 128000)
    assert.equal(session.timeline?.maxOutputTokens, 8192)
    assert.equal(session.timeline?.model, 'model')
    assert.equal(session.timeline?.lastUser, 'prompt')
    assert.equal(session.timeline?.generatedReasoning, 1)
    assert.equal(session.timeline?.generatedAnswerTokens, 2)
    assert.equal(session.timeline?.generatedCallTokens, 3)
    const timeline = session.materialization.values.contextTimeline as Record<string, unknown>
    assert.equal('costRead' in timeline, false)
    assert.strictEqual(session.timeline?.current, timeline.current)
    assert.strictEqual(session.timeline?.timing, timeline.timing)
    assert.strictEqual(session.activity, session.materialization.values.contextActivity)
    const parsed = parseSessionMaterialization(session.materialization)
    assert.ok(parsed !== undefined)
    assert.deepEqual(hostSessionFromMaterialization(parsed), session)
  })

  test('falls back to an uncacheable host session for invalid or absent projections', () => {
    const invalid = block()
    invalid.values.contextActivity = { days: { bad: { tokens: 'bad' } } }
    const session = materializedSessionOf(facts.id, facts, 'signature', invalid)
    assert.equal(session.materialization, undefined)
    assert.equal(session.timeline?.total, 15)
    assert.deepEqual(session.activity, { days: { bad: { tokens: 0, requests: 0 } } })
    const missing = materializedSessionOf(facts.id, { ...facts, parentSession: undefined, origin: undefined }, 'signature', null)
    assert.equal(missing.timeline, null)
    assert.equal(missing.activity, null)
    assert.equal(missing.parentSession, undefined)
    assert.equal(missing.origin, undefined)
  })

  test('uses header facts for title and time defaults', () => {
    const input = block()
    delete input.values.title
    delete input.values.sessionListMetadata
    const session = materializedSessionOf(facts.id, facts, 'signature', input)
    assert.equal(session.title, 'project')
    assert.equal(session.updatedAt, 10)
    assert.equal(session.blank, false)
    assert.ok(session.materialization !== undefined)
    const timeline = session.materialization.values.contextTimeline as { counts: { steps?: number } }
    delete timeline.counts.steps
    assert.equal(hostSessionFromMaterialization(session.materialization).timeline?.steps, undefined)
  })

  test('rejects malformed persisted facts, watermarks, and projection values', () => {
    const valid = materializedSessionOf(facts.id, facts, 'signature', block()).materialization
    assert.ok(valid !== undefined)
    const mutations: ((value: NonNullable<typeof valid>) => void)[] = [
      value => { value.asOfSeq = null as never },
      value => { value.asOfSeq = 1.5 },
      value => { value.signature = 7 as never },
      value => { value.facts.id = '' },
      value => { value.facts.createdAt = Number.NaN },
      value => { value.facts.cwd = '' },
      value => { value.facts.parentSession = 7 as never },
      value => { value.facts.origin = 'fork' as never },
      value => { value.values = 'bad' as never },
      value => { value.values.contextTimeline = null },
      value => { value.values.contextActivity = null },
    ]
    for (const mutate of mutations) {
      const candidate: SessionMaterialization = structuredClone(valid)
      mutate(candidate)
      assert.equal(parseSessionMaterialization(candidate), undefined)
    }
    assert.equal(parseSessionMaterialization(null), undefined)
  })

  test('degrades null decoder inputs and empty tally tables without fabricating values', () => {
    assert.equal(activityOf(null), null)
    assert.equal(activityOf(undefined), null)
    assert.equal(currentOf(null), null)
    assert.equal(currentOf('bad'), null)
    assert.deepEqual(activityOf({
      days: {
        bad: 'nope',
        empty: {
          tokens: 'bad',
          requests: 1,
          skills: { bad: { n: 'bad', last: 1 } },
          tools: {},
          cmds: 'bad',
        },
      },
    }), { days: { empty: { tokens: 0, requests: 1 } } })
  })

  test('keeps revision hashing stable while exposing the shared shard hash', () => {
    assert.equal(revisionOf(['a', 'b']), `r1-${stableHashOf(['a', 'b']).toString(36)}`)
    assert.notEqual(stableHashOf(['a']), stableHashOf(['b']))
    assert.equal(revisionOf([]), 'r1-ztntfp')
  })
})
