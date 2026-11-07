import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { amountOf, asPlainObject, asRecord, stringOf } from '../../src/shared/decode'

describe('asRecord', () => {
  test('keeps any object, arrays included; every non-object is null', () => {
    const value = { a: 1 }
    assert.equal(asRecord(value), value)
    const list: unknown[] = [1, 2]
    assert.equal(asRecord(list), list, 'the client-side guard keeps arrays for callers that read own fields')
    for (const absent of [null, undefined, 'text', 42, true]) assert.equal(asRecord(absent), null)
    assert.equal(asRecord(() => 0), null)
  })
})

describe('asPlainObject', () => {
  test('rejects arrays and every non-object; a plain object passes through', () => {
    const value = { a: 1 }
    assert.equal(asPlainObject(value), value)
    for (const rejected of [null, undefined, 'text', 42, true, [1, 2]]) assert.equal(asPlainObject(rejected), null)
    assert.equal(asPlainObject(() => 0), null)
  })
})

describe('amountOf', () => {
  test('normalizes a finite non-negative number or numeric string; everything else is null', () => {
    assert.equal(amountOf(0), 0)
    assert.equal(amountOf(12.5), 12.5)
    assert.equal(amountOf('12.5'), 12.5)
    assert.equal(amountOf('-1'), null)
    assert.equal(amountOf(-1), null)
    assert.equal(amountOf('abc'), null)
    assert.equal(amountOf(''), 0, 'Number(empty) is zero, the pre-existing wire guard behavior')
    assert.equal(amountOf(Number.NaN), null)
    assert.equal(amountOf(Number.POSITIVE_INFINITY), null)
    for (const rejected of [null, undefined, true, {}, []]) assert.equal(amountOf(rejected), null)
  })
})

describe('stringOf', () => {
  test('keeps a non-empty string and drops the rest', () => {
    assert.equal(stringOf('value'), 'value')
    assert.equal(stringOf(' '), ' ')
    assert.equal(stringOf(''), undefined)
    for (const rejected of [null, undefined, 0, 42, true, {}]) assert.equal(stringOf(rejected), undefined)
  })
})
