import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import { seatOf } from './seats'
import { asRecord } from './wire'

type SnapshotSeat = (selector: (snapshot: unknown) => unknown) => unknown

const NO_SNAPSHOT: SnapshotSeat = () => null

const CURRENT_SESSION_KEY = 'dsh.sessions.current'

export interface CurrentSession {
  id: string
  cwd?: string
}

function persistedCurrentId(): string | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined
    const raw = localStorage.getItem(CURRENT_SESSION_KEY)
    const id = raw === null ? undefined : asRecord(JSON.parse(raw))?.sessionId
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

function currentKeyOf(snapshot: unknown): string {
  const id = persistedCurrentId()
  if (id === undefined) return ''
  const cwd = asRecord(asRecord(asRecord(snapshot)?.byId)?.[id])?.cwd
  return typeof cwd === 'string' && cwd !== '' ? `${id}\u0000${cwd}` : id
}

export function currentSessionOf(props: { useSessions?: unknown }): CurrentSession | null {
  const read = seatOf(props.useSessions, NO_SNAPSHOT)
  let key: unknown = null
  try {
    key = read((snapshot: unknown) => currentKeyOf(snapshot))
  } catch {}
  if (typeof key === 'string' && key !== '') {
    const split = key.indexOf('\u0000')
    return split < 0 ? { id: key } : { id: key.slice(0, split), cwd: key.slice(split + 1) }
  }
  const id = persistedCurrentId()
  return id === undefined ? null : { id }
}

export function projectOf(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  const title = workspaceTitleOf(cwd)
  return title === '' ? undefined : title
}

export const UNGROUPED_KEY = '__ungrouped__'
