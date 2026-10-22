/** System-prompt injection: two globally registered prompt sections join the configured prefix/suffix around the harness's assembled
 * prompt. Their text providers read the volatile config refs the loader updates in place, so an edit applies from the next model step
 * without remounting the entry. */

import type { Context } from '@deepseek-ai/cordis'
import { liveRead, type Config } from './config'

/** The `ctx.systemPrompt` face consumed here; feature-detected so a composition without it degrades to a no-op. */
export interface SystemPromptFace {
  section(section: {
    name: string
    order: number
    text: string | ((context: unknown) => string)
    interpolate?: boolean
  }): () => void
  getSectionOrder(name: string): number
}

function liveText(value: unknown): () => string {
  const read = liveRead(value)
  return () => {
    const text = read()
    return typeof text === 'string' ? text : ''
  }
}

/** The section text provider: whitespace-only text is disabled (the harness's `renderPrompt` drops empty sections), any other text stays
 * byte-exact. */
function sectionText(read: () => string): (context: unknown) => string {
  return () => {
    const text = read()
    return text.trim().length === 0 ? '' : text
  }
}

/** Fixed clearance from the nearest harness-owned order anchor, outside every allocated slot. */
const ORDER_CLEARANCE = 1000

export function watchPromptInjection(ctx: Context, config: Config): void {
  // Fires wherever the prompt registry exists, before or after this entry mounts; without it the entry is a no-op.
  ctx.inject(['systemPrompt'] as never, (inner: Context) => {
    const systemPrompt = (inner as { systemPrompt?: SystemPromptFace | null }).systemPrompt
    if (systemPrompt === null || systemPrompt === undefined
      || typeof systemPrompt.section !== 'function'
      || typeof systemPrompt.getSectionOrder !== 'function') return
    systemPrompt.section({
      name: 'dsh-context:prompt-prefix',
      // Ahead of every allocated slot, anchored through the harness's own order registry so a central renumbering keeps the prefix first.
      order: systemPrompt.getSectionOrder('HARNESS_IDENTITY') - ORDER_CLEARANCE,
      text: sectionText(liveText(config.promptPrefix)),
      // Literal text: a user's `{{...}}` must never reach the strict variable interpolation.
      interpolate: false,
    })
    systemPrompt.section({
      name: 'dsh-context:prompt-suffix',
      order: systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + ORDER_CLEARANCE,
      text: sectionText(liveText(config.promptSuffix)),
      interpolate: false,
    })
  })
}
