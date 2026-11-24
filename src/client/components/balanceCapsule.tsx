import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { balanceEntryOf, readPlatformBalances } from '../balance'
import { IconCheck, IconChevronDown } from '../primitives'
import type { BalanceSource, PlatformBalanceEntry, PlatformBalances } from '../../shared/types'
import type { ContextSettings } from '../settings'
import type { ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'
import { useAnchoredPanel } from './anchoredPanel'
import { useEscapeClose } from './escapeClose'

const USAGE_URL = 'https://platform.deepseek.com/usage'

const PANEL_ID = 'lc-bal-panel'

const SOURCES: readonly BalanceSource[] = ['account', 'api']

const LABELS: Record<BalanceSource, string> = {
  account: 'balance.account',
  api: 'balance.api',
}

const ROWS = [
  ['balance.total', 'total'],
  ['balance.toppedUp', 'toppedUp'],
  ['balance.granted', 'granted'],
] as const

function symbolOf(currency: string): string {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  return currency + ' '
}

function money(amount: number, currency: string): string {
  return symbolOf(currency) + amount.toFixed(2)
}

interface SourceRow {
  source: BalanceSource
  entry: PlatformBalanceEntry
}

export function makeBalanceCapsule(ctx: ClientCtx, kit: ViewKit, settings: ContextSettings): () => ReactElement | null {
  const { t } = kit
  const subscribeSettings = settings.store.subscribe.bind(settings.store)
  return function BalanceCapsule(): ReactElement | null {
    const [balances, setBalances] = useState<PlatformBalances | null>(() => readPlatformBalances((v) => { setBalances(v) }))
    const configured = useSyncExternalStore(subscribeSettings, () => settings.balanceSource())
    const [picked, setPicked] = useState<BalanceSource | null>(null)
    const [open, setOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    const panelRef = useRef<HTMLDivElement | null>(null)
    const close = (): void => { setOpen(false) }
    useEscapeClose(open, close)
    const spot = useAnchoredPanel(open, triggerRef, panelRef, close)
    const measured = spot !== null
    useEffect(() => {
      if (!open || !measured) return
      panelRef.current?.focus()
    }, [open, measured])

    const locale = ctx.locale
    const active = typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
    const currency = active === 'zh' ? 'cny' : 'usd'
    const rows: SourceRow[] = []
    for (const source of SOURCES) {
      const entry = balanceEntryOf(balances?.[source] ?? null, currency)
      if (entry !== null) rows.push({ source, entry })
    }

    if (rows.length === 0) return null
    const preferred = picked ?? configured
    const current = rows.find(row => row.source === preferred) ?? rows[0]

    const select = (next: BalanceSource): void => {
      setPicked(next)
      setOpen(false)
      triggerRef.current?.focus()
      const state = settings.store.getSnapshot()
      if (state.status === 'ready' && state.writable) settings.set('balanceSource', next)
    }

    const toggle = (): void => {
      if (open) {
        setOpen(false)
        return
      }
      setOpen(true)
    }

    return (
      <div className="lc-bal">
        <button
          ref={triggerRef}
          type="button"
          className="lc-ov-balance"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? PANEL_ID : undefined}
          onClick={toggle}
        >
          {rows.length > 1
            ? <IconChevronDown className={'lc-ov-balance-caret' + (open ? ' lc-ov-balance-caret-open' : '')} size={12} />
            : null}
          <span className="lc-ov-balance-label">{t(LABELS[current.source])}</span>
          <span className="lc-ov-balance-value">{money(current.entry.total, current.entry.currency)}</span>
        </button>
        {open ? createPortal(
          <div
            ref={panelRef}
            id={PANEL_ID}
            tabIndex={-1}
            className="lc-tip lc-bal-panel"
            role="dialog"
            aria-label={t('balance.title')}
            style={spot === null ? { left: 0, top: 0, visibility: 'hidden' } : { left: spot.left, top: spot.top }}
          >
            {rows.map(({ source, entry }) => (
              <button
                key={source}
                type="button"
                className={'lc-bal-option' + (source === current.source ? ' lc-bal-option-on' : '')}
                aria-pressed={source === current.source}
                onClick={() => { select(source) }}
              >
                <span className="lc-bal-option-head">
                  <span className="lc-bal-option-name">{t(LABELS[source])}</span>
                  {source === current.source ? <IconCheck className="lc-bal-option-check" size={12} /> : null}
                </span>
                <span className="lc-bal-rows">
                  {ROWS.map(([label, field]) => (
                    <span key={label} className="lc-bal-row">
                      <span className="lc-bal-row-label">{t(label)}</span>
                      <span className="lc-bal-row-value">{money(entry[field], entry.currency)}</span>
                    </span>
                  ))}
                </span>
              </button>
            ))}
            <a className="lc-bal-usage" href={USAGE_URL} target="_blank" rel="noreferrer">{t('balance.usage')}</a>
          </div>,
          document.body,
        ) : null}
      </div>
    )
  }
}
