import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { DICT_EN, type DictKey } from '../../src/client/i18n'
import { formLabelOf, modeLabelOf } from '../../src/client/labels'
import { makeTranslate } from './helpers/kit'

const t = makeTranslate()

describe('formLabelOf', () => {
  test('maps every harness form to its dictionary label', () => {
    for (const form of ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall', 'context']) {
      assert.equal(formLabelOf(t, form), DICT_EN[`form.${form}` as DictKey], form)
    }
  })

  test('an unknown or absent form falls back to the generic context label', () => {
    assert.equal(formLabelOf(t, 'mystery'), DICT_EN['form.context'])
    assert.equal(formLabelOf(t, ''), DICT_EN['form.context'])
    assert.equal(formLabelOf(t, undefined), DICT_EN['form.context'])
  })
})

describe('modeLabelOf', () => {
  test('maps the known plan mode names to their dictionary labels', () => {
    assert.equal(modeLabelOf(t, 'plan.on'), DICT_EN['ev.mode.plan.on'])
    assert.equal(modeLabelOf(t, 'plan.off'), DICT_EN['ev.mode.plan.off'])
  })

  test('an unknown mode stays readable as its own name and an absent one keeps the legacy fallback', () => {
    assert.equal(modeLabelOf(t, 'goal'), 'goal')
    assert.equal(modeLabelOf(t, undefined), 'ev.mode.?')
  })
})
