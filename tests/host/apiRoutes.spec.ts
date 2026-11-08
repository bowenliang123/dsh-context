import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { BALANCE_ROUTE as HOST_BALANCE_ROUTE } from '../../src/host/balance'
import { DETAIL_ROUTE as HOST_DETAIL_ROUTE } from '../../src/host/detail'
import { ATTACHMENT_ROUTE as HOST_ATTACHMENT_ROUTE } from '../../src/host/attachment'
import { BACKFILL_ROUTE as HOST_BACKFILL_ROUTE } from '../../src/host/backfill'
import { COMMANDS_ROUTE as HOST_COMMANDS_ROUTE } from '../../src/host/commandPages'
import { FLEET_ROUTE as HOST_FLEET_ROUTE } from '../../src/host/fleet'
import { SKILLS_ROUTE as HOST_SKILLS_ROUTE } from '../../src/host/skills'
import { OVERVIEW_ROUTE as HOST_OVERVIEW_ROUTE } from '../../src/host/overview'
import {
  ATTACHMENT_ROUTE,
  BACKFILL_ROUTE,
  BALANCE_ROUTE,
  COMMANDS_ROUTE,
  DETAIL_ROUTE,
  FLEET_ROUTE,
  OVERVIEW_ROUTE,
  SKILLS_ROUTE,
} from '../../src/client/apiRoutes'

describe('apiRoutePairing', () => {
  test('each client fetch route is its host registration minus the leading slash', () => {
    for (const [host, client] of [
      [HOST_DETAIL_ROUTE, DETAIL_ROUTE],
      [HOST_COMMANDS_ROUTE, COMMANDS_ROUTE],
      [HOST_BALANCE_ROUTE, BALANCE_ROUTE],
      [HOST_FLEET_ROUTE, FLEET_ROUTE],
      [HOST_SKILLS_ROUTE, SKILLS_ROUTE],
      [HOST_BACKFILL_ROUTE, BACKFILL_ROUTE],
      [HOST_ATTACHMENT_ROUTE, ATTACHMENT_ROUTE],
      [HOST_OVERVIEW_ROUTE, OVERVIEW_ROUTE],
    ]) {
      assert.equal(client, host.slice(1), `${host} and ${client} lost their pairing`)
    }
  })
})
