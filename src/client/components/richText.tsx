import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type RefObject } from 'react'
import { JsonTree, MarkdownText, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JsonTreeLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconCheck, IconChevronDown, IconChevronUp, IconClose, IconCopy, IconSearch } from '../primitives'
import type { ViewKit } from '../viewkit'
import { ClearableInput, isBareEscape } from './clearableInput'
import { scrollIntoViewIfPossible } from '../revealScroll'

export type RichMode = 'raw' | 'md' | 'json'

interface MarkdownChrome {
  code: { copyLabel: string; copiedLabel: string }
  footnotes: string
}

const Markdown = MarkdownText as (props: { text: string; labels?: MarkdownChrome }) => ReactElement

export function jsonOf(text: string): object | unknown[] | null {
  const s = text.trim()
  if (s[0] !== '{' && s[0] !== '[') return null
  try {
    return JSON.parse(s) as object
  } catch {
    return null
  }
}

const JSON_EXPAND_MAX = 100

export interface RichKit {
  RichText: (props: { text: string; mode: RichMode }) => ReactElement
  RichSwitch: (props: { mode: RichMode; json?: boolean; onPick: (mode: RichMode) => void }) => ReactElement
  RichCopy: (props: { text: string }) => ReactElement
  useRichMode: (text: string) => [RichMode, (mode: RichMode) => void, boolean]
  useRichFind: (text: string, mode: RichMode) => RichFind
}

export interface RichFind {
  button: ReactElement
  bar: ReactElement | null
  bodyKey: string
  bodyRef: RefObject<HTMLDivElement>
}

const FIND_DEBOUNCE_MS = 150
const FIND_MAX_MATCHES = 500

interface FindMarks {
  count: number
  capped: boolean
  restore: () => void
}

function textNodesOf(root: HTMLElement): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text)
  return nodes
}

function markMatches(root: HTMLElement, query: string, active: number): FindMarks {
  const needle = query.toLowerCase()
  const nodes = textNodesOf(root)
  const starts: number[] = []
  const ends: number[] = []
  let text = ''
  for (const node of nodes) {
    starts.push(text.length)
    text += node.data
    ends.push(text.length)
  }
  const lower = text.toLowerCase()
  const ranges: { from: number; to: number }[] = []
  for (let at = lower.indexOf(needle); at !== -1 && ranges.length <= FIND_MAX_MATCHES; at = lower.indexOf(needle, at + needle.length)) {
    ranges.push({ from: at, to: at + needle.length })
  }
  const capped = ranges.length > FIND_MAX_MATCHES
  if (capped) ranges.pop()
  const full = new Map<Text, string>()
  const created: Node[] = []
  const groups: HTMLElement[][] = []
  for (let index = ranges.length - 1; index >= 0; index--) {
    const { from, to } = ranges[index]
    const group: HTMLElement[] = []
    for (const [at, node] of nodes.entries()) {
      if (ends[at] <= from || starts[at] >= to) continue
      const localFrom = Math.max(from, starts[at]) - starts[at]
      const localTo = Math.min(to, ends[at]) - starts[at]
      if (!full.has(node)) full.set(node, node.data)
      const piece = node.splitText(localFrom)
      const tail = piece.splitText(localTo - localFrom)
      const mark = document.createElement('mark')
      mark.className = 'lc-find-mark'
      piece.before(mark)
      mark.appendChild(piece)
      created.push(mark, tail)
      group.push(mark)
    }
    groups[index] = group
  }
  const on = Math.min(active, ranges.length - 1)
  if (on >= 0) {
    const group = groups[on]
    for (const mark of group) mark.classList.add('lc-find-mark-on')
    scrollIntoViewIfPossible(group[0], { block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }
  return {
    count: ranges.length,
    capped,
    restore: () => {
      for (const [node, data] of full) node.data = data
      for (const c of created) c.parentNode?.removeChild(c)
    },
  }
}

export function makeRichText(kit: ViewKit): RichKit {
  const { t } = kit

  function useRichMode(text: string): [RichMode, (mode: RichMode) => void, boolean] {
    const json = useMemo(() => jsonOf(text) !== null, [text])
    const [pick, setPick] = useState<RichMode | null>(null)
    const mode: RichMode = pick === 'raw' ? 'raw' : pick === 'json' && json ? 'json' : json ? 'json' : 'md'
    return [mode, setPick, json]
  }

  function RichSwitch(props: { mode: RichMode; json?: boolean; onPick: (mode: RichMode) => void }): ReactElement {
    const seg = (m: RichMode, label: string, tip: string) => (
      <button
        type="button"
        className={'lc-gran-btn' + (props.mode === m ? ' lc-gran-on' : '')}
        title={tip}
        onClick={() => { props.onPick(m) }}
      >{label}</button>
    )
    return (
      <span className="lc-gran">
        {seg('raw', t('rich.raw'), t('rich.toRaw'))}
        {props.json === true
          ? seg('json', t('rich.json'), t('rich.toJson'))
          : seg('md', t('rich.md'), t('rich.toMd'))}
      </span>
    )
  }

  function RawText(props: { text: string }): ReactElement {
    const lines = useMemo(() => {
      const parts = props.text.split('\n')
      return parts.length > 1 && parts[parts.length - 1] === '' ? parts.slice(0, -1) : parts
    }, [props.text])
    return (
      <pre className="lc-ts-desc-body lc-ts-lines">
        {lines.map((line, index) => (
          <span key={index} className="lc-ts-line">{line}</span>
        ))}
      </pre>
    )
  }

  function RichCopy(props: { text: string }): ReactElement {
    const [copied, setCopied] = useState(false)
    const onCopy = useCallback(() => {
      if (copied) return
      void writeClipboard(props.text).then((ok) => {
        if (!ok) return
        setCopied(true)
        window.setTimeout(() => { setCopied(false) }, 1200)
      })
    }, [copied, props.text])
    const label = copied ? t('rich.copied') : t('rich.copy')
    return (
      <button
        type="button"
        className={'lc-rich-copy' + (copied ? ' lc-rich-copy-on' : '')}
        title={label}
        aria-label={label}
        onClick={onCopy}
      >
        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      </button>
    )
  }

  function JsonBody(props: { data: object | unknown[]; labels: JsonTreeLabels }): ReactElement {
    const ref = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
      const root = ref.current
      /* v8 ignore next 2 */
      if (root === null) return
      const previous = document.activeElement as HTMLElement | null
      let clicked = 0
      for (const el of root.querySelectorAll('[role=tree] > [role=treeitem] > [data-json-expander]')) {
        if (clicked >= JSON_EXPAND_MAX) break
        if (el.getAttribute('aria-expanded') !== 'false') continue
        ;(el as HTMLElement).click()
        clicked += 1
      }
      /* v8 ignore next 1 */
      if (clicked > 0) previous?.focus({ preventScroll: true })
    }, [props.data])
    return (
      <div ref={ref} className="lc-ts-desc-json">
        <JsonTree data={props.data} label={t('rich.json.label')} labels={props.labels} />
      </div>
    )
  }

  function RichText(props: { text: string; mode: RichMode }): ReactElement {
    const mdLabels = useMemo<MarkdownChrome>(() => ({
      code: { copyLabel: t('rich.md.copy'), copiedLabel: t('rich.md.copied') },
      footnotes: t('rich.md.footnotes'),
    }), [t])
    const jsonLabels = useMemo<JsonTreeLabels>(() => ({
      copyValue: t('rich.json.copyValue'),
      copyJson: t('rich.json.copyJson'),
      copyPath: t('rich.json.copyPath'),
      copyPrettyJson: t('rich.json.copyPrettyJson'),
      copyCompactJson: t('rich.json.copyCompactJson'),
      copied: t('rich.json.copied'),
      copyFailed: t('rich.json.copyFailed'),
      collapseNode: t('rich.json.collapse'),
      expandNode: t('rich.json.expand'),
      copyButtonTitle: action => t('rich.json.copyOptions', { action }),
    }), [t])
    const json = useMemo(() => (props.mode === 'json' ? jsonOf(props.text) : null), [props.text, props.mode])
    if (props.mode === 'json' && json !== null) {
      return <JsonBody data={json} labels={jsonLabels} />
    }
    if (props.mode !== 'raw') {
      return <div className="lc-ts-desc-md"><Markdown text={props.text} labels={mdLabels} /></div>
    }
    return <RawText text={props.text} />
  }

  function useRichFind(text: string, mode: RichMode): RichFind {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [needle, setNeedle] = useState('')
    const [active, setActive] = useState(0)
    const [count, setCount] = useState(0)
    const [capped, setCapped] = useState(false)
    const bodyRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
      if (!open || query === '') { setNeedle(''); return }
      const id = window.setTimeout(() => { setNeedle(query); setActive(0) }, FIND_DEBOUNCE_MS)
      return () => { window.clearTimeout(id) }
    }, [open, query])

    useEffect(() => {
      if (open) inputRef.current?.focus()
    }, [open])

    useLayoutEffect(() => {
      const root = bodyRef.current
      if (!open || needle === '' || root === null) {
        setCount(0)
        setCapped(false)
        return
      }
      const found = markMatches(root, needle, active)
      setCount(found.count)
      setCapped(found.capped)
      if (active >= found.count) setActive(found.count > 0 ? found.count - 1 : 0)
      return () => { found.restore() }
    }, [open, needle, active, text, mode])

    const step = useCallback((delta: number) => {
      setActive(a => (count > 0 ? (a + delta + count) % count : 0))
    }, [count])
    const onKey = useCallback((ev: ReactKeyboardEvent<HTMLInputElement>) => {
      if (ev.key === 'Enter') { ev.preventDefault(); step(ev.shiftKey ? -1 : 1) }
      else if (isBareEscape(ev) && ev.currentTarget.value === '') { ev.preventDefault(); setOpen(false) }
    }, [step])

    const findLabel = t('rich.find')
    const iconBtn = (label: string, glyph: ReactElement, onClick: () => void, disabled = false) => (
      <button
        type="button"
        className="lc-find-btn"
        title={label}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >{glyph}</button>
    )
    const button = (
      <button
        type="button"
        className={'lc-find-btn' + (open ? ' lc-find-btn-on' : '')}
        title={findLabel}
        aria-label={findLabel}
        onClick={() => { setOpen(o => !o) }}
      ><IconSearch size={13} /></button>
    )
    const bar = !open ? null : (
      <div className="lc-find">
        <ClearableInput
          inputRef={inputRef}
          className="lc-find-input"
          value={query}
          placeholder={t('rich.findPlaceholder')}
          clearLabel={t('field.clear')}
          onChange={setQuery}
          onKeyDown={onKey}
        />
        {needle !== '' ? (
          <span className="lc-find-count">{String(count > 0 ? active + 1 : 0) + '/' + String(count) + (capped ? '+' : '')}</span>
        ) : null}
        {iconBtn(t('rich.findPrev'), <IconChevronUp size={13} />, () => { step(-1) }, count === 0)}
        {iconBtn(t('rich.findNext'), <IconChevronDown size={13} />, () => { step(1) }, count === 0)}
        {iconBtn(t('rich.findClose'), <IconClose size={13} />, () => { setOpen(false) })}
      </div>
    )
    return { button, bar, bodyKey: text, bodyRef }
  }

  return { RichText, RichSwitch, RichCopy, useRichMode, useRichFind }
}
