/**
  * RichText — the raw/markdown body for the Context browser's detail sections. Markdown renders via the harness's shared MarkdownText (GFM,
  * sanitized, resolved from the platform module table — zero plugin-side markdown dependency); raw is a plain `<pre>`. The Raw/MD switch
  * sits at a section head's right edge (RichSwitch; per-card mode via useRichMode).
 */

import type * as ReactNS from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { React } from '../react'
import type { ViewKit } from '../viewkit'

export type RichMode = 'raw' | 'md'

export interface RichKit {
  RichText: (props: { text: string; mode: RichMode }) => ReactNS.ReactElement
  RichSwitch: (props: { mode: RichMode; onPick: (mode: RichMode) => void }) => ReactNS.ReactElement
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
