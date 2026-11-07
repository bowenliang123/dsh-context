import type { SkillInfo } from '../shared/types'
import { SKILLS_ROUTE } from './apiRoutes'
import { postRouteQuietly } from './route'
import { asRecord } from './services'

export function skillInfoListOf(value: unknown): SkillInfo[] | null {
  const list = asRecord(value)?.skills
  if (!Array.isArray(list)) return null
  const out: SkillInfo[] = []
  for (const item of list) {
    const record = asRecord(item)
    if (record === null || typeof record.name !== 'string' || record.name === '') continue
    out.push({
      name: record.name,
      description: typeof record.description === 'string' ? record.description : '',
      ...(typeof record.path === 'string' && record.path !== '' ? { path: record.path } : {}),
      ...(typeof record.source === 'string' && record.source !== '' ? { source: record.source } : {}),
    })
  }
  return out
}

export async function readSkillCatalog(
  cwd: string | undefined,
  sessionId: string | undefined,
): Promise<ReadonlyMap<string, SkillInfo> | null> {
  return postRouteQuietly(
    SKILLS_ROUTE,
    { ...(cwd === undefined ? {} : { cwd }), ...(sessionId === undefined ? {} : { sessionId }) },
    (value) => {
      const list = skillInfoListOf(value)
      if (list === null || list.length === 0) return null
      return new Map(list.map(info => [info.name, info]))
    },
  )
}

type TextCopier = (text: string) => Promise<void>

const defaultCopier: TextCopier = async (text) => {
  const clipboard = (globalThis.navigator as { clipboard?: { writeText?: unknown } } | undefined)?.clipboard
  if (typeof clipboard?.writeText !== 'function') throw new Error('clipboard unavailable')
  await (clipboard.writeText as (text: string) => Promise<void>).call(clipboard, text)
}

let copier: TextCopier = defaultCopier

export function setSkillCopier(next: TextCopier | null): void {
  copier = next ?? defaultCopier
}

export async function copySkillPath(path: string): Promise<boolean> {
  try {
    await copier(path)
    return true
  } catch {
    return false
  }
}
