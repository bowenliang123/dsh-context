import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { remoteStateOf } from '../../../src/client/components/useRemoteState'

describe('remoteStateOf', () => {
  test('content wins, then a loading read, then a retryable failure, and an idle read falls back to empty', () => {
    const retry = (): void => {}
    assert.deepEqual(remoteStateOf(2, 'failed', retry), { kind: 'idle' })
    assert.deepEqual(remoteStateOf(0, 'loading', retry), { kind: 'loading' })
    assert.deepEqual(remoteStateOf(0, 'failed', retry), { kind: 'failed', retry })
    assert.deepEqual(remoteStateOf(0, 'failed'), { kind: 'empty' })
    assert.deepEqual(remoteStateOf(0, 'ready'), { kind: 'empty' })
    assert.deepEqual(remoteStateOf(0, undefined), { kind: 'empty' })
  })
})
