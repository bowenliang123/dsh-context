import { DICT_EN } from './i18nEn'
import { DICT_ES } from './i18nEs'
import { DICT_FR } from './i18nFr'
import { DICT_JA } from './i18nJa'
import { DICT_PT } from './i18nPt'
import { DICT_ZH } from './i18nZh'

export type Translate = (key: string, params?: Record<string, string | number>) => string

export const DICTS = { zh: DICT_ZH, en: DICT_EN, ja: DICT_JA, es: DICT_ES, fr: DICT_FR, pt: DICT_PT }

export { DICT_EN, DICT_ES, DICT_FR, DICT_JA, DICT_PT, DICT_ZH }
export type { DictKey } from './i18nZh'
