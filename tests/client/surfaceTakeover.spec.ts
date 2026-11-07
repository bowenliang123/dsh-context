import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'

const TAKEOVER = /\[data-conversation-scroll\]\[data-lc-surface\] > \[data-composer-seat\]:not\(:has\(([^)]*)\)\)/

test('the pane takeover hides the composer seat unless a compact decision card is pending', () => {
  const css = readFileSync(join(process.cwd(), 'src/client/styles/base.css'), 'utf8')
  const match = css.match(TAKEOVER)
  assert.ok(match, 'the takeover rule must keep its selector shape')
  assert.deepEqual(
    match[1].split(',').map(key => key.trim()).sort(),
    ['[data-approval-key]', '[data-plan-review-key]'].sort(),
    'a pending ask_user_question card must never keep the seat over the dashboard; only the compact approval and plan-review cards may',
  )
})
