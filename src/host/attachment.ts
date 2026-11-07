import { copyFile, link, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { attachmentOf, isImageName, leafNameOf } from '../shared/attachment'
import type { AttachmentRef } from '../shared/attachment'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { failure, leaseOf, mountPostRoute, observeOf, readBody, reply } from './postRoute'
import { asRecord } from './record'

export const ATTACHMENT_ROUTE = '/api/dsh-context/attachment'

const IMAGE_MEDIA_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

interface AttachmentStoreFace {
  fileHostPath?(ref: unknown): string | undefined
  imageHostPath?(ref: unknown): string | undefined
}

const WALK_MAX_DEPTH = 8

function attachmentIn(value: unknown, id: string, depth: number): AttachmentRef | null {
  if (depth > WALK_MAX_DEPTH) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = attachmentIn(item, id, depth + 1)
      if (hit !== null) return hit
    }
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const ref = attachmentOf(value)
  if (ref !== null && ref.attachmentId === id) return ref
  for (const child of Object.values(value as Record<string, unknown>)) {
    const hit = attachmentIn(child, id, depth + 1)
    if (hit !== null) return hit
  }
  return null
}

export function referencedAttachmentOf(events: readonly unknown[], attachmentId: string): AttachmentRef | null {
  for (const entry of events) {
    try {
      const hit = attachmentIn(entry, attachmentId, 0)
      if (hit !== null) return hit
    } catch {}
  }
  return null
}

export function imagePreviewNameOf(ref: AttachmentRef): string | null {
  const leaf = leafNameOf(ref.name ?? '')
  if (leaf !== '' && isImageName(leaf)) return leaf
  const extension = ref.mediaType !== undefined ? IMAGE_MEDIA_EXTENSION[ref.mediaType] : undefined
  return extension === undefined ? null : `attachment.${extension}`
}

function previewAliasDirOf(objectPath: string): string | null {
  const root = dirname(dirname(dirname(objectPath)))
  if (basename(root) !== 'v1' || basename(dirname(root)) !== 'attachments') return null
  return join(dirname(dirname(root)), 'cache', 'dsh-context', 'previews')
}

function filePathOf(store: AttachmentStoreFace | undefined, ref: AttachmentRef): string | null {
  if (typeof store?.fileHostPath !== 'function') return null
  try {
    const path = store.fileHostPath({ attachmentId: ref.attachmentId, name: ref.name ?? '', bytes: ref.bytes ?? 0 })
    return typeof path === 'string' && path !== '' ? path : null
  } catch {
    return null
  }
}

async function imageAliasOf(store: AttachmentStoreFace | undefined, ref: AttachmentRef): Promise<string | null> {
  if (typeof store?.imageHostPath !== 'function') return null
  let objectPath: string | undefined
  try {
    objectPath = store.imageHostPath({
      attachmentId: ref.attachmentId,
      ...(ref.mediaType !== undefined ? { mediaType: ref.mediaType } : {}),
      ...(ref.bytes !== undefined ? { bytes: ref.bytes } : {}),
      ...(ref.width !== undefined ? { width: ref.width } : {}),
      ...(ref.height !== undefined ? { height: ref.height } : {}),
      ...(ref.name !== undefined ? { name: ref.name } : {}),
    })
  } catch {
    return null
  }
  if (typeof objectPath !== 'string' || objectPath === '') return null
  const name = imagePreviewNameOf(ref)
  if (name === null) return null
  const directory = previewAliasDirOf(objectPath)
  if (directory === null) return null
  const alias = join(directory, basename(dirname(objectPath)), basename(objectPath), name)
  try {
    await mkdir(dirname(alias), { recursive: true })
    try {
      await link(objectPath, alias)
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) await copyFile(objectPath, alias)
    }
    return alias
  } catch {
    return null
  }
}

async function previewPathOf(store: AttachmentStoreFace | undefined, ref: AttachmentRef): Promise<string | null> {
  return ref.kind === 'file' ? filePathOf(store, ref) : await imageAliasOf(store, ref)
}

export function watchAttachmentChannel(ctx: Context, coldReads: ColdReadGate = makeColdReadGate()): void {
  mountPostRoute({
    ctx,
    deps: ['connection'],
    path: ATTACHMENT_ROUTE,
    label: 'dsh-context: attachment route',
    handler: () => async (request: Request): Promise<Response> => {
      const read = await readBody(request)
      if (!read.ok) return read.response
      const body = asRecord(read.body)
      const sessionId = body?.sessionId
      const attachmentId = body?.attachmentId
      if (typeof sessionId !== 'string' || sessionId === '') {
        return failure('dsh-context/bad-request', 'missing sessionId')
      }
      if (typeof attachmentId !== 'string' || attachmentId === '') {
        return failure('dsh-context/bad-request', 'missing attachmentId')
      }
      try {
        const observe = observeOf(ctx)
        if (observe === undefined) return reply({ ok: true, value: null })
        const store = ctx.get('attachments') as AttachmentStoreFace | undefined
        const value = await coldReads.admit(async () => {
          const observation = await observe(sessionId, { projectionMode: 'none' })
          const release = leaseOf(observation)
          try {
            const events = (observation as { events?: unknown } | null)?.events
            if (!Array.isArray(events)) return null
            const ref = referencedAttachmentOf(events, attachmentId)
            if (ref === null) return null
            const path = await previewPathOf(store, ref)
            return path === null ? null : { path }
          } finally {
            release()
          }
        })
        return reply({ ok: true, value: value ?? null })
      } catch (err) {
        return failure('gateway/internal', err instanceof Error ? err.message : String(err))
      }
    },
  })
}
