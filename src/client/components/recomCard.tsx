import { useEffect, useId, useState, type ReactElement } from 'react'
import { siDeepseek } from 'simple-icons'
import { DEFAULT_RECOM, recomOf, type RecomRead, type RecomText } from '../../shared/recoms'
import { RECOM_ROUTE } from '../apiRoutes'
import { IconShare } from '../primitives'
import type { ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'

const UNCACHED_STATE: RecomRead = { recom: DEFAULT_RECOM, degraded: false }
const DEGRADED_STATE: RecomRead = { recom: DEFAULT_RECOM, degraded: true }

const textKeyOf = (value: RecomText): string => value.en + '\u0000' + value.zh

const shapeOf = (value: RecomRead): string =>
  [value.degraded ? '1' : '0', value.recom.id, value.recom.name, value.recom.url, value.recom.icon,
    textKeyOf(value.recom.slogan), textKeyOf(value.recom.promotion), textKeyOf(value.recom.tooltip)].join('\u0001')

let latest: RecomRead | null = null

export function resetRecomCache(): void {
  latest = null
}

async function requestRecom(): Promise<RecomRead | null> {
  try {
    const response = await fetch(RECOM_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (!response.ok) return null
    const payload = await response.json() as { value?: unknown; degraded?: unknown } | null
    const recom = recomOf(payload?.value)
    return recom === null ? null : { recom, degraded: payload?.degraded === true }
  } catch {
    return null
  }
}

export function makeRecomCard(kit: ViewKit, ctx: ClientCtx): () => ReactElement {
  const { t } = kit
  return function RecomCard(): ReactElement {
    kit.useLocaleTick()
    const locale = ctx.locale.getLocale?.().active === 'zh' ? 'zh' : 'en'
    const [state, setState] = useState<RecomRead>(() => latest ?? UNCACHED_STATE)
    const [iconFailed, setIconFailed] = useState(false)
    const tooltipId = useId()
    useEffect(() => {
      const cached = latest
      let active = true
      void requestRecom().then((next) => {
        if (!active) return
        const settled = next ?? cached ?? DEGRADED_STATE
        if (shapeOf(cached ?? UNCACHED_STATE) !== shapeOf(settled)) {
          setIconFailed(false)
          setState(settled)
        }
        latest = settled
      })
      return () => { active = false }
    }, [])
    const { recom, degraded } = state
    const text = (value: RecomText): string => value[locale]
    return (
      <a
        className={'lc-card lc-recom' + (degraded ? ' lc-recom-degraded' : '')}
        href={recom.url}
        target="_blank"
        rel="noreferrer"
        aria-describedby={tooltipId}
      >
        <div className="lc-card-title">
          <span className="lc-card-title-text">
            <svg className="lc-recom-titlemark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 14.5 9.5 21 12 14.5 14.5 12 21 9.5 14.5 3 12 9.5 9.5Z" /></svg>
            <span className="lc-recom-title">{t('recom.title')}</span>
          </span>
        </div>
        <div className="lc-recom-link">
          <div className="lc-recom-main">
            <div className="lc-recom-mark">
              {iconFailed ? (
                <svg viewBox="0 0 24 24" className="lc-recom-fallback" aria-hidden="true"><path d={siDeepseek.path} fill="currentColor" /></svg>
              ) : (
                <img src={recom.icon} alt="" onError={() => { setIconFailed(true) }} />
              )}
            </div>
            <div className="lc-recom-copy">
              <div className="lc-recom-brand"><span>{recom.name}</span></div>
              <div className="lc-recom-slogan">{text(recom.slogan)}</div>
            </div>
          </div>
          <div className="lc-recom-promo"><span className="lc-recom-spark" aria-hidden="true">✦</span><span>{text(recom.promotion)}</span></div>
          <IconShare size={14} className="lc-recom-arrow" />
        </div>
        <div className="lc-recom-tooltip" role="tooltip" id={tooltipId}>{text(recom.tooltip)}</div>
      </a>
    )
  }
}
