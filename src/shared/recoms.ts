import { asPlainObject } from './decode'

export interface RecomText {
  en: string
  zh: string
}

export interface Recom {
  id: string
  name: string
  url: string
  icon: string
  slogan: RecomText
  promotion: RecomText
  tooltip: RecomText
}

export interface RecomRead {
  recom: Recom
  degraded: boolean
}

export interface RecomsRead {
  recoms: Recom[]
  degraded: boolean
}

export const RECOM_REPOSITORY_ROOT = 'https://raw.githubusercontent.com/bowenliang123/dsh-context/main/'
export const RECOM_DATA_URL = RECOM_REPOSITORY_ROOT + 'data/recoms.json'
export const RECOM_DATA_MIRROR_URL = 'https://gh-proxy.org/' + RECOM_DATA_URL

export const DEFAULT_RECOM: Recom = {
  id: 'deepseek-platform',
  name: 'DeepSeek',
  url: 'https://platform.deepseek.com/',
  icon: 'https://cdn.simpleicons.org/deepseek',
  slogan: {
    zh: '探索未至之境。',
    en: 'Into the Unknown.',
  },
  promotion: {
    zh: 'DeepSeek Harness桌面端现已发布!',
    en: 'DeepSeek Harness desktop app is now available!',
  },
  tooltip: {
    zh: '特别感谢 DeepSeek 开放平台，为智能体开发者提供强大而易用的模型服务。通过一个 API Key 接入最新模型，把更多时间留给创造。',
    en: 'Special thanks to DeepSeek Platform for making capable, developer-friendly models accessible to agent builders. Connect the latest models with one API key and spend more time creating.',
  },
}

function textOf(value: unknown): RecomText | null {
  const record = asPlainObject(value)
  if (record === null || typeof record.en !== 'string' || record.en.trim() === ''
    || typeof record.zh !== 'string' || record.zh.trim() === '') return null
  return { en: record.en, zh: record.zh }
}

function httpsOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function iconOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const url = new URL(value, RECOM_REPOSITORY_ROOT)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export function recomOf(value: unknown): Recom | null {
  const record = asPlainObject(value)
  if (record === null || typeof record.id !== 'string' || record.id.trim() === ''
    || typeof record.name !== 'string' || record.name.trim() === '') return null
  const url = httpsOf(record.url)
  const icon = iconOf(record.icon)
  const slogan = textOf(record.slogan)
  const promotion = textOf(record.promotion)
  const tooltip = textOf(record.tooltip)
  if (url === null || icon === null || slogan === null || promotion === null || tooltip === null) return null
  return { id: record.id, name: record.name, url, icon, slogan, promotion, tooltip }
}

export function recomsOfPayload(value: unknown): Recom[] {
  if (!Array.isArray(value)) return []
  const recoms: Recom[] = []
  for (const entry of value) {
    try {
      const recom = recomOf(entry)
      if (recom !== null) recoms.push(recom)
    } catch {
      continue
    }
  }
  return recoms
}
