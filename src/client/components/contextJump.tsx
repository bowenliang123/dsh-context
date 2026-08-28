/**
 * The assistant-message action that jumps to the Context tab at this reply's
 * turn. Registered on the harness `conversation.chat.assistant-actions` seat
 * (the icon row beside copy/branch), it receives the finalized reply's durable
 * message id, resolves the matching assistant node's seq off whichever node
 * seat the running harness serves (`useChat` on 0.1.2+, the session snapshot
 * before it), records it in the viewFocus relay, and activates the Context
 * tab — where the jump pins the reply's TURN (see contextView's leg 2). An
 * unresolvable seq still switches tabs, just without a pin; a message id that
 * is not a plain string renders nothing at all.
 */

import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type * as ReactNS from 'react'
import type { ConversationNodeLike, UseChatLike, UseSessionLike } from '../services'
import { conversationNodesOf } from '../services'
import { React } from '../react'
import { activateContextTab, requestContextFocus } from '../viewFocus'
import type { ViewKit } from '../viewkit'

/** The assistant-action seat's currency, as far as this button consumes it. */
export interface ContextJumpProps {
  messageId?: unknown
  sessionId?: unknown
  useChat?: UseChatLike
  useSession?: UseSessionLike
}

/**
 * The reply's request seq by its durable message id, or null when no served node proves the pair. Join/log nodes are untrusted input: each
 * element is isolated, so one hostile object that throws on property access is skipped — the jump keeps its pin, never its click.
 */
export function seqOfMessageId(nodes: readonly ConversationNodeLike[] | undefined, messageId: string): number | null {
  for (const node of nodes ?? []) {
    try {
      if (node.kind !== 'assistant' || node.messageId !== messageId) continue
      return typeof node.seq === 'number' && Number.isFinite(node.seq) ? node.seq : null
    } catch {
      continue
    }
  }
  return null
}

/** The jump glyph: the plugin's mini stacked composition bars, same 16px outline family as the shipped row icons. */
function JumpIcon(): ReactNS.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="2" rx="1" fill="currentColor" />
      <rect x="2" y="7" width="8.5" height="2" rx="1" fill="currentColor" />
      <rect x="2" y="11" width="5.5" height="2" rx="1" fill="currentColor" />
    </svg>
  )
}

export function makeContextJumpButton(kit: ViewKit): (props: ContextJumpProps) => ReactNS.ReactElement | null {
  const { t } = kit
  return function ContextJump(props: ContextJumpProps): ReactNS.ReactElement | null {
    const messageId = props.messageId
    // Interruption-frozen partials address no durable message — the owner
    // already withholds them, and anything else non-string is ignored.
    if (typeof messageId !== 'string' || messageId === '') return null
    const jump = (): void => {
      const seq = seqOfMessageId(conversationNodesOf(props), messageId)
      const sessionId = props.sessionId
      if (seq !== null && typeof sessionId === 'string' && sessionId !== '') {
        requestContextFocus(sessionId, seq)
      }
      activateContextTab(t('tab'))
    }
    return (
      <Tooltip label={t('jump.title')} side="bottom">
        <button type="button" className="lc-jump" aria-label={t('jump.title')} onClick={jump}>
          <JumpIcon />
        </button>
      </Tooltip>
    )
  }
}
