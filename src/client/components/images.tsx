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
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { fmtBytes } from '../format'
import { React, ReactDOM } from '../react'
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
 * Document-level original-image preview — the chat history's ImageLightbox
 * recipe (dsh ui-attachment, which the browser module table does not seed)
 * ported onto the plugin's lc-* classes: body portal so a transformed or
 * filtered ancestor cannot trap the fixed backdrop, blurred mask layer,
 * contain-fit image, circular close control, Escape/mask close, and focus
 * restored to the opener on unmount.
 */
function AttachmentLightbox(props: {
  src: string
  alt: string
  labels: { dialog: string; close: string }
  onClose: () => void
}): ReactNS.ReactElement {
  const { src, alt, labels, onClose } = props
  const closeRef = React.useRef<HTMLButtonElement | null>(null)
  const restoreRef = React.useRef<HTMLElement | null>(null)

  React.useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      restoreRef.current?.focus()
    }
  }, [onClose])

  return ReactDOM.createPortal(
    <div className="lc-att-lightbox" role="dialog" aria-modal="true" aria-label={labels.dialog}>
      <div className="lc-att-lightbox-mask" aria-hidden="true" onMouseDown={onClose} />
      <img className="lc-att-lightbox-img" src={src} alt={alt} />
      <button ref={closeRef} type="button" className="lc-att-lightbox-close" aria-label={labels.close} onClick={onClose}>
        <IconCloseOutline16 size={16} />
      </button>
    </div>,
    document.body,
  )
}

/**
 * One attachment card: the WHOLE card is the click target — a 64px cover
 * tile beside a metadata column (display name, then one labeled row per
 * known fact: Raw, the pre-normalization raster dsh 0.1.1 records when
 * normalization reduced the image; Sent, the normalized raster the model
 * receives, with its stored byte size; and the estimated provider-billed
 * tokens). Clicking opens the chat-style lightbox preview (load failures
 * retry on click instead). Unknown facts leave no row behind.
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
    const [preview, setPreview] = React.useState(false)
    const closePreview = React.useCallback(() => { setPreview(false) }, [])

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

    const activate = (): void => {
      if (error) { setAttempt(a => a + 1); return }
      if (src !== null) setPreview(true)
    }
    return (
      <>
        <button
          type="button"
          className="lc-att-item"
          title={error ? t('attach.loadFailed') : t('attach.open')}
          onClick={activate}
        >
          <span className="lc-att-thumb">
            {src !== null
              ? <img src={src} alt={name} />
              : (
                <span className={error ? 'lc-att-err' : 'lc-att-ph'}>
                  {error ? '⚠' : load === undefined ? '🖼' : t('attach.loading')}
                </span>
              )}
          </span>
          <span className="lc-att-meta">
            <span className="lc-att-name" title={name}>{name}</span>
            {rows.map(r => (
              <span key={r.label} className="lc-att-row" title={r.tip}>
                <b className="lc-att-row-label">{r.label}</b>{r.value}
              </span>
            ))}
          </span>
        </button>
        {preview && src !== null && (
          <AttachmentLightbox
            src={src}
            alt={name}
            labels={{ dialog: t('attach.preview'), close: t('attach.close') }}
            onClose={closePreview}
          />
        )}
      </>
    )
  }
}
