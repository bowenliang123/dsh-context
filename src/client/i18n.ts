import { DICT_DE } from './i18nDe'
import { DICT_EN } from './i18nEn'
import { DICT_ES } from './i18nEs'
import { DICT_FR } from './i18nFr'
import { DICT_JA } from './i18nJa'
import { DICT_PT } from './i18nPt'
import { DICT_RU } from './i18nRu'
import { DICT_ZH } from './i18nZh'

export type Translate = (key: string, params?: Record<string, string | number>) => string

export const DICTS = { de: DICT_DE, en: DICT_EN, es: DICT_ES, fr: DICT_FR, ja: DICT_JA, pt: DICT_PT, ru: DICT_RU, zh: DICT_ZH }

export { DICT_DE, DICT_EN, DICT_ES, DICT_FR, DICT_JA, DICT_PT, DICT_RU, DICT_ZH }
export type { DictKey } from './i18nZh'
