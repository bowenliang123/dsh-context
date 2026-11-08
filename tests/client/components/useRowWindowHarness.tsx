import { act, createElement as h, useCallback, useMemo, useRef } from 'react'
import { useSurfaceWindow, type SurfaceWindow, type SurfaceWindowOptions } from '../../../src/client/components/useRowWindow'

export const estimateAt = (size: number) => (): number => size

export function keysOf(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `row-${index}`)
}

export interface ProbeProps {
  count: number
  keys?: readonly string[]
  options?: Partial<SurfaceWindowOptions>
  attachRef?: boolean
  onScope?: (scope: SurfaceWindow) => void
  rows?: (keys: readonly string[], scope: SurfaceWindow) => ReturnType<typeof h>[]
}

export function Probe(props: ProbeProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const keys = useMemo(() => props.keys ?? keysOf(props.count), [props.keys, props.count])
  const getKey = useCallback((index: number): string => keys[index] ?? '', [keys])
  const options: SurfaceWindowOptions = { ...(props.options ?? {}), count: props.count, getKey }
  const scope = useSurfaceWindow(ref, options)
  props.onScope?.(scope)
  const rows = props.rows === undefined ? keys.map((key, index) => ({ key, index })) : null
  return h('div', {
    ...(props.attachRef === false ? {} : { ref }),
    onKeyDown: scope.onKeyDown,
    'data-from': scope.from,
    'data-to': scope.to,
    'data-top': scope.topPad,
    'data-bottom': scope.bottomPad,
    'data-enabled': String(scope.enabled),
  },
  rows === null
    ? props.rows?.(keys, scope)
    : rows.slice(scope.from, scope.to + 1).map(({ key, index }) => h('div', {
      key,
      'data-row': key,
      ref: scope.measure(key),
    }, h('button', { 'data-focus': key, tabIndex: scope.tabIndexFor(key) }, key + ':' + String(index)))),
  h('input', { key: 'guard-input', 'data-guard': 'input' }),
  h('div', { key: 'guard-editable', 'data-guard': 'editable', contentEditable: true }))
}

export class ControlledResizeObserver {
  static all: ControlledResizeObserver[] = []
  readonly targets: Element[] = []
  constructor(readonly callback: ResizeObserverCallback) { ControlledResizeObserver.all.push(this) }
  static reset(): void { ControlledResizeObserver.all = [] }
  static rowObserver(): ControlledResizeObserver {
    const found = ControlledResizeObserver.all.find(entry => entry.targets.some(target => (target as HTMLElement).dataset?.row !== undefined))
    if (found === undefined) throw new Error('no row observer')
    return found
  }
  observe(target: Element): void { this.targets.push(target) }
  unobserve(target: Element): void {
    const at = this.targets.indexOf(target)
    if (at >= 0) this.targets.splice(at, 1)
  }
  disconnect(): void { this.targets.length = 0 }
  settle(height: number, target: Element | undefined = this.targets[0], border = true): void {
    this.callback(
      [{
        target,
        ...(border ? { borderBoxSize: [{ blockSize: height, inlineSize: 400 }] } : {}),
        contentRect: { height },
      } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
}

export function sizeOf(el: HTMLElement, height: number, width = 300): void {
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: height })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: width })
}

export function pinBox(el: Element, top: number, height: number, left = 0, width = 300): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      top, left, height, width, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}),
    }) as DOMRect,
  })
}

export function pinScrollX(el: HTMLElement): void {
  let value = 0
  Object.defineProperty(el, 'scrollLeft', {
    configurable: true,
    get: () => value,
    set: (next: number) => { value = next },
  })
}

export async function scrollBy(el: HTMLElement, top: number, frames?: FrameRequestCallback[]): Promise<void> {
  el.scrollTop = top
  await act(async () => { el.dispatchEvent(new Event('scroll')) })
  if (frames !== undefined) await act(async () => { for (const frame of frames.splice(0)) frame(0) })
  else await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  await act(async () => {})
}

export function numbers(el: HTMLElement): { from: number; to: number; top: number; bottom: number } {
  return {
    from: Number(el.dataset.from),
    to: Number(el.dataset.to),
    top: Number(el.dataset.top),
    bottom: Number(el.dataset.bottom),
  }
}
