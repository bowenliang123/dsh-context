import type { Translate } from './i18n'

const FORM_KEYS: ReadonlySet<string> = new Set(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall', 'context'])

const MODE_KEYS: ReadonlySet<string> = new Set(['plan.on', 'plan.off'])

export function formLabelOf(t: Translate, form: string | undefined): string {
  return t('form.' + (form !== undefined && FORM_KEYS.has(form) ? form : 'context'))
}

export function modeLabelOf(t: Translate, name: string | undefined): string {
  if (name === undefined) return 'ev.mode.?'
  return MODE_KEYS.has(name) ? t('ev.mode.' + name) : name
}
