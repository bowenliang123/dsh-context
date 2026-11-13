import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { type TimelineEvent } from '../../src/host/fold'
import type { MessageSource } from '../../src/host/pricing'
import { at, stepStart, userMessage } from './helpers/events'
import { assertStable, driveTimeline, timelineDef } from './helpers/projection'

describe('injection agent labels', () => {
  const text = (t: string) => [{ type: 'text', text: t }]
  const catalogEvent = (seq: number, childId: string, data: Record<string, unknown> = {}): TimelineEvent => ({
    type: 'subagent/catalog', seq, time: at(), data: { childId, ...data },
  })
  const memberEvent = (seq: number, id: string, name: unknown): TimelineEvent => ({
    type: 'team/member', seq, time: at(), data: { member: { id, name } },
  })
  const injected = (seq: number, source: MessageSource, content = 'hi'): TimelineEvent =>
    userMessage(seq, text(content), source)

  test('relay text names the sender; id-shaped tokens and non-relay kinds never name one', () => {
    const state = driveTimeline([
      injected(1, { kind: 'agent-message', form: 'relay', senderSessionId: 'sid-1' }, 'Agent explorer sent a message: hi'),
    ]).state
    assert.equal(state.events[0].agent, 'explorer')
    assert.equal(state.surface.find(n => n.seq === 1)?.agent, 'explorer')
    const guarded = driveTimeline([
      injected(1, { kind: 'agent-message', form: 'relay', senderSessionId: 'sid-1' }, 'Agent sid-1 sent a message: hi'),
    ]).state
    assert.ok(!('agent' in guarded.events[0]))
    assert.ok(!('agent' in guarded.surface.find(n => n.seq === 1)!))
    const noSenderId = driveTimeline([
      injected(1, { kind: 'agent-message', form: 'relay' }, 'Agent explorer sent a message: hi'),
    ]).state
    assert.equal(noSenderId.events[0].agent, 'explorer')
    const unrelated = driveTimeline([
      injected(1, { kind: 'plugin', form: 'notice', plugin: 'p' }, 'Agent explorer sent a message: hi'),
    ]).state
    assert.ok(!('agent' in unrelated.events[0]))
    const hostile = driveTimeline([
      injected(1, { kind: 42, form: 'notice', summary: 'x' } as never, 'note'),
    ]).state
    assert.ok(!('agent' in hostile.events[0]))
    const legacy = driveTimeline([
      catalogEvent(1, 'sid-1', { mode: 'continuable', label: 'Investigate flaky test' }),
      injected(2, { kind: 'coordinator', form: 'relay', senderSessionId: 'sid-1' }, 'Agent sid-1 sent a message: hi'),
    ]).state
    assert.ok(!('agent' in legacy.events[0]))
  })

  test('settled notices prefer the text name, fall back to the summary, or stay unnamed', () => {
    const named = driveTimeline([
      injected(1, {
        kind: 'subagent-settled', form: 'notice',
        summary: 'Background subagent child-1 finished.', senderSessionId: 'child-1',
      }, 'Background subagent explorer finished.'),
    ]).state
    assert.equal(named.events[0].agent, 'explorer')
    assert.equal(named.events[0].detail, 'Background subagent child-1 finished.')
    const summaryFallback = driveTimeline([
      injected(1, {
        kind: 'subagent-settled', form: 'notice',
        summary: 'Background subagent explorer finished.', senderSessionId: 'child-1',
      }, 'closing note'),
    ]).state
    assert.equal(summaryFallback.events[0].agent, 'explorer')
    const noSummary = driveTimeline([
      injected(1, { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-1' }, 'closing note'),
    ]).state
    assert.ok(!('agent' in noSummary.events[0]))
    const unmatched = driveTimeline([
      injected(1, {
        kind: 'subagent-settled', form: 'notice', summary: 'Other.', senderSessionId: 'child-1',
      }, 'closing note'),
    ]).state
    assert.ok(!('agent' in unmatched.events[0]))
  })

  test('node labels outlive the event retention window', () => {
    const drive = driveTimeline([
      injected(1, { kind: 'agent-message', form: 'relay', senderSessionId: 'sid-1' }, 'Agent explorer-1 sent a message: hi'),
      injected(2, { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-2' }, 'Background subagent explorer-2 finished.'),
    ], { maxEvents: 1 })
    assert.equal(drive.state.events.length, 1)
    assert.equal(drive.state.surface.find(n => n.seq === 1)?.agent, 'explorer-1')
    assert.equal(drive.state.surface.find(n => n.seq === 2)?.agent, 'explorer-2')
  })

  test('catalog name beats team name beats label; repeated facts merge', () => {
    const named = driveTimeline([
      catalogEvent(1, 'sid-1', { mode: 'continuable', name: 'explorer', label: 'Investigate flaky test' }),
      memberEvent(2, 'sid-1', 'worker'),
      injected(3, { kind: 'agent-message', form: 'relay', senderSessionId: 'sid-1' }, 'Agent sid-1 sent a message: hi'),
    ]).state
    assert.equal(named.events[0].agent, 'explorer')
    const nameOnly = driveTimeline([
      catalogEvent(1, 'sid-3', { mode: 'continuable', name: 'explorer' }),
      injected(2, { kind: 'agent-message', form: 'relay', senderSessionId: 'sid-3' }, 'hi'),
    ]).state
    assert.equal(nameOnly.events[0].agent, 'explorer')
    const team = driveTimeline([
      catalogEvent(1, 'sid-1', { mode: 'continuable', label: 'Investigate flaky test' }),
      memberEvent(2, 'sid-1', 'worker'),
      injected(3, { kind: 'agent-message', form: 'relay', senderSessionId: 'sid-1' }, 'Agent sid-1 sent a message: hi'),
    ]).state
    assert.equal(team.events[0].agent, 'worker')
    const label = driveTimeline([
      catalogEvent(1, 'sid-1', { mode: 'continuable', label: 'Investigate flaky test' }),
      injected(2, { kind: 'agent-message', form: 'relay', senderSessionId: 'sid-1' }, 'hi'),
    ]).state
    assert.equal(label.events[0].agent, 'Investigate flaky test')
    const other = driveTimeline([
      catalogEvent(1, 'sid-1', { mode: 'continuable', label: 'Investigate flaky test' }),
      injected(2, { kind: 'agent-message', form: 'relay', senderSessionId: 'sid-2' }, 'Agent sid-2 sent a message: hi'),
    ]).state
    assert.ok(!('agent' in other.events[0]))
  })

  test('alias lookup never reads inherited properties, while own entries still resolve', () => {
    const inherited = driveTimeline([
      catalogEvent(1, 'sid-1', { mode: 'continuable', label: 'x' }),
      injected(2, { kind: 'agent-message', form: 'relay', senderSessionId: 'toString' }, 'Agent toString sent a message: hi'),
    ]).state
    assert.ok(!('agent' in inherited.events[0]))
    const own = driveTimeline([
      catalogEvent(1, 'toString', { mode: 'continuable', label: 'worker' }),
      injected(2, { kind: 'agent-message', form: 'relay', senderSessionId: 'toString' }, 'Agent toString sent a message: hi'),
    ]).state
    assert.equal(own.events[0].agent, 'worker')
  })

  test('team messages use the assigned name, or the alias when it is absent or id-shaped', () => {
    const assigned = driveTimeline([
      injected(1, { kind: 'team-message', senderId: 'sid-2', senderName: 'worker' }),
    ]).state
    assert.equal(assigned.events[0].agent, 'worker')
    const fromAlias = driveTimeline([
      catalogEvent(1, 'sid-2', { mode: 'continuable', label: 'Investigate flaky test' }),
      injected(2, { kind: 'team-message', senderId: 'sid-2' }),
    ]).state
    assert.equal(fromAlias.events[0].agent, 'Investigate flaky test')
    const idShaped = driveTimeline([
      catalogEvent(1, 'sid-2', { mode: 'continuable', label: 'Investigate flaky test' }),
      injected(2, { kind: 'team-message', senderId: 'sid-2', senderName: 'sid-2' }),
    ]).state
    assert.equal(idShaped.events[0].agent, 'Investigate flaky test')
    const anonymous = driveTimeline([
      injected(1, { kind: 'team-message' }),
    ]).state
    assert.ok(!('agent' in anonymous.events[0]))
  })

  test('session references use their labels, skip id-shaped labels, and summarize multiples', () => {
    const single = driveTimeline([
      injected(1, { kind: 'session-reference', form: 'recall', references: [{ sessionId: 'a', label: 'Alpha' }] }),
    ]).state
    assert.equal(single.events[0].agent, 'Alpha')
    const many = driveTimeline([
      injected(1, {
        kind: 'session-reference', form: 'recall',
        references: [{ label: 'Alpha' }, { label: 'Beta' }, { label: '' }, null],
      }),
    ]).state
    assert.equal(many.events[0].agent, 'Alpha +1')
    const selfLabel = driveTimeline([
      injected(1, { kind: 'session-reference', form: 'recall', references: [{ sessionId: 'a', label: 'a' }] }),
    ]).state
    assert.ok(!('agent' in selfLabel.events[0]))
    const malformed = driveTimeline([
      injected(1, { kind: 'session-reference', form: 'recall', references: 'bad' as never }),
    ]).state
    assert.ok(!('agent' in malformed.events[0]))
  })

  test('unusable catalog and roster facts leave the state untouched', () => {
    const state = driveTimeline([]).state
    for (const event of [
      { type: 'subagent/catalog', seq: 1, time: at() },
      { type: 'subagent/catalog', seq: 1, time: at(), data: {} },
      { type: 'subagent/catalog', seq: 1, time: at(), data: { childId: '' } },
      { type: 'subagent/catalog', seq: 1, time: at(), data: { childId: '__proto__' } },
      { type: 'subagent/catalog', seq: 1, time: at(), data: { childId: 7 } },
      { type: 'subagent/catalog', seq: 1, time: at(), data: { childId: 'sid', name: '', label: 7 } },
      { type: 'team/member', seq: 1, time: at() },
      { type: 'team/member', seq: 1, time: at(), data: {} },
      { type: 'team/member', seq: 1, time: at(), data: { member: null } },
      { type: 'team/member', seq: 1, time: at(), data: { member: { id: '', name: 'x' } } },
      { type: 'team/member', seq: 1, time: at(), data: { member: { id: '__proto__', name: 'x' } } },
      { type: 'team/member', seq: 1, time: at(), data: { member: { id: 7, name: 'x' } } },
      { type: 'team/member', seq: 1, time: at(), data: { member: { id: 'sid' } } },
    ] as TimelineEvent[]) {
      assertStable(state, event)
    }
  })

  test('alias ids cap at 512 and head-only rows drop the map', () => {
    const events: TimelineEvent[] = []
    for (let i = 0; i < 513; i++) {
      events.push(catalogEvent(i + 1, 'agent-' + String(i), { mode: 'continuable', label: 'task ' + String(i) }))
    }
    const capped = driveTimeline(events).state
    assert.equal(capped.agents?.['agent-0']?.catalogLabel, 'task 0')
    assert.equal(capped.agents?.['agent-512'], undefined)
    assert.ok(timelineDef().stateSchema.safeParse(capped).success)
    const head = driveTimeline([catalogEvent(1, 'sid', { mode: 'continuable', label: 'x' })], undefined, true).state
    assert.equal(head.agents, undefined)
    assert.equal(head.events.length, 0)
  })

  test('overlong names are bounded', () => {
    const long = 'a'.repeat(140)
    const state = driveTimeline([
      injected(1, { kind: 'agent-message', form: 'relay', senderSessionId: 'sid' }, `Agent ${long} sent a message: hi`),
    ]).state
    assert.equal(state.events[0].agent?.length, 120)
    assert.ok(state.events[0].agent?.endsWith('…'))
  })

  test('alias-only events never split a step idle gap', () => {
    const state = driveTimeline([
      stepStart(1),
      catalogEvent(2, 'sid', { mode: 'continuable', label: 'x' }),
    ]).state
    assert.equal(state.agents?.['sid']?.catalogLabel, 'x')
    assert.equal(state.stepBeats, undefined)
  })
})
