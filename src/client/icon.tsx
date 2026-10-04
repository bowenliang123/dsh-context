/**
 * The Context emblem: the metered window, bundled rather than read off the
 * harness primitives so the plugin's identity is self-contained.
 *
 * The single graphic source is the package-root `icon.svg` — the same file
 * package.json `icon` hands to the Host's package-meta reader, which serves
 * it to the Plugins page's package cards. The client bundle inlines the
 * file's markup at build time (the `?raw` channel in tsdown.config.ts) and
 * re-renders it at every requested size. The identity seats (tab chip,
 * command, sidebar registration, panel head) keep the artwork's own paints —
 * deliberately polychrome on both light and dark chrome — while the
 * sidebar-foot entry seat (overviewButton.tsx) opts into `mono`, trading
 * every paint for `currentColor` so the glyph sits quietly beside the
 * harness's own footer rows (Settings and friends).
 */

import { useId, type ReactElement } from 'react'
import sheetMarkup from '../../icon.svg?raw'
import type { Translate } from './i18n'

/** Everything between the file's `<svg>` tags: the artwork in paint order, whitespace-folded. */
const ARTWORK = sheetMarkup
  .slice(sheetMarkup.indexOf('>') + 1, sheetMarkup.lastIndexOf('</svg>'))
  .trim()
  .replace(/>\s+</g, '><')

/**
 * The mono seat's paints: the same geometry with every palette colour and
 * gradient reference traded for the surrounding text colour. `stop-color`
 * inside the now-unreferenced `<defs>` is left alone — nothing paints from it.
 */
const ARTWORK_MONO = ARTWORK.replace(/(fill|stroke)="(#[0-9A-Fa-f]{6}|url\(#[^)]+\))"/g, '$1="currentColor"')

/**
 * Carry one instance's id through the artwork's gradient ids. The same markup
 * renders in the tab chip, the command row, the sidebar registration and the
 * panel head at once, and a repeated `url(#…)` resolves to whichever copy the
 * document holds first — so an earlier seat unmounting could strand a later
 * one's gradient. The harness primitives scope their own artwork ids the same
 * way.
 * @param markup - the artwork, as the file supplied it.
 * @param uid - this instance's `useId`, colons stripped so it is a legal URL fragment.
 * @returns the same markup with the artwork's id prefix carrying the instance.
 */
const scopeArtwork = (markup: string, uid: string): string => markup.replaceAll('ctx_meter_', `ctx_meter_${uid}_`)

/** The emblem's props, matching the harness `IconProps` the guide capsule hands it. */
export interface ContextIconProps {
  /** Square edge in px. */
  size?: number
  /** Extra class for layout placement. */
  className?: string
  /** Render in the surrounding text colour instead of the palette (the sidebar-foot entry seat). */
  mono?: boolean
}

/** The metered window at the requested square edge — polychrome by default, text-coloured in `mono`. */
export function ContextIcon({ size = 20, className, mono = false }: ContextIconProps): ReactElement {
  const uid = useId().replaceAll(':', '')
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      className={className}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      dangerouslySetInnerHTML={{ __html: scopeArtwork(mono ? ARTWORK_MONO : ARTWORK, uid) }}
    />
  )
}

/**
 * The tab chip's title seat (`sidebar.right.pane.tab.title`): the emblem before
 * the label, so the chip reads as the files chip does. The label comes from the
 * plugin's own bound translate — read at render, so the chip follows the active
 * locale — rather than the tab-information hook, which a foreign or
 * not-yet-committed tab record can throw on. It carries a trailing gutter
 * (`.lc-title-label`) so the active chip's fade lands past the text, never on
 * the last glyphs.
 * @param t - the plugin-namespace translate bound in `apply`.
 * @returns the title component to register under the tab type's id.
 */
export function makeContextTabTitle(t: Translate): () => ReactElement {
  return function ContextTabTitle(): ReactElement {
    return (
      <>
        <ContextIcon size={16} className="lc-title-icon" />
        <span className="lc-title-label">{t('tab')}</span>
      </>
    )
  }
}
