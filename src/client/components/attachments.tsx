import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { attachmentExtension } from '../../shared/attachment'
import type { AttachmentRef } from '../../shared/attachment'
import { estimateFileTokens } from '../../shared/fileTokens'
import { MAX_IMAGE_TOKENS, estimateImageTokens } from '../../shared/imageTokens'
import { fmtBytes } from '../format'
import type { AttachmentOpener, ImageLoader, ImageRefLike } from '../services'
import type { ViewKit } from '../viewkit'
import { FileTypeGlyph } from '../primitives'
import { Section } from './section'

export interface AttachmentKit {
  Section: (props: {
    attachments: readonly AttachmentRef[]
    load?: ImageLoader
    open?: AttachmentOpener
  }) => ReactElement
  load?: ImageLoader
  open?: AttachmentOpener
}

function imageRefOf(ref: AttachmentRef): ImageRefLike {
  return {
    attachmentId: ref.attachmentId,
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    ...(ref.bytes !== undefined ? { bytes: ref.bytes } : {}),
    ...(ref.width !== undefined ? { width: ref.width } : {}),
    ...(ref.height !== undefined ? { height: ref.height } : {}),
    ...(ref.originalDimensions !== undefined ? { originalDimensions: ref.originalDimensions } : {}),
  }
}

function nameOf(ref: AttachmentRef, t: ViewKit['t']): string {
  return ref.name ?? t(ref.kind === 'image' ? 'attach.image' : 'attach.file')
}

interface Fact {
  label: string
  value: string
  tip?: string
}

function typeOf(ref: AttachmentRef, t: ViewKit['t']): string {
  const ext = attachmentExtension(ref.name ?? '')
  if (ext !== '') return ext.toUpperCase().slice(0, 8)
  return ref.kind === 'image' ? t('attach.image') : t('attach.file')
}

function useImageSrc(attachment: AttachmentRef, load: ImageLoader | undefined): {
  src: string | null
  failed: boolean
} {
  const [state, setState] = useState<{ src: string | null; failed: boolean }>({ src: null, failed: false })
  const latest = useRef(attachment)
  latest.current = attachment
  const id = attachment.attachmentId
  useEffect(() => {
    if (load === undefined) {
      setState({ src: null, failed: false })
      return undefined
    }
    let live = true
    setState({ src: null, failed: false })
    void load(imageRefOf(latest.current)).then(
      (url) => { if (live) setState({ src: url, failed: false }) },
      () => { if (live) setState({ src: null, failed: true }) },
    )
    return () => { live = false }
  }, [id, load])
  return state
}

function factsOf(ref: AttachmentRef, t: ViewKit['t'], fmt: ViewKit['fmt']): Fact[] {
  const dimsOf = (w: number | undefined, h: number | undefined): string | null =>
    w !== undefined && h !== undefined ? `${w}×${h}` : null
  if (ref.kind !== 'image') {
    const rows: Fact[] = []
    if (ref.bytes !== undefined) rows.push({ label: t('attach.size'), value: fmtBytes(ref.bytes) })
    const tokens = estimateFileTokens(ref)
    if (tokens !== null) {
      rows.push({ label: t('attach.token'), value: `≈${fmt(tokens)}`, tip: t('attach.fileTokensTip') })
    }
    return rows
  }
  const rows: Fact[] = []
  const rawDims = ref.originalDimensions !== undefined
    ? dimsOf(ref.originalDimensions.width, ref.originalDimensions.height)
    : null
  if (rawDims !== null) rows.push({ label: t('attach.raw'), value: rawDims })
  const sent = dimsOf(ref.width, ref.height)
  if (sent !== null) {
    rows.push({
      label: t('attach.sent'),
      value: ref.bytes !== undefined ? `${sent} · ${fmtBytes(ref.bytes)}` : sent,
    })
  }
  const tokens = ref.width !== undefined && ref.height !== undefined
    ? estimateImageTokens(ref.width, ref.height)
    : null
  if (tokens !== null) {
    rows.push({ label: t('attach.token'), value: `≈${fmt(tokens)}`, tip: t('attach.imageTokensTip', { cap: MAX_IMAGE_TOKENS }) })
  }
  return rows
}

function AttachmentCard(props: {
  attachment: AttachmentRef
  load?: ImageLoader
  state: 'idle' | 'opening' | 'failed'
  onOpen: () => void
  t: ViewKit['t']
  fmt: ViewKit['fmt']
}): ReactElement {
  const { attachment, load, state, t, fmt } = props
  const name = nameOf(attachment, t)
  const image = attachment.kind === 'image'
  const thumb = useImageSrc(attachment, image ? load : undefined)
  const hint = t('attach.hint')
  return (
    <button
      type="button"
      className={'lc-att-item hover:border-(--dsw-alias-label-dimmed) hover:bg-[var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))]'
        + (state === 'failed' ? ' lc-att-item-failed' : '')}
      title={name + ' · ' + hint}
      data-state={state}
      aria-busy={state === 'opening'}
      onClick={props.onOpen}
    >
      <span className={'lc-att-thumb' + (image ? '' : ' lc-att-thumb-file')}>
        {image
          ? thumb.src !== null
            ? <img src={thumb.src} alt={name} />
            : (
              <span className={thumb.failed ? 'lc-att-err' : 'lc-att-ph'}>
                {thumb.failed ? '⚠' : load === undefined ? '🖼' : t('attach.loading')}
              </span>
            )
          : (
            <>
              <FileTypeGlyph path={name} size={28} />
              <span className="lc-att-ext">{typeOf(attachment, t)}</span>
            </>
          )}
        <span className={'lc-att-hint' + (state === 'opening' ? ' lc-att-hint-on' : '')}>
          <span className="lc-att-hint-label">{state === 'opening' ? t('attach.loading') : hint}</span>
        </span>
      </span>
      <span className="lc-att-meta">
        <span className="lc-att-name" title={name}>{name}</span>
        {image ? (
          <span className="lc-att-row"><b className="lc-att-row-label">{t('attach.type')}</b>{typeOf(attachment, t)}</span>
        ) : null}
        {factsOf(attachment, t, fmt).map(r => (
          <span key={r.label} className="lc-att-row" title={r.tip}>
            <b className="lc-att-row-label">{r.label}</b>{r.value}
          </span>
        ))}
        {state === 'failed' ? <span className="lc-att-fail">{t('attach.unavailable')}</span> : null}
      </span>
    </button>
  )
}

export function makeAttachmentSection(kit: ViewKit): AttachmentKit['Section'] {
  const { t, fmt } = kit
  return function AttachmentSection(props: {
    attachments: readonly AttachmentRef[]
    load?: ImageLoader
    open?: AttachmentOpener
  }): ReactElement {
    const { attachments, load, open } = props
    const [pending, setPending] = useState<string | null>(null)
    const [failed, setFailed] = useState<string | null>(null)
    const key = useMemo(() => attachments.map(a => a.attachmentId).join('\u0000'), [attachments])
    useEffect(() => {
      setPending(null)
      setFailed(null)
    }, [key])
    const activate = useCallback((ref: AttachmentRef) => {
      if (open === undefined) {
        setFailed(ref.attachmentId)
        return
      }
      setPending(ref.attachmentId)
      setFailed(null)
      void open(ref).then((taken) => {
        setPending(cur => (cur === ref.attachmentId ? null : cur))
        setFailed(taken ? null : ref.attachmentId)
      })
    }, [open])
    if (attachments.length === 0) return <></>
    return (
      <Section label={t('attach.title')} count={attachments.length}>
        <div className="lc-att-grid">
          {attachments.map((a, i) => (
            <AttachmentCard
              key={a.attachmentId + ':' + String(i)}
              attachment={a}
              load={load}
              t={t}
              fmt={fmt}
              state={pending === a.attachmentId ? 'opening' : failed === a.attachmentId ? 'failed' : 'idle'}
              onOpen={() => { activate(a) }}
            />
          ))}
        </div>
      </Section>
    )
  }
}
