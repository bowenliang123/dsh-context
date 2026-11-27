import { act } from 'react'
import type { RequestRecord } from '../../../src/shared/types'
import type { TimelineOverviewProps } from '../../../src/client/components/timelineOverview'
import { wheel } from '../helpers/kit'
import { req } from './timelineChartHarness'

export function propsOf(requests: RequestRecord[], over: Partial<TimelineOverviewProps> = {}): TimelineOverviewProps {
  return {
    requests,
    events: [],
    selectedSeq: null,
    hoveredSeq: null,
    activeTurn: null,
    granularity: 'step',
    mode: 'total',
    hoverCat: null,
    onSelect: () => {},
    onHover: () => {},
    onHoverTurn: () => {},
    onPickTurn: () => {},
    ...over,
  }
}

export function steps(count: number, perTurn = 1): RequestRecord[] {
  return Array.from({ length: count }, (_, i) => req(i + 1, { turn: Math.ceil((i + 1) / perTurn), step: i % perTurn }))
}

export async function wheelAt(target: Element, deltaX: number, deltaY: number, init: WheelEventInit = {}): Promise<boolean> {
  let prevented = false
  await act(async () => { prevented = wheel(target, deltaX, deltaY, init) })
  return prevented
}

export interface ScrollProbe {
  scrollLeft: number
}

export function probeScroll(scroller: HTMLElement, width: number | (() => number) = 400): ScrollProbe {
  const probe: ScrollProbe = { scrollLeft: 0 }
  const widthOf = typeof width === 'function' ? width : (): number => width
  Object.defineProperty(scroller, 'clientWidth', { configurable: true, get: widthOf })
  Object.defineProperty(scroller, 'scrollLeft', {
    configurable: true,
    get: () => probe.scrollLeft,
    set: (value: number) => {
      probe.scrollLeft = value
      scroller.dispatchEvent(new Event('scroll'))
    },
  })
  return probe
}
