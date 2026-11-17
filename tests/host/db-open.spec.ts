import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'vitest'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { APPLICATION_ID, STORAGE_VERSION, TABLES } from '../../src/host/db/schema'
import { DatabaseOpenError, databasePath, defaultEpoch, openDatabase, quarantine, quickCheck, removeDiscard, resolveDatabasePath, tableNames } from '../../src/host/db/open'
import { createDb, metaSnapshot, metaValue, setMeta } from '../../src/host/db/db'
import { fakeCtx } from './helpers/ctx'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dscx-open-'))
}

describe('database open gate', () => {
  test('creates the full strict schema and survives reopen', () => {
    const dir = tempDir()
    const path = join(dir, 'index.sqlite')
    const first = openDatabase(path, { now: () => 1, epoch: () => 'epoch-1' })
    assert.equal(first.mode, 'file')
    assert.equal(first.rebuilt, false)
    assert.equal(tableNames(first.client).length, 15)
    const tables = first.client.prepare("select name, strict, wr from pragma_table_list where schema='main' and name not like 'sqlite_%'").all() as {
      name: string; strict: number; wr: number
    }[]
    assert.ok(tables.every(table => table.strict === 1 && table.wr === 1))
    const db = createDb(first.client)
    assert.equal(metaValue(db, 'db_epoch'), 'epoch-1')
    setMeta(db, 'clean_shutdown', '1')
    first.client.close()

    const second = openDatabase(path, { now: () => 2, epoch: () => 'epoch-2' })
    assert.equal(second.rebuilt, false)
    assert.equal(metaSnapshot(createDb(second.client)).epoch, 'epoch-1')
    assert.equal(metaValue(createDb(second.client), 'clean_shutdown'), '1')
    second.client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('refuses a foreign application id without touching the file', () => {
    const dir = tempDir()
    const path = join(dir, 'index.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA application_id = 12345')
    raw.exec('CREATE TABLE foreign_table(id integer primary key)')
    raw.close()
    const before = readFileSync(path)
    assert.throws(() => openDatabase(path), (error: unknown) => {
      assert.ok(error instanceof DatabaseOpenError)
      assert.equal(error.reason, 'foreign-database')
      assert.equal(error.refused, true)
      return true
    })
    assert.deepEqual(readFileSync(path), before)
    rmSync(dir, { recursive: true, force: true })
  })

  test('refuses an unowned non-empty database without touching the file', () => {
    const dir = tempDir()
    const path = join(dir, 'index.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec('CREATE TABLE someone_elses(id integer primary key)')
    raw.close()
    const before = readFileSync(path)
    assert.throws(() => openDatabase(path), (error: unknown) => {
      assert.ok(error instanceof DatabaseOpenError)
      assert.equal(error.reason, 'unowned-database')
      return true
    })
    assert.deepEqual(readFileSync(path), before)
    rmSync(dir, { recursive: true, force: true })
  })

  test('rebuilds a version mismatch in place and stamps the new version', () => {
    const dir = tempDir()
    const path = join(dir, 'index.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    raw.exec('PRAGMA user_version = 2')
    raw.exec('CREATE TABLE sessions(id text primary key)')
    raw.close()
    const opened = openDatabase(path, { now: () => 3, epoch: () => 'fresh' })
    assert.equal(opened.rebuilt, true)
    assert.equal(opened.mode, 'file')
    const version = opened.client.prepare('PRAGMA user_version').get() as { user_version: number }
    assert.equal(version.user_version, STORAGE_VERSION)
    assert.equal(tableNames(opened.client).length, 15)
    assert.equal(metaValue(createDb(opened.client), 'db_epoch'), 'fresh')
    opened.client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('renames a large stale database aside instead of dropping it in place', () => {
    const dir = tempDir()
    const path = join(dir, 'index.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    raw.exec('PRAGMA user_version = 1')
    raw.exec('CREATE TABLE sessions(id text primary key)')
    raw.close()
    const opened = openDatabase(path, { now: () => 4, renameThresholdBytes: 0 })
    assert.equal(opened.rebuilt, true)
    assert.ok(opened.discardPath !== undefined)
    assert.ok(statSync(opened.discardPath).isFile())
    assert.equal(statSync(path).isFile(), true)
    opened.client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('rebuilds a version mismatch even when unknown tables are present', () => {
    const dir = tempDir()
    const path = join(dir, 'index.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    raw.exec('PRAGMA user_version = 2')
    raw.exec('CREATE TABLE mystery(id integer primary key)')
    raw.exec('CREATE TABLE "odd""name"(id integer primary key)')
    raw.close()
    const opened = openDatabase(path, { now: () => 6, epoch: () => 'cleared' })
    assert.equal(opened.rebuilt, true)
    assert.equal(tableNames(opened.client).length, 15)
    assert.equal(Number(opened.client.prepare('PRAGMA user_version').get()!.user_version), STORAGE_VERSION)
    opened.client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('refuses unknown tables at the current version', () => {
    const dir = tempDir()
    const path = join(dir, 'index.sqlite')
    const opened = openDatabase(path)
    opened.client.exec('CREATE TABLE mystery(id integer primary key)')
    opened.client.close()
    assert.throws(() => openDatabase(path), (error: unknown) => {
      assert.ok(error instanceof DatabaseOpenError)
      assert.equal(error.reason, 'unknown-tables')
      return true
    })
    rmSync(dir, { recursive: true, force: true })
  })

  test('rebuilds a version 8 database instead of migrating its rows', () => {
    const dir = tempDir()
    const path = join(dir, 'index.sqlite')
    openDatabase(path).client.close()
    const raw = new DatabaseSync(path)
    raw.exec(`INSERT INTO sessions (id, title, created_at, updated_at, fold_status, last_seq, detail_rev, family_root)
      VALUES ('s', 's', 1, 1, 'ok', 0, 1, 's')`)
    raw.exec('PRAGMA user_version = 8')
    raw.close()
    const opened = openDatabase(path, { now: () => 5, epoch: () => 'rebuilt' })
    assert.equal(opened.rebuilt, true)
    assert.equal(Number(opened.client.prepare('PRAGMA user_version').get()!.user_version), STORAGE_VERSION)
    assert.equal(opened.client.prepare('SELECT count(*) AS n FROM sessions').get()!.n, 0)
    assert.equal(metaValue(createDb(opened.client), 'db_epoch'), 'rebuilt')
    opened.client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('rebuilds a half-created current-version database', () => {
    const dir = tempDir()
    const path = join(dir, 'index.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    raw.exec(`PRAGMA user_version = ${STORAGE_VERSION}`)
    raw.exec('CREATE TABLE sessions(id text primary key)')
    raw.close()
    const opened = openDatabase(path)
    assert.equal(opened.rebuilt, true)
    assert.equal(tableNames(opened.client).length, 15)
    opened.client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test(':memory: opens a complete schema and reports a healthy quick_check', () => {
    const opened = openDatabase(':memory:', { epoch: () => 'mem' })
    assert.equal(opened.mode, 'memory')
    assert.equal(tableNames(opened.client).length, 15)
    assert.deepEqual(quickCheck(opened.client), { ok: true, detail: 'ok' })
    opened.client.close()
  })

  test('an unwritable path reports an open failure', () => {
    const dir = tempDir()
    const blocked = join(dir, 'file')
    writeFileSync(blocked, 'not a directory')
    assert.throws(() => openDatabase(join(blocked, 'index.sqlite')), (error: unknown) => {
      assert.ok(error instanceof DatabaseOpenError)
      assert.equal(error.refused, false)
      return true
    })
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('schema parity', () => {
  test('every declared table, column, index and foreign key exists in SQLite', () => {
    const opened = openDatabase(':memory:')
    const client = opened.client
    for (const table of TABLES) {
      const name = getTableName(table)
      const columns = Object.keys(getTableColumns(table)).length
      const info = client.prepare(`PRAGMA table_info(${name})`).all()
      assert.equal(info.length, columns, name)
      const indexes = client.prepare(`PRAGMA index_list(${name})`).all() as { name: string }[]
      assert.ok(indexes.length >= 1, name)
    }
    const foreign = client.prepare('PRAGMA foreign_key_list(header_tools)').all() as { table: string }[]
    assert.equal(foreign[0]?.table, 'header_epochs')
    const fkSessions = client.prepare('PRAGMA foreign_key_list(requests)').all() as { table: string }[]
    assert.equal(fkSessions[0]?.table, 'sessions')
    opened.client.close()
  })
})

describe('drizzle schema configuration', () => {
  test('evaluates every table callback, index, check and foreign key', () => {
    for (const table of TABLES) {
      const config = getTableConfig(table)
      assert.ok(config.columns.length > 0)
      assert.ok(Array.isArray(config.checks))
      assert.ok(Array.isArray(config.foreignKeys))
      for (const foreignKey of config.foreignKeys) foreignKey.reference()
    }
  })
})

describe('open helpers', () => {
  test('renames the WAL siblings with a large stale database', () => {
    const dir = tempDir()
    const path = join(dir, 'index.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    raw.exec('PRAGMA user_version = 1')
    raw.exec('CREATE TABLE sessions(id text primary key)')
    raw.close()
    const opened = openDatabase(path, { now: () => 7, renameThresholdBytes: 0 })
    assert.ok(opened.discardPath !== undefined)
    opened.client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('quarantines, removes leftovers and reports a closed quick check', () => {
    const dir = tempDir()
    const path = join(dir, 'index.sqlite')
    const opened = openDatabase(path)
    writeFileSync(`${path}-wal`, 'wal')
    writeFileSync(`${path}-shm`, 'shm')
    const target = quarantine(opened.client, path, 10)
    assert.equal(target, `${path}.corrupt-10`)
    assert.equal(existsSync(`${target}-wal`), true)
    assert.equal(existsSync(`${target}-shm`), true)
    assert.equal(quarantine(new DatabaseSync(':memory:'), join(dir, 'missing.sqlite'), 11), null)
    const discard = join(dir, 'discard.sqlite')
    writeFileSync(discard, 'x')
    writeFileSync(`${discard}-wal`, 'x')
    writeFileSync(`${discard}-shm`, 'x')
    removeDiscard(discard)
    removeDiscard(undefined)
    assert.equal(existsSync(discard), false)
    const closed = new DatabaseSync(':memory:')
    closed.close()
    assert.equal(quickCheck(closed).ok, false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('resolves paths from dshHomePath, DSH_HOME and the home fallback', () => {
    assert.equal(defaultEpoch(1).includes('-'), true)
    assert.equal(databasePath('/h'), '/h/storages/dsh-context/index.sqlite')
    const good = fakeCtx({ dshHomePath: (...segments: string[]) => join('/dsh', ...segments) }, { injectAll: true })
    assert.equal(resolveDatabasePath(good.ctx).includes('dsh'), true)
    const blank = fakeCtx({ dshHomePath: () => '' }, { injectAll: true })
    assert.equal(resolveDatabasePath(blank.ctx, { DSH_HOME: '/env' }, '/home').includes('env'), true)
    const hostile = fakeCtx({}, { injectAll: true })
    hostile.ctx.get = () => { throw new Error('boom') }
    assert.equal(resolveDatabasePath(hostile.ctx, {}, '/home').includes('.dsh'), true)
  })

  test('reports an unusable directory path as an open failure', () => {
    const dir = tempDir()
    assert.throws(() => openDatabase(dir), (error: unknown) => {
      assert.ok(error instanceof DatabaseOpenError)
      assert.equal(error.refused, false)
      return true
    })
    rmSync(dir, { recursive: true, force: true })
  })
})
