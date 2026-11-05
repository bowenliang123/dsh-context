import { useEffect, useId, useState, type ReactElement } from 'react'
import { DEFAULT_RECOM, recomsOfPayload, type Recom, type RecomRead, type RecomsRead, type RecomText } from '../../shared/recoms'
import { RECOM_ROUTE } from '../apiRoutes'
import { IconShare } from '../primitives'
import type { ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'

const UNCACHED_STATE: RecomRead = { recom: DEFAULT_RECOM, degraded: false }

const textKeyOf = (value: RecomText): string => value.en + '\u0000' + value.zh

const shapeOf = (value: RecomRead): string =>
  [value.degraded ? '1' : '0', value.recom.id, value.recom.name, value.recom.url, value.recom.icon,
    textKeyOf(value.recom.slogan), textKeyOf(value.recom.promotion), textKeyOf(value.recom.tooltip)].join('\u0001')

let latest: RecomRead | null = null
let pool: Recom[] | null = null
let inFlight: Promise<RecomRead> | null = null

export function resetRecomCache(): void {
  latest = null
  pool = null
  inFlight = null
}

function nextCachedState(): RecomRead | null {
  if (pool === null) return null
  const index = pool.findIndex(item => item.id === latest?.recom.id)
  return { recom: pool[(index + 1) % pool.length], degraded: false }
}

async function requestRecoms(): Promise<RecomsRead | null> {
  try {
    const response = await fetch(RECOM_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (!response.ok) return null
    const payload = await response.json() as { value?: unknown; degraded?: unknown } | null
    const recoms = recomsOfPayload(payload?.value)
    return recoms.length === 0 ? null : { recoms, degraded: payload?.degraded === true }
  } catch {
    return null
  }
}

function loadRecom(): Promise<RecomRead> {
  if (inFlight !== null) return inFlight
  const request = requestRecoms().then((next) => {
    const read: RecomsRead = next ?? { recoms: [DEFAULT_RECOM], degraded: true }
    pool = read.degraded ? null : read.recoms
    const recom = read.recoms[Math.floor(Math.random() * read.recoms.length)]
    latest = { recom, degraded: read.degraded }
    return latest
  })
  const tracked = request.finally(() => {
    if (inFlight === tracked) inFlight = null
  })
  inFlight = tracked
  return tracked
}

function initialState(): RecomRead {
  return nextCachedState() ?? latest ?? UNCACHED_STATE
}

export function makeRecomCard(kit: ViewKit, ctx: ClientCtx): () => ReactElement {
  return function RecomCard(): ReactElement {
    kit.useLocaleTick()
    const locale = ctx.locale.getLocale?.().active === 'zh' ? 'zh' : 'en'
    const [state, setState] = useState<RecomRead>(initialState)
    const [iconState, setIconState] = useState<'loading' | 'loaded' | 'failed'>('loading')
    const tooltipId = useId()
    useEffect(() => {
      const cached = latest
      latest = state
      if (pool !== null) return
      let active = true
      void loadRecom().then((next) => {
        if (!active) return
        if (shapeOf(cached ?? UNCACHED_STATE) !== shapeOf(next)) {
          setIconState('loading')
          setState(next)
        }
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
        <div className="lc-recom-link">
          <div className="lc-recom-main">
            <div className={'lc-recom-mark' + (iconState === 'loaded' ? ' lc-recom-mark-loaded' : '')}>
              <span className="lc-recom-fallback" aria-hidden="true">{recom.name.charAt(0).toUpperCase()}</span>
              {iconState !== 'failed' ? (
                <img
                  src={recom.icon}
                  alt=""
                  onLoad={() => { setIconState('loaded') }}
                  onError={() => { setIconState('failed') }}
                />
              ) : null}
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
