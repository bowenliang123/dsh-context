import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import * as routes from '../../src/client/apiRoutes'

describe('apiRoutes', () => {
  test('every fetch route stays browser-relative under the plugin namespace', () => {
    for (const route of Object.values(routes)) {
      assert.match(route, /^api\/dsh-context\/[\w-]+$/, route)
    }
  })
})
