import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  ATTACHMENT_ROUTE,
  BACKFILL_ROUTE,
  BALANCE_ROUTE,
  COMMANDS_ROUTE,
  DETAIL_ROUTE,
  FLEET_ROUTE,
  SKILLS_ROUTE,
  VERSION_ROUTE,
} from '../../src/client/apiRoutes'

describe('apiRoutes', () => {
  test('every fetch route stays browser-relative under the plugin namespace', () => {
    for (const route of [ATTACHMENT_ROUTE, BACKFILL_ROUTE, BALANCE_ROUTE, COMMANDS_ROUTE, DETAIL_ROUTE, FLEET_ROUTE, SKILLS_ROUTE, VERSION_ROUTE]) {
      assert.match(route, /^api\/dsh-context\/\w+$/, route)
    }
  })
})
