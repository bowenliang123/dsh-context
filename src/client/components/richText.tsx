/**
 * RichText — the raw/markdown view switch shared by the Context browser's
 * detail cards (system prompt, tool description, user/assistant message and
 * injection bodies).
 *
 * `RichCard` owns the per-card mode state and places a small segmented
 * switch (the same pill chrome as the trend chart's 步骤/轮次 control) at
 * the card's top-right corner; `RichText` renders one text block in the
 * handed-down mode — rendered markdown via the harness's shared
 * MarkdownText renderer (the default; GFM, sanitized, resolved from the
 * platform module table — zero plugin-side markdown dependency) or the raw
 * <pre>. The mode crosses component boundaries explicitly through render
 * props/props (no React context), and each card keeps its own state so two
 * open details switch independently.
 */

import type * as ReactNS from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { React } from '../react'
import type { ViewKit } from '../viewkit'

/** Detail-body view mode: raw source text or rendered markdown. */
export type RichMode = 'raw' | 'md'

export interface RichKit {
  /** One text block in the given mode: raw <pre> or rendered markdown. */
  RichText: (props: {
    text: string
    mode: RichMode
    /** Chrome of the raw block (defaults to the browser's `lc-br-pre`). */
    rawClass?: string
    /** Chrome of the markdown box (defaults to `lc-br-md`). */
    mdClass?: string
  }) => ReactNS.ReactElement
  /**
   * Detail card wrapper: renders the mode switch as a small segmented pill
   * on the card's top-right edge and hands the current mode to its `render`
   * prop (an explicit prop, not function-children, so the mode hand-off is
   * visible in the props object).
   */
  RichCard: (props: {
    className?: string
    render: (mode: RichMode) => ReactNS.ReactNode
  }) => ReactNS.ReactElement
  /** The segmented switch alone, for cards that place it in their own head row. */
  RichSwitch: (props: { mode: RichMode; onPick: (mode: RichMode) => void; inHead?: boolean }) => ReactNS.ReactElement
  /** Per-card mode state for bodies that place the switch themselves. */
  useRichMode: () => [RichMode, (mode: RichMode) => void]
}

export function makeRichText(kit: ViewKit): RichKit {
  const { t } = kit

  function useRichMode(): [RichMode, (mode: RichMode) => void] {
    // Markdown is the default view: the detail cards hold prose (prompts,
    // descriptions, messages), which reads better rendered; raw stays one
    // click away for exact source inspection.
    const [mode, setMode] = React.useState<RichMode>('md')
    return [mode, setMode]
  }

  // Two-option pill mirroring the trend chart's 步骤/轮次 control: one
  // segment per view, the active segment highlighted; each segment's
  // tooltip spells its view out (localized).
  function RichSwitch(props: { mode: RichMode; onPick: (mode: RichMode) => void; inHead?: boolean }): ReactNS.ReactElement {
    const seg = (m: RichMode, label: string, tip: string) => (
      <button
        type="button"
        className={'lc-rich-seg-btn' + (props.mode === m ? ' lc-rich-seg-on' : '')}
        title={tip}
        onClick={() => { props.onPick(m) }}
      >{label}</button>
    )
    return (
      <span className={'lc-rich-seg' + (props.inHead === true ? ' lc-rich-seg-head' : '')}>
        {seg('raw', t('rich.raw'), t('rich.toRaw'))}
        {seg('md', t('rich.md'), t('rich.toMd'))}
      </span>
    )
  }

  function RichText(props: {
    text: string
    mode: RichMode
    rawClass?: string
    mdClass?: string
  }): ReactNS.ReactElement {
    if (props.mode === 'md') {
      return <div className={props.mdClass ?? 'lc-br-md'}><MarkdownText text={props.text} /></div>
    }
    return <pre className={props.rawClass ?? 'lc-br-pre'}>{props.text}</pre>
  }

  function RichCard(props: {
    className?: string
    render: (mode: RichMode) => ReactNS.ReactNode
  }): ReactNS.ReactElement {
    const [mode, setMode] = useRichMode()
    return (
      <div className={props.className ?? 'lc-br-content'}>
        <RichSwitch mode={mode} onPick={setMode} />
        {props.render(mode)}
      </div>
    )
  }

  return { RichText, RichCard, RichSwitch, useRichMode }
}
