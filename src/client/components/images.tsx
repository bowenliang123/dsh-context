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
import { estimateImageTokens } from '../../shared/imageTokens'
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
 * name, then one labeled row per known fact: Raw (the pre-normalization
 * raster dsh 0.1.1 records when normalization reduced the image), Sent (the
 * normalized raster the model receives, with its stored byte size), and the
 * estimated provider-billed tokens. Unknown facts leave no row behind.
 */
export function makeImageCard(kit: ViewKit): ImageKit['Card'] {
  const { t, fmt } = kit
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
    const dimsOf = (w: number | undefined, h: number | undefined): string | null =>
      w !== undefined && h !== undefined ? `${w}×${h}` : null
    const rows: Array<{ label: string; value: string; tip?: string }> = []
    // No byte size is stored for the raw raster — dims only.
    const raw = attachment.originalDimensions !== undefined
      ? dimsOf(attachment.originalDimensions.width, attachment.originalDimensions.height)
      : null
    if (raw !== null) rows.push({ label: t('attach.raw'), value: raw })
    const sent = dimsOf(attachment.width, attachment.height)
    if (sent !== null) {
      rows.push({
        label: t('attach.sent'),
        value: attachment.bytes !== undefined ? `${sent} · ${fmtBytes(attachment.bytes)}` : sent,
      })
    }
    // Estimated provider-billed tokens for this image (the official DeepSeek
    // docs calculator on the stored dimensions; 117-384 per the vision
    // guide's cap). Shown whenever the normalized dimensions are known.
    const tokens = attachment.width !== undefined && attachment.height !== undefined
      ? estimateImageTokens(attachment.width, attachment.height)
      : null
    if (tokens !== null) rows.push({ label: t('attach.token'), value: `≈${fmt(tokens)}`, tip: t('attach.tokensTip') })

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
          {rows.map(r => (
            <span key={r.label} className="lc-att-row" title={r.tip}>
              <b className="lc-att-row-label">{r.label}</b>{r.value}
            </span>
          ))}
        </div>
      </div>
    )
  }
}
