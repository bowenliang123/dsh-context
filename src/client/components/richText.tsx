/**
  * RichText — the raw/markdown body for the Context browser's detail sections. Markdown renders via the harness's shared MarkdownText (GFM,
  * sanitized, resolved from the platform module table — zero plugin-side markdown dependency); raw is a line-numbered `<pre>`. The Raw/MD
  * switch sits at a section head's right edge (RichSwitch; per-card mode via useRichMode).
 */

import type * as ReactNS from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { React } from '../react'
import type { ViewKit } from '../viewkit'

export type RichMode = 'raw' | 'md'

/**
 * The Markdown chrome the harness primitives serve as a required `labels`
 * prop. Typed locally so the plugin typechecks without a primitives
 * dependency.
 */
interface MarkdownChrome {
  code: { copyLabel: string; copiedLabel: string }
  footnotes: string
}

const Markdown = MarkdownText as (props: { text: string; labels?: MarkdownChrome }) => ReactNS.ReactElement

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

  // One block per source line: the number is a counter-fed ::before glued to
  // its own line across soft wraps, and pseudo content never reaches the
  // clipboard, so selecting the body still copies the exact source text.
  function RawText(props: { text: string }): ReactNS.ReactElement {
    const lines = React.useMemo(() => {
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

  function RichText(props: { text: string; mode: RichMode }): ReactNS.ReactElement {
    // Reference-stable per locale: a fresh object identity would discard the
    // renderer's cached elements on every render (0.1.2+ faces).
    const mdLabels = React.useMemo<MarkdownChrome>(() => ({
      code: { copyLabel: t('rich.md.copy'), copiedLabel: t('rich.md.copied') },
      footnotes: t('rich.md.footnotes'),
    }), [t])
    if (props.mode === 'md') {
      return <div className="lc-ts-desc-md"><Markdown text={props.text} labels={mdLabels} /></div>
    }
    return <RawText text={props.text} />
  }

  return { RichText, RichSwitch, useRichMode }
}
