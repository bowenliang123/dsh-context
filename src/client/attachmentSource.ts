import { previewAddressOf } from './fileActivity'
import type { AttachmentRef } from '../shared/attachment'
import { ATTACHMENT_ROUTE } from './apiRoutes'
import { trimRetentionMap } from './retention'
import { postRouteQuietly } from './route'
import { asRecord, openResourceVia } from './services'
import type { AttachmentLocator, AttachmentOpener, ClientCtx } from './services'

const paths = new Map<string, string>()

export function clearAttachmentPaths(): void {
  paths.clear()
}

export function pathOfValue(value: unknown): string | null {
  const data = asRecord(value)
  return data !== null && typeof data.path === 'string' && data.path !== '' ? data.path : null
}

export function makeAttachmentLocator(sessionId: string | undefined): AttachmentLocator | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  return async (attachment: AttachmentRef) => {
    const key = attachment.attachmentId
    const cached = paths.get(key)
    if (cached !== undefined) return cached
    const path = await postRouteQuietly(ATTACHMENT_ROUTE, { sessionId, attachmentId: key }, pathOfValue)
    if (path === null) return null
    paths.set(key, path)
    trimRetentionMap(paths, 'attachmentPaths')
    return path
  }
}

export function makeAttachmentOpener(
  ctx: ClientCtx,
  sessionId: string | undefined,
  workspace: string | undefined,
): AttachmentOpener | undefined {
  const locate = makeAttachmentLocator(sessionId)
  const openPreview = openResourceVia(ctx)
  if (locate === undefined || openPreview === undefined) return undefined
  return async (attachment: AttachmentRef) => {
    const path = await locate(attachment)
    if (path === null) return false
    const address = previewAddressOf(path, 'text', false, sessionId, workspace)
    return address !== undefined && openPreview(address)
  }
}
