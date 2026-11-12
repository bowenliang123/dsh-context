import { useEffect, useRef } from 'react'
import { isBareEscape, isClearableField, ownsClearEscape } from './clearableInput'

const layers: symbol[] = []

export function useEscapeClose(active: boolean, onClose: () => void, restoreFocus = true): void {
  const close = useRef(onClose)
  close.current = onClose
  const layer = useRef(Symbol())
  useEffect(() => {
    if (!active) return undefined
    const id = layer.current
    layers.push(id)
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKey = (ev: KeyboardEvent): void => {
      if (layers[layers.length - 1] !== id) return
      if (!isBareEscape(ev)) return
      const target = ev.target
      if (isClearableField(target) && (ev.isComposing || ownsClearEscape(target))) {
        if (ev.isComposing) ev.stopPropagation()
        return
      }
      ev.preventDefault()
      ev.stopPropagation()
      close.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      layers.splice(layers.indexOf(id), 1)
      if (restoreFocus && previous !== null && document.contains(previous)) previous.focus()
    }
  }, [active, restoreFocus])
}
