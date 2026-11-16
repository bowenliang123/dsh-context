import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { fakeCtx } from './helpers/ctx'

vi.mock('../../src/host/db/plugin', () => ({
  startStorage: () => { throw new Error('storage boom') },
}))

test('apply reports a storage startup failure and stays alive', async () => {
  const { apply } = await import('../../src/host/index')
  const errors: string[] = []
  const fake = fakeCtx({}, { injectAll: true, logger: { error: (...args: unknown[]) => errors.push(args.map(String).join(' ')) } })
  assert.doesNotThrow(() => apply(fake.ctx, {} as never))
  assert.equal(errors.some(line => line.includes('storage startup failed') && line.includes('storage boom')), true)
  fake.dispose()
})
