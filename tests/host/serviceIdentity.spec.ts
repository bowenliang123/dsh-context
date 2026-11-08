import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { serviceIdentityOf } from '../../src/host/serviceIdentity'

describe('serviceIdentityOf', () => {
  test('uses the stable identity of a re-bound service wrapper', () => {
    assert.equal(serviceIdentityOf({ identity: 'persistence-1', generation: 1 }), 'persistence-1')
    assert.equal(serviceIdentityOf({ identity: 'persistence-1', generation: 2 }), 'persistence-1')
  })

  test('falls back to the value itself when no identity is exposed', () => {
    const service = { id: 'persistence' }
    assert.equal(serviceIdentityOf(service), service)
    assert.equal(serviceIdentityOf(undefined), undefined)
    assert.equal(serviceIdentityOf('persistence'), 'persistence')
  })
})
