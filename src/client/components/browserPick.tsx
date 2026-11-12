import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconCheck, IconChevronDown } from '../primitives'
import type { StepPickOption } from './browserHelpers'
import { ClearableInput } from './clearableInput'
import { useEscapeClose } from './escapeClose'
import { clampPopoverLeft } from './tip'

export interface StepPickProps {
  value: string
  options: readonly StepPickOption[]
  search: (query: string) => readonly StepPickOption[]
  searchPlaceholder: string
  emptyLabel: string
  clearLabel: string
  ariaLabel: string
  onChange: (value: string) => void
}

const VIEWPORT_MARGIN = 8

export function StepPick(props: StepPickProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [panelLeft, setPanelLeft] = useState<number | null>(null)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLSpanElement | null>(null)
  const listRef = useRef<HTMLSpanElement | null>(null)
  const idBase = useId()
  const listId = idBase + '-list'
  const optionId = (index: number): string => idBase + '-opt-' + String(index)

  const q = query.trim().toLowerCase()
  const rows = q === '' ? props.options : props.search(q)
  const selected = props.options.find(o => o.value === props.value)
  const selectedLabel = selected?.label ?? props.value
  const activeOf = rows.length === 0 ? -1 : Math.min(active, rows.length - 1)

  const close = useCallback((focusTrigger: boolean): void => {
    setOpen(false)
    setQuery('')
    setPanelLeft(null)
    if (focusTrigger) triggerRef.current?.focus()
  }, [])

  const dismiss = useCallback((): void => { close(false) }, [close])

  useDismissOnOutsidePointer(rootRef, open, dismiss)
  useEscapeClose(open, () => { close(true) }, false)

  useEffect(() => {
    if (!open) return undefined
    const onResize = (): void => { close(false) }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [open, close])

  useLayoutEffect(() => {
    if (!open) return
    const wrapEl = rootRef.current as HTMLSpanElement
    const panelEl = panelRef.current as HTMLSpanElement
    const rect = wrapEl.getBoundingClientRect()
    setPanelLeft(clampPopoverLeft(rect.right, panelEl.offsetWidth, window.innerWidth, VIEWPORT_MARGIN) - rect.left)
  }, [open])

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (!open) return
    const row = listRef.current?.children[activeOf] as HTMLElement | undefined
    row?.scrollIntoView({ block: 'nearest' })
  }, [open, activeOf, rows.length])

  const pick = (value: string): void => {
    props.onChange(value)
    close(true)
  }

  const show = (): void => {
    setOpen(true)
    setQuery('')
    setActive(Math.max(0, props.options.findIndex(o => o.value === props.value)))
  }

  const onSearchKeyDown = (ev: KeyboardEvent<HTMLInputElement>): void => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      if (rows.length === 0) return
      const step = ev.key === 'ArrowDown' ? 1 : -1
      setActive((activeOf + step + rows.length) % rows.length)
      return
    }
    if (ev.key === 'Enter') {
      ev.preventDefault()
      if (activeOf >= 0) pick(rows[activeOf].value)
      return
    }
    if (ev.key === 'Tab') close(true)
  }

  const onTriggerKeyDown = (ev: KeyboardEvent<HTMLButtonElement>): void => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return
    ev.preventDefault()
    show()
  }

  return (
    <span className="lc-br-pick-wrap" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={'lc-br-pick' + (open ? ' lc-br-pick-on' : '')}
        data-value={props.value}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={props.ariaLabel + ': ' + selectedLabel}
        onClick={() => { if (open) close(true); else show() }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="lc-br-pick-label">{selectedLabel}</span>
        <IconChevronDown size={12} />
      </button>
      {open ? (
        <span
          ref={panelRef}
          className="lc-br-pick-pop"
          style={panelLeft === null ? { right: 0, visibility: 'hidden' } : { left: panelLeft, right: 'auto' }}
        >
          <ClearableInput
            className="lc-br-pick-search"
            value={query}
            placeholder={props.searchPlaceholder}
            clearLabel={props.clearLabel}
            onChange={(value) => { setQuery(value); setActive(0) }}
            onKeyDown={onSearchKeyDown}
            inputRef={searchRef}
            combobox={{ controls: listId, active: activeOf >= 0 ? optionId(activeOf) : undefined }}
          />
          <span ref={listRef} id={listId} className="lc-br-pick-list" role="listbox" aria-label={props.ariaLabel}>
            {rows.length === 0
              ? <span className="lc-br-pick-empty">{props.emptyLabel}</span>
              : rows.map((o, i) => (
                <button
                  key={o.value}
                  id={optionId(i)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={o.value === props.value}
                  className={'lc-br-pick-opt' + (i === activeOf ? ' lc-br-pick-opt-on' : '')}
                  data-value={o.value}
                  onMouseEnter={() => { setActive(i) }}
                  onClick={() => { pick(o.value) }}
                >
                  <span className="lc-br-pick-tick">{o.value === props.value ? <IconCheck size={11} /> : null}</span>
                  <span className="lc-br-pick-opt-label">{o.label}</span>
                </button>
              ))}
          </span>
        </span>
      ) : null}
    </span>
  )
}
