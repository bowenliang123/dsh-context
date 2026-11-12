import { useRef, type KeyboardEvent, type ReactElement, type RefObject } from 'react'
import { IconClose } from '../primitives'

export interface ClearableInputProps {
  value: string
  onChange: (value: string) => void
  className: string
  placeholder: string
  label?: string
  clearLabel: string
  type?: 'search' | 'text'
  onKeyDown?: (ev: KeyboardEvent<HTMLInputElement>) => void
  inputRef?: RefObject<HTMLInputElement>
  combobox?: { controls: string; active?: string | undefined }
}

export function isClearableField(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
  return (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
    && target.dataset.lcClearable !== undefined
}

export function ownsClearEscape(target: EventTarget | null): boolean {
  return isClearableField(target) && target.value !== ''
}

export function isBareEscape(ev: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): boolean {
  return ev.key === 'Escape' && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey
}

export function clearOnEscape(
  ev: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  clear: () => void,
): void {
  if (!isBareEscape(ev) || ev.nativeEvent.isComposing || !ownsClearEscape(ev.target)) return
  ev.preventDefault()
  ev.stopPropagation()
  clear()
}

export function ClearButton(props: { label: string; onClick: () => void; className?: string }): ReactElement {
  return (
    <button
      type="button"
      className={'lc-searchbox-x' + (props.className !== undefined ? ' ' + props.className : '')}
      title={props.label}
      aria-label={props.label}
      onMouseDown={(ev) => { ev.preventDefault() }}
      onClick={props.onClick}
    >
      <IconClose size={10} />
    </button>
  )
}

export function ClearableInput(props: ClearableInputProps): ReactElement {
  const ownRef = useRef<HTMLInputElement>(null)
  const ref = props.inputRef ?? ownRef
  const filled = props.value !== ''
  const handleKeyDown = (ev: KeyboardEvent<HTMLInputElement>): void => {
    props.onKeyDown?.(ev)
    if (ev.defaultPrevented) return
    clearOnEscape(ev, () => { props.onChange('') })
  }
  return (
    <span className={'lc-searchbox' + (filled ? ' lc-searchbox-on' : '')}>
      <input
        ref={ref}
        type={props.type ?? 'text'}
        className={props.className}
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.label ?? props.placeholder}
        data-lc-clearable=""
        role={props.combobox === undefined ? undefined : 'combobox'}
        aria-expanded={props.combobox === undefined ? undefined : true}
        aria-controls={props.combobox?.controls}
        aria-activedescendant={props.combobox?.active}
        aria-autocomplete={props.combobox === undefined ? undefined : 'list'}
        onChange={(ev) => { props.onChange(ev.target.value) }}
        onKeyDown={handleKeyDown}
      />
      {filled ? (
        <ClearButton label={props.clearLabel} onClick={() => { props.onChange(''); ref.current?.focus() }} />
      ) : null}
    </span>
  )
}
