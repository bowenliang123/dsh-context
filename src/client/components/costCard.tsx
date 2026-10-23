/** The Context Insights panel's pricing disclosure card: the range's billed usage
 * folded by model, grouped under the provider that billed it — the vendor first,
 * its models' tokens, costs, unit rates and the book face each price read off (or
 * why none did). Groups start collapsed: the provider row answers "what did this
 * vendor cost", opening it answers "which models, at what rate". */

import { useState, type ReactElement } from 'react'
import { formatCost, formatPriceRate, toCurrency, type CostCurrency, type CostModelLine, type CostPrefs } from '../cost'
import { IconChevronDown, IconChevronUp } from '../primitives'
import type { ViewKit } from '../viewkit'

/** One provider's folded slice of the breakdown. A group is unpriced only when
 * every line in it is — a vendor with one mapped model keeps its priced total. */
export interface CostGroup {
  provider: string
  tokens: number
  /** The group's priced total (null: nothing in it priced). */
  cost: number | null
  /** How many of its models nothing priced. */
  unpriced: number
  lines: CostModelLine[]
}

/** Fold the flat breakdown into provider groups, keeping its priced-first order. */
export function costGroupsOf(lines: readonly CostModelLine[]): CostGroup[] {
  const groups = new Map<string, CostGroup>()
  for (const line of lines) {
    let group = groups.get(line.provider)
    if (group === undefined) {
      group = { provider: line.provider, tokens: 0, cost: null, unpriced: 0, lines: [] }
      groups.set(line.provider, group)
    }
    group.lines.push(line)
    group.tokens += line.tokens
    if (line.cost === null) group.unpriced += 1
    else group.cost = (group.cost ?? 0) + line.cost
  }
  return [...groups.values()]
}

export function makeCostCard(kit: ViewKit): (props: {
  /** The range's per-model breakdown (empty: the card renders nothing). */
  lines: readonly CostModelLine[]
  currency: CostCurrency
  /** The pricing preferences the figures were priced under — rates convert by them. */
  prefs: CostPrefs
}) => ReactElement | null {
  const { t, fmt } = kit
  return function CostCard(props: {
    lines: readonly CostModelLine[]
    currency: CostCurrency
    prefs: CostPrefs
  }): ReactElement | null {
    const [open, setOpen] = useState<readonly string[]>([])
    const groups = costGroupsOf(props.lines)
    if (groups.length === 0) return null
    const toggle = (provider: string): void => {
      setOpen(prev => prev.includes(provider) ? prev.filter(p => p !== provider) : [...prev, provider])
    }
    /** A book rate in the display currency (rates are USD per 1M tokens). */
    const rate = (usd: number): string => formatPriceRate(toCurrency(usd, props.currency, props.prefs), props.currency)
    const models = groups.reduce((n, g) => n + g.lines.length, 0)
    return (
      <div className="lc-card lc-ov-cost-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('ov.cost.title')}</span>
          <span className="lc-card-sub">{t('ov.cost.sub', { p: groups.length, m: models })}</span>
        </div>
        <div className="lc-ov-cost-groups">
          {groups.map((group) => {
            const expanded = open.includes(group.provider)
            return (
              <div key={group.provider} className={'lc-ov-cost-group' + (expanded ? ' lc-ov-cost-group-on' : '')}>
                <button
                  type="button"
                  className="lc-ov-cost-prow"
                  aria-expanded={expanded}
                  onClick={() => { toggle(group.provider) }}
                >
                  <span className="lc-ov-cost-caret">
                    {expanded ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
                  </span>
                  <span className="lc-ov-cost-pname">{group.provider}</span>
                  <span className="lc-ov-cost-pcount">{t('ov.cost.models', { n: group.lines.length })}</span>
                  {group.unpriced > 0 && (
                    <span className="lc-ov-cost-tag">{t('ov.cost.unpricedN', { n: group.unpriced })}</span>
                  )}
                  <span className="lc-ov-cost-ptokens">{fmt(group.tokens)}</span>
                  <span className={group.cost === null ? 'lc-ov-cost-pcost lc-ov-cost-muted' : 'lc-ov-cost-pcost'}>
                    {group.cost === null ? '—' : formatCost(group.cost, props.currency)}
                  </span>
                </button>
                {expanded && (
                  <table className="lc-ov-cost-table">
                    <thead>
                      <tr>
                        <th scope="col">{t('ov.cost.model')}</th>
                        <th scope="col">{t('ov.usage.tokens')}</th>
                        <th scope="col">{t('stats.cost')}</th>
                        <th scope="col" title={t('ov.cost.rateTip')}>{t('ov.cost.rate')}</th>
                        <th scope="col">{t('ov.cost.source')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.lines.map(line => (
                        <tr key={line.model}>
                          <td>
                            {line.model}
                            {/* The registry's spelling, when the billed id differs from the face the price read off. */}
                            {line.mid !== null && line.mid !== line.model && (
                              <>{' '}<span className="lc-ov-cost-face">{line.mid}</span></>
                            )}
                          </td>
                          <td>{fmt(line.tokens)}</td>
                          <td>{line.cost === null ? '—' : formatCost(line.cost, props.currency)}</td>
                          <td>
                            {line.rate === null ? '—' : (
                              <span title={t('ov.cost.rateTip')}>
                                {rate(line.rate.miss)} · {rate(line.rate.hit)} · {rate(line.rate.out)}
                              </span>
                            )}
                          </td>
                          <td className={line.cost === null ? 'lc-ov-cost-muted' : 'lc-ov-cost-src'}>
                            {line.cost === null ? (
                              <span title={line.pid === null ? undefined : t('ov.cost.mapTip')}>
                                {t('ov.cost.reason.' + line.reason)}
                                {line.pid === null ? '' : ` · ${line.pid}`}
                              </span>
                            ) : `${line.pid} · ${line.mid}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }
}
