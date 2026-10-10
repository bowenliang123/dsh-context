/** The Context emblem: the document sheet bundled from the package-root `icon.svg` (the file package.json
 * `icon` hands the Host) rather than read off the harness primitives, so the plugin's identity is
 * self-contained. The identity seats keep the sheet's fixed fills; only the sidebar's panel-list seat
 * opts into `mono`, the harness's own line weight. */

import sheetMarkup from '../../icon.svg?raw'
import { useId, type ReactElement } from 'react'
import type { Translate } from './i18n'

const SHEET_MARKUP = sheetMarkup
  .slice(sheetMarkup.indexOf('>') + 1, sheetMarkup.lastIndexOf('</svg>'))
  .trim()
  .replace(/>\s+</g, '><')

const SHEET_OUTLINE = SHEET_MARKUP.replace(/fill="#[0-9A-Fa-f]{6}"/g, '')

/** The harness icon set's line weight: one unit of its 16-unit box, which this artboard spells as 64. */
const HARNESS_STROKE = 1024 / 16

/** The source artboard's own bar weight: every pill and the dot measures 98 to 101 units. */
const SHEET_STROKE = 98

const INSET = (SHEET_STROKE - HARNESS_STROKE) / 2

/** The mask canvas: the artboard grown past every shifted copy of itself, so no edge clips. */
const CANVAS = { x: -2 * INSET, y: -2 * INSET, width: 1024 + 4 * INSET, height: 1024 + 4 * INSET }
const CANVAS_ATTRS = `x="${CANVAS.x}" y="${CANVAS.y}" width="${CANVAS.width}" height="${CANVAS.height}"`

const canvasRect = (fill: string, rest = ''): string => `<rect ${CANVAS_ATTRS} fill="${fill}"${rest}/>`

const SHIFTS: [number, number][] = [[INSET, 0], [-INSET, 0], [0, INSET], [0, -INSET]]

/** The mono seat's markup: the sheet masked down to the harness line weight rather than redrawn — the plugin
 * ships ONE artwork. Compositing, not `feMorphology`: that filter rounds its radius to whole device pixels
 * and would thin the glyph on a 2× display but not at 1×. */
function monoMarkup(id: string): string {
  const hole = `${id}-hole`
  const thin = `${id}-thin`
  const shifts = SHIFTS
    .map(([dx, dy]) => canvasRect('#000', ` mask="url(#${hole})" transform="translate(${dx} ${dy})"`))
    .join('')
  return '<defs>'
    + `<mask id="${hole}" maskUnits="userSpaceOnUse" ${CANVAS_ATTRS}>`
    + `${canvasRect('#fff')}<g fill="#000">${SHEET_OUTLINE}</g>`
    + '</mask>'
    + `<mask id="${thin}" maskUnits="userSpaceOnUse" ${CANVAS_ATTRS}>${canvasRect('#fff')}${shifts}</mask>`
    + '</defs>'
    + canvasRect('currentColor', ` mask="url(#${thin})"`)
}

/** The emblem's props, matching the harness `IconProps` the guide capsule hands it. */
export interface ContextIconProps {
  size?: number
  className?: string
  /** The sidebar panel-list seat: the surrounding text colour at the harness line weight, not the palette. */
  mono?: boolean
}

export function ContextIcon({ size = 20, className, mono = false }: ContextIconProps): ReactElement {
  // Mask defs are per instance: a second emblem would otherwise resolve `url(#…)` against this one's defs.
  const id = `dsh-context-sheet-${useId().replaceAll(':', '')}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      className={className}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      dangerouslySetInnerHTML={{ __html: mono ? monoMarkup(id) : SHEET_MARKUP }}
    />
  )
}

/** The sidebar panel-list glyph: the emblem in `mono`, so the shell-owned row's hover/active colors paint it
 *  like the shipped rows; the row's label and selected state are the shell's, so owner `active` goes unread. */
export function InsightPanelIcon({ size = 18 }: { size?: number }): ReactElement {
  return <ContextIcon size={size} mono />
}

/** The tab chip's title seat: the emblem before the label, read through the plugin's own bound translate so
 * the chip follows the locale — not the tab-information hook, which a not-yet-committed tab record can throw
 * on. The label's trailing gutter (`.lc-title-label`) keeps the active chip's fade off the last glyphs. */
export function makeContextTabTitle(t: Translate): () => ReactElement {
  return function ContextTabTitle(): ReactElement {
    return (
      <>
        <ContextIcon size={16} className="lc-title-icon" />
        <span className="lc-title-label">{t('tab.context')}</span>
      </>
    )
  }
}
