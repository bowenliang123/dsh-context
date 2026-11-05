import { useSyncExternalStore, type ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientCtx, ConversationNodeLike, UseChatLike } from '../services'
import { conversationNodesOf, seatKeyOf } from '../services'
import { activateViewTab, openContextSidebar, requestContextFocus } from '../viewFocus'
import { placementSurfaces } from '../placement'
import type { ContextSettings } from '../settings'
import type { ViewKit } from '../viewkit'

export interface ContextJumpProps {
  messageId?: unknown
  sessionId?: unknown
  useChat?: UseChatLike
}

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

function JumpIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="fill-none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="2" rx="1" className="fill-current" />
      <rect x="2" y="7" width="8.5" height="2" rx="1" className="fill-current" />
      <rect x="2" y="11" width="5.5" height="2" rx="1" className="fill-current" />
    </svg>
  )
}

export function makeContextJumpButton(
  ctx: ClientCtx,
  kit: ViewKit,
  settings: ContextSettings,
): (props: ContextJumpProps) => ReactElement | null {
  const { t } = kit
  const subscribeSettings = settings.store.subscribe.bind(settings.store)
  return function ContextJump(props: ContextJumpProps): ReactElement | null {
    return <ContextJumpBody key={seatKeyOf(props)} {...props} />
  }
  function ContextJumpBody(props: ContextJumpProps): ReactElement | null {
    const nodes = conversationNodesOf(props)
    const placement = useSyncExternalStore(subscribeSettings, () => settings.defaultPlacement())
    const messageId = props.messageId
    if (typeof messageId !== 'string' || messageId === '') return null
    const surfaces = placementSurfaces(placement)
    if (!surfaces.tab && !surfaces.sidebar) return null
    const seq = seqOfMessageId(nodes, messageId)
    const jump = (): void => {
      const sessionId = props.sessionId
      if (seq !== null && typeof sessionId === 'string' && sessionId !== '') {
        requestContextFocus(sessionId, seq)
      }
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
