/**
 * RichText — the raw/markdown view shared by the Context browser's detail
 * section cards (system prompt, tool description, message and injection
 * bodies).
 *
 * Every detail section wears the same card chrome (`lc-ts-card` + head —
 * see browser.tsx's Section); the Raw/MD segmented switch always sits at
 * the head's right edge (`RichSwitch`, per-card state via `useRichMode`),
 * and `RichText` renders one text block in the handed-down mode — rendered
 * markdown via the harness's shared MarkdownText renderer (the default;
 * GFM, sanitized, resolved from the platform module table — zero
 * plugin-side markdown dependency) or the raw <pre>. Both bodies share the
 * section text chrome (`lc-ts-desc-body` / `lc-ts-desc-md`).
 */

import type * as ReactNS from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { React } from '../react'
import type { ViewKit } from '../viewkit'

/** Detail-body view mode: raw source text or rendered markdown. */
export type RichMode = 'raw' | 'md'

export interface RichKit {
  /** One text block in the given mode: raw <pre> or rendered markdown. */
  RichText: (props: { text: string; mode: RichMode }) => ReactNS.ReactElement
  /** The segmented switch, placed at a section head's right edge. */
  RichSwitch: (props: { mode: RichMode; onPick: (mode: RichMode) => void }) => ReactNS.ReactElement
  /** Per-card mode state for the section that places the switch. */
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
  function RichSwitch(props: { mode: RichMode; onPick: (mode: RichMode) => void }): ReactNS.ReactElement {
    const seg = (m: RichMode, label: string, tip: string) => (
      <button
        type="button"
        className={'lc-rich-seg-btn' + (props.mode === m ? ' lc-rich-seg-on' : '')}
        title={tip}
        onClick={() => { props.onPick(m) }}
      >{label}</button>
    )
    return (
      <span className="lc-rich-seg">
        {seg('raw', t('rich.raw'), t('rich.toRaw'))}
        {seg('md', t('rich.md'), t('rich.toMd'))}
      </span>
    )
  }

  function RichText(props: { text: string; mode: RichMode }): ReactNS.ReactElement {
    if (props.mode === 'md') {
      return <div className="lc-ts-desc-md"><MarkdownText text={props.text} /></div>
    }
    return <pre className="lc-ts-desc-body">{props.text}</pre>
  }

  return { RichText, RichSwitch, useRichMode }
}
