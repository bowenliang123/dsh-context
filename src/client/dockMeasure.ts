interface DockMeasure {
  left: number
  right: number
  frame: HTMLElement | null
}

const LEADING_PX_TRACK = /^(\d+(?:\.\d+)?)px/
const CENTRE_MIN_TRACK = /^\s*minmax\(\s*([\d.]+)(?:px)?\s*,/
const TRAILING_PX_TRACK = /(\d+(?:\.\d+)?)px\)?$/

export function measureDock(start: HTMLElement | null): DockMeasure {
  try {
    for (let el = start?.parentElement ?? null; el !== null; el = el.parentElement) {
      const template = el.style.gridTemplateColumns
      if (template === '') continue
      const trimmed = template.trim()
      const lead = LEADING_PX_TRACK.exec(trimmed)
      if (lead === null) return { left: 0, right: 0, frame: null }
      const trail = TRAILING_PX_TRACK.exec(trimmed)
      if (trail === null || trail.index === 0) return { left: Number(lead[1]), right: 0, frame: el }
      const centreMin = CENTRE_MIN_TRACK.exec(trimmed.slice(lead[0].length))
      const bound = Number(trail[1])
      const centreFloor = centreMin === null ? 0 : Number(centreMin[1])
      return {
        left: Number(lead[1]),
        right: Math.min(bound, Math.max(0, window.innerWidth - Number(lead[1]) - centreFloor)),
        frame: el,
      }
    }
  } catch {}
  return { left: 0, right: 0, frame: null }
}
