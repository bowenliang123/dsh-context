import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'

const ROOT = join(process.cwd(), 'src/client')

const GUARD = /typeof\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:===|!==)\s*'function'/g

const HOOK = /(?:^|\.)(use[A-Z][\w$]*)$/

const CALL = (name: string): RegExp => new RegExp(`(?:\\b${name}\\s*\\(|\\b${name}\\s+as\\b[^;]{0,80}\\)\\s*\\()`)

function guardedSeatCalls(source: string): string[] {
  const offenders: string[] = []
  for (const match of source.matchAll(GUARD)) {
    const name = match[1].split('.').pop() as string
    if (!HOOK.test(name)) continue
    const start = (match.index ?? 0) + match[0].length
    if (CALL(name).test(source.slice(start, start + 260))) offenders.push(match[1])
  }
  return offenders
}

test('the seat guard scan flags conditional seat calls', () => {
  const source = [
    "const head = typeof useProjection === 'function' ? useProjection('contextTimeline') : undefined",
    'if (typeof useTabInfo === \'function\') { useTabInfo() }',
    "if (typeof useChat !== 'function') return undefined\nreturn useChat(sel)",
  ].join('\n')
  assert.deepEqual(guardedSeatCalls(source), ['useProjection', 'useTabInfo', 'useChat'])
})

test('no hook seat is called behind a typeof-function guard', () => {
  const offenders: string[] = []
  for (const rel of readdirSync(ROOT, { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx?$/.test(rel)) continue
    const source = readFileSync(join(ROOT, rel), 'utf8')
    for (const name of guardedSeatCalls(source)) offenders.push(`${rel}: ${name}`)
  }
  assert.deepEqual(offenders, [], 'call seats unconditionally and branch on their result')
})
