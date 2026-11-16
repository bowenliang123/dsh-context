import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, test, vi } from 'vitest'
import { APPLICATION_ID } from '../../src/host/db/schema'
import { DatabaseOpenError, openDatabase } from '../../src/host/db/open'

const flags = vi.hoisted(() => ({ failStat: false, failRename: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (flags.failStat) throw new Error('stat blocked')
      return actual.statSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (flags.failRename) throw new Error('rename blocked')
      return actual.renameSync(...args)
    },
  }
})

function staleDatabase(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dscx-openfail-'))
  const path = join(dir, 'index.sqlite')
  const raw = new DatabaseSync(path)
  raw.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
  raw.exec('PRAGMA user_version = 1')
  raw.exec('CREATE TABLE sessions(id text primary key)')
  raw.close()
  return { dir, path }
}

afterEach(() => {
  flags.failStat = false
  flags.failRename = false
})

describe('open failure paths', () => {
  test('a blocked rename reports the open failure', () => {
    const { dir, path } = staleDatabase()
    flags.failRename = true
    assert.throws(() => openDatabase(path, { now: () => 9, renameThresholdBytes: 0 }), (error: unknown) => {
      assert.ok(error instanceof DatabaseOpenError)
      assert.equal(error.refused, false)
      return true
    })
    rmSync(dir, { recursive: true, force: true })
  })

  test('an unreadable size falls back to the in-place rebuild', () => {
    const { dir, path } = staleDatabase()
    flags.failStat = true
    const opened = openDatabase(path, { now: () => 9, renameThresholdBytes: 0 })
    assert.equal(opened.rebuilt, true)
    opened.client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a corrupt retry can still fail open', () => {
    const { dir, path } = staleDatabase()
    flags.failRename = true
    writeFileSync(path, 'not a database')
    assert.throws(() => openDatabase(path), DatabaseOpenError)
    rmSync(dir, { recursive: true, force: true })
  })
})
