import sheetMarkup from '../../icon.svg?raw'
import { useId, type ReactElement } from 'react'
import type { Translate } from './i18n'

const SHEET_MARKUP = sheetMarkup
  .slice(sheetMarkup.indexOf('>') + 1, sheetMarkup.lastIndexOf('</svg>'))
  .trim()
  .replace(/>\s+</g, '><')

const SHEET_OUTLINE = SHEET_MARKUP.replace(/fill="#[0-9A-Fa-f]{6}"/g, '')

const HARNESS_STROKE = 1024 / 16

const SHEET_STROKE = 98

const INSET = (SHEET_STROKE - HARNESS_STROKE) / 2

const CANVAS = { x: -2 * INSET, y: -2 * INSET, width: 1024 + 4 * INSET, height: 1024 + 4 * INSET }
const CANVAS_ATTRS = `x="${CANVAS.x}" y="${CANVAS.y}" width="${CANVAS.width}" height="${CANVAS.height}"`

const canvasRect = (fill: string, rest = ''): string => `<rect ${CANVAS_ATTRS} fill="${fill}"${rest}/>`

const SHIFTS: [number, number][] = [[INSET, 0], [-INSET, 0], [0, INSET], [0, -INSET]]

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

interface ContextIconProps {
  size?: number
  className?: string
  mono?: boolean
}

export function ContextIcon({ size = 20, className, mono = false }: ContextIconProps): ReactElement {
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

export function InsightPanelIcon({ size = 18 }: { size?: number }): ReactElement {
  return <ContextIcon size={size} mono />
}

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
