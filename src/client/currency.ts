/** The display-currency preference: the settings store writes it, every money figure subscribes through
 *  {@link useDisplayCurrency}, and `auto` keeps the locale rule (zh → CNY, else USD). */

import { useSyncExternalStore } from 'react'
import type { DisplayCurrency } from '../shared/types'
import { resolveCurrency, type CostCurrency } from './cost'
import type { LocaleService } from './services'

let preference: DisplayCurrency = 'auto'
const listeners = new Set<() => void>()

export function setDisplayCurrencyPreference(next: DisplayCurrency): void {
  if (next === preference) return
  preference = next
  for (const listener of listeners) listener()
}

export function displayCurrencyFor(locale: LocaleService | string): CostCurrency {
  return resolveCurrency(preference, locale)
}

export function useDisplayCurrency(locale: LocaleService | string): CostCurrency {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    () => displayCurrencyFor(locale),
  )
}

export function resetDisplayCurrencyPreference(): void {
  setDisplayCurrencyPreference('auto')
}
