import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { ClientCtx, SessionsFace } from './dshFaces'
import { seatOf } from './seats'

type SnapshotSeat = (selector: (snapshot: unknown) => unknown) => unknown

const NO_SNAPSHOT: SnapshotSeat = () => null

function standardSnapshotOf(useSeat: unknown): unknown {
  const read = seatOf(useSeat, NO_SNAPSHOT)
  try {
    return read(snapshot => snapshot)
  } catch {
    return null
  }
}

export function sessionsSnapshotOf(props: { useSessions?: unknown }): unknown {
  return standardSnapshotOf(props.useSessions)
}

export function projectOf(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  const title = workspaceTitleOf(cwd)
  return title === '' ? undefined : title
}

export const UNGROUPED_KEY = '__ungrouped__'

export function refreshSessions(ctx: ClientCtx): void {
  try {
    const sessions = ctx.get('sessions') as SessionsFace | undefined
    if (sessions === undefined || typeof sessions.refresh !== 'function') return
    void Promise.resolve(sessions.refresh()).catch(() => {})
  } catch {}
}
