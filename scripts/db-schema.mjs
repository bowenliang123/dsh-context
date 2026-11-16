import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = resolve(root, 'src/host/db/schema.generated.ts')
const schema = 'src/host/db/schema.ts'
const binary = resolve(root, 'node_modules/drizzle-kit/bin.cjs')

function exportSql() {
  const result = spawnSync(process.execPath, [
    binary,
    'export',
    '--sql',
    '--dialect=sqlite',
    `--schema=${schema}`,
  ], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) {
    throw new Error(`drizzle-kit export failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function applyTableOptions(sql) {
  const lines = sql.split(/\r?\n/)
  const out = []
  let creating = false
  for (const line of lines) {
    if (line.startsWith('CREATE TABLE ')) creating = true
    if (creating && line.trim() === ');') {
      out.push(') STRICT, WITHOUT ROWID;')
      creating = false
      continue
    }
    out.push(line)
  }
  if (creating) throw new Error('unterminated CREATE TABLE in drizzle-kit output')
  return out.join('\n').trimEnd()
}

function generated(sql) {
  return `export const CREATE_SCHEMA_SQL: string = ${JSON.stringify(sql)}\n`
}

const sql = applyTableOptions(exportSql())
const content = generated(sql)
if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(target, 'utf8')
  } catch {}
  if (current !== content) {
    console.error('src/host/db/schema.generated.ts is out of date; run `node scripts/db-schema.mjs`')
    process.exit(1)
  }
  process.exit(0)
}
writeFileSync(target, content)
