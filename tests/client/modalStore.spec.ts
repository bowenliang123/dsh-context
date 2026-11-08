import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { modalStoreOf, setPendingConsume, takePendingConsume, type ConsumeGuard } from '../../src/client/modalStore'
import { disposeRetention } from '../../src/client/retention'

describe('modalStoreOf', () => {
  test('returns the same store per session id, distinct stores across ids, starting closed', () => {
    assert.equal(modalStoreOf('modal-same-a'), modalStoreOf('modal-same-a'))
    assert.notEqual(modalStoreOf('modal-same-a'), modalStoreOf('modal-same-b'))
    assert.equal(modalStoreOf('modal-initial').getSnapshot(), false)
  })

  test('set with a flipped value notifies once per change; a repeat notifies nothing', () => {
    const store = modalStoreOf('modal-flip')
    let calls = 0
    store.subscribe(() => { calls++ })
    store.set(true)
    assert.equal(calls, 1)
    assert.equal(store.getSnapshot(), true)
    store.set(true)
    assert.equal(calls, 1)
    store.set(false)
    assert.equal(calls, 2)
    assert.equal(store.getSnapshot(), false)
  })

  test('unsubscribe stops notifications', () => {
    const store = modalStoreOf('modal-unsub')
    let calls = 0
    const unsubscribe = store.subscribe(() => { calls++ })
    store.set(true)
    assert.equal(calls, 1)
    unsubscribe()
    store.set(false)
    assert.equal(calls, 1)
  })
})

describe('pending consume guards', () => {
  test('take returns the guard once, then undefined; an absent guard reads undefined', () => {
    assert.equal(takePendingConsume('consume-absent'), undefined)
    const guard: ConsumeGuard = { kind: 'bare-token', token: '/context' }
    setPendingConsume('consume-once', guard)
    assert.equal(takePendingConsume('consume-once'), guard)
    assert.equal(takePendingConsume('consume-once'), undefined)
  })

  test('guards are isolated per session', () => {
    const guard: ConsumeGuard = { kind: 'span', span: { start: 0, end: 8, draftRev: 1 } }
    setPendingConsume('consume-iso-a', guard)
    assert.equal(takePendingConsume('consume-iso-b'), undefined)
    assert.equal(takePendingConsume('consume-iso-a'), guard)
  })
})

describe('modal store retention', () => {
  test('the store map stays bounded and the least recently read store drops', () => {
    for (let i = 0; i < 40; i++) modalStoreOf('modal-cap-' + i)
    const survivor = modalStoreOf('modal-cap-39')
    assert.equal(modalStoreOf('modal-cap-39'), survivor)
    assert.notEqual(modalStoreOf('modal-cap-0'), undefined)
    modalStoreOf('modal-cap-0')
    assert.notEqual(modalStoreOf('modal-cap-0'), modalStoreOf('modal-cap-39'))
  })

  test('a store left idle past the ttl is recreated closed', () => {
    vi.useFakeTimers()
    try {
      const store = modalStoreOf('modal-ttl')
      store.set(true)
      vi.advanceTimersByTime(10 * 60_000)
      assert.notEqual(modalStoreOf('modal-ttl'), store)
      assert.equal(modalStoreOf('modal-ttl').getSnapshot(), false)
    } finally {
      vi.useRealTimers()
    }
  })

  test('pending consume guards stay bounded, dropping the oldest', () => {
    for (let i = 0; i < 33; i++) setPendingConsume('guard-' + i, { kind: 'bare-token', token: 't' + i })
    assert.equal(takePendingConsume('guard-0'), undefined)
    assert.deepEqual(takePendingConsume('guard-32'), { kind: 'bare-token', token: 't32' })
  })

  test('dispose clears every stored modal state', () => {
    const store = modalStoreOf('modal-dispose')
    store.set(true)
    setPendingConsume('modal-dispose', { kind: 'bare-token', token: '/context' })
    disposeRetention()
    assert.notEqual(modalStoreOf('modal-dispose'), store)
    assert.equal(takePendingConsume('modal-dispose'), undefined)
  })
})
