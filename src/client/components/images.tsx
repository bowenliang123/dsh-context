/**
 * ImageCards — durable image attachment rendering for the Context browser.
 *
 * dsh 0.1.1's multimodal pipeline stores only a normalized reference per
 * image (never inline bytes), so a message block carries everything a card
 * needs except the display URL: that comes from the harness conversation
 * service's `resolveImage` (the same loader the chat history rides on),
 * handed down as `load`. Absent loader or a failed load degrades to the
 * metadata row alone — the card never throws.
 */

import type * as ReactNS from 'react'
import { fmtBytes } from '../format'
import { React } from '../react'
import type { ImageLoader, ImageRefLike } from '../services'
import type { ViewKit } from '../viewkit'

/** The image-rendering handoff threaded through the browser's bodies. */
export interface ImageKit {
  Card: (props: { attachment: ImageRefLike; load?: ImageLoader }) => ReactNS.ReactElement
  /** Session-authorized URL loader (absent = metadata-only cards). */
  load?: ImageLoader
}

/**
 * Narrow an unknown content block to a durable image reference. Accepts both
 * raw message blocks (`{ type: 'image', attachment }`) and the conversation
 * snapshot's assistant blocks (`{ kind: 'image', attachment }`); everything
 * else returns null. Lenient on the ref's optional facts (name/bytes/dims) —
 * `resolveImage` reads only `attachmentId`.
 */
export function imageRefOf(block: unknown): ImageRefLike | null {
  if (block === null || typeof block !== 'object') return null
  const b = block as { type?: unknown; kind?: unknown; attachment?: unknown }
  if (b.type !== 'image' && b.kind !== 'image') return null
  const a = b.attachment
  if (a === null || typeof a !== 'object') return null
  const r = a as Record<string, unknown>
  if (typeof r.attachmentId !== 'string' || r.attachmentId === '') return null
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
  const orig = r.originalDimensions !== null && typeof r.originalDimensions === 'object'
    ? r.originalDimensions as Record<string, unknown>
    : undefined
  const origDims = orig !== undefined && num(orig.width) !== undefined && num(orig.height) !== undefined
    ? { width: num(orig.width) as number, height: num(orig.height) as number }
    : undefined
  return {
    attachmentId: r.attachmentId,
    ...(typeof r.name === 'string' && r.name !== '' ? { name: r.name } : {}),
    ...(num(r.bytes) !== undefined ? { bytes: num(r.bytes) } : {}),
    ...(num(r.width) !== undefined ? { width: num(r.width) } : {}),
    ...(num(r.height) !== undefined ? { height: num(r.height) } : {}),
    ...(origDims !== undefined ? { originalDimensions: origDims } : {}),
  }
}

/**
 * One attachment card: a 64px cover tile (click opens the full image in a
 * new tab; load failures retry on click) beside a metadata column — display
 * name, normalized dimensions (plus the pre-normalization size dsh 0.1.1
 * records), and the stored byte size.
 */
export function makeImageCard(kit: ViewKit): ImageKit['Card'] {
  const { t } = kit
  return function ImageCard(props: { attachment: ImageRefLike; load?: ImageLoader }): ReactNS.ReactElement {
    const { attachment, load } = props
    const [src, setSrc] = React.useState<string | null>(null)
    const [error, setError] = React.useState(false)
    // Retry re-arms the one load effect, so every attempt runs under the
    // same liveness guard and the same reset.
    const [attempt, setAttempt] = React.useState(0)

    React.useEffect(() => {
      if (load === undefined) return
      let live = true
      setError(false)
      setSrc(null)
      void load(attachment).then((url) => { if (live) setSrc(url) }).catch(() => { if (live) setError(true) })
      return () => { live = false }
    }, [attachment, load, attempt])

    const name = attachment.name ?? t('attach.image')
    const dims = attachment.width !== undefined && attachment.height !== undefined
      ? `${attachment.width}×${attachment.height}`
      : null
    const orig = attachment.originalDimensions
    const facts: string[] = []
    if (dims !== null) facts.push(dims)
    if (orig !== undefined) facts.push(t('attach.orig', { d: `${orig.width}×${orig.height}` }))
    if (attachment.bytes !== undefined) facts.push(fmtBytes(attachment.bytes))

    const open = (): void => {
      if (src === null) return
      try { window.open(src, '_blank', 'noopener') } catch { /* popup blocked: ignore */ }
    }
    return (
      <div className="lc-att-item">
        <button
          type="button"
          className="lc-att-thumb"
          title={error ? t('attach.loadFailed') : t('attach.open')}
          onClick={error ? () => { setAttempt(a => a + 1) } : open}
        >
          {src !== null
            ? <img src={src} alt={name} />
            : (
              <span className={error ? 'lc-att-err' : 'lc-att-ph'}>
                {error ? '⚠' : load === undefined ? '🖼' : t('attach.loading')}
              </span>
            )}
        </button>
        <div className="lc-att-meta">
          <span className="lc-att-name" title={name}>{name}</span>
          {facts.length > 0 ? <span className="lc-att-dims">{facts.join(' · ')}</span> : null}
        </div>
      </div>
    )
  }
}
