import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { PRICE_BOOK_FILE, PRICE_BOOK_FORMAT } from '../../../src/host/catalog'

const SOURCE = { 'test-catalog': { models: { 'test-model': { cost: { input: 1, output: 2 } } } } }

export function isolatePriceBookHome(): void {
  const home = mkdtempSync(join(tmpdir(), 'dsh-context-boot-home-'))
  process.env.DSH_HOME = home
  const dir = join(home, 'storages', 'dsh-context')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, PRICE_BOOK_FILE), JSON.stringify({ format: PRICE_BOOK_FORMAT, fetchedAt: Date.now(), source: SOURCE }))
  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
  })
}
