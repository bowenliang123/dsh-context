/** The assistant-message action that opens the Context view at this reply's turn, registered on the harness
 * `conversation.chat.assistant-actions` seat. The matching assistant node's seq is resolved off the `useChat` node seat AT
 * RENDER TIME: that seat is a real React hook, so a click-time read throws the dispatcher guard and the jump would land
 * unpinned. An unresolvable seq still opens the view, just without a pin; a non-string message id renders nothing. */

import { type ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientCtx, ConversationNodeLike, UseChatLike } from '../services'
import { conversationNodesOf } from '../services'
import { activateViewTab, openContextSidebar, requestContextFocus } from '../viewFocus'
import type { ViewKit } from '../viewkit'

export interface ContextJumpProps {
  messageId?: unknown
  sessionId?: unknown
  useChat?: UseChatLike
}

/** Nodes are untrusted input: each element is isolated, so one hostile object that throws on property access is skipped. */
function seqOfMessageId(nodes: readonly ConversationNodeLike[] | undefined, messageId: string): number | null {
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

/** Same 16px outline family as the shipped row icons. */
function JumpIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="fill-none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="2" rx="1" className="fill-current" />
      <rect x="2" y="7" width="8.5" height="2" rx="1" className="fill-current" />
      <rect x="2" y="11" width="5.5" height="2" rx="1" className="fill-current" />
    </svg>
  )
}

export function makeContextJumpButton(ctx: ClientCtx, kit: ViewKit): (props: ContextJumpProps) => ReactElement | null {
  const { t } = kit
  return function ContextJump(props: ContextJumpProps): ReactElement | null {
    // Read first and unconditionally, so the early return below keeps hook order.
    const nodes = conversationNodesOf(props)
    const messageId = props.messageId
    if (typeof messageId !== 'string' || messageId === '') return null
    const seq = seqOfMessageId(nodes, messageId)
    const jump = (): void => {
      const sessionId = props.sessionId
      if (seq !== null && typeof sessionId === 'string' && sessionId !== '') {
        requestContextFocus(sessionId, seq)
      }
      // The sidebar expands over the chat, keeping the clicked reply in view; without that tab the activation stands alone.
      if (!openContextSidebar(ctx)) activateViewTab(t('tab.context'))
    }
    return (
      <Tooltip label={t('jump.title')} side="bottom">
        <button type="button" className="lc-jump hover:bg-(--dsw-alias-interactive-bg-hover) hover:text-(--dsw-alias-label-secondary)" aria-label={t('jump.title')} onClick={jump}>
          <JumpIcon />
        </button>
      </Tooltip>
    )
  }
}
