/** Balance pill: paints the remembered figure while client/balance.ts revalidates, and renders nothing until a figure exists. */

import { useState, type ReactElement } from 'react'
import { balanceEntryOf, readPlatformBalance } from '../balance'
import { useDisplayCurrency } from '../currency'
import type { PlatformBalance } from '../../shared/types'
import type { ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'

function symbolOf(currency: string): string {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  return currency + ' '
}

const USAGE_URL = 'https://platform.deepseek.com/usage'

export function makeBalanceCapsule(ctx: ClientCtx, kit: ViewKit): () => ReactElement | null {
  const { t } = kit
  return function BalanceCapsule(): ReactElement | null {
    const [balance, setBalance] = useState<PlatformBalance | null>(() => readPlatformBalance((v) =>{  setBalance(v) }))
    const entry = balanceEntryOf(balance, useDisplayCurrency(ctx.locale))
    if (entry === null) return null
    const money = (amount: number): string => symbolOf(entry.currency) + amount.toFixed(2)
    const tipLines = [
      ...(entry.toppedUp > 0 ? [t('balance.tip.toppedUp') + ': ' + money(entry.toppedUp)] : []),
      ...(entry.granted > 0 ? [t('balance.tip.granted') + ': ' + money(entry.granted)] : []),
    ]
    return (
      <a
        className="lc-ov-balance"
        aria-label={tipLines.length > 0 ? tipLines.join('\n') : undefined}
        {...(tipLines.length > 0 ? { 'data-lc-tip': tipLines.join('\n'), 'data-lc-tip-side': 'bottom' } : {})}
        href={USAGE_URL}
        target="_blank"
        rel="noreferrer"
      >
        <span className="lc-ov-balance-label">{t('balance.title')}</span>
        <span className="lc-ov-balance-value">{money(entry.total)}</span>
      </a>
    )
  }
}
