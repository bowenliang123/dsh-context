// Per-baseline harness client faces (tests/baselines.ts): the in-memory
// service implementations a given dsh generation actually serves, so the
// always-on suite can drive the plugin's client half through each baseline's
// seams. The real-code complement runs in the `compat` vitest project.

import { TestClientCtx } from '../helpers/harness'
import type { ConversationNodeLike, UseChatLike } from '../../../src/client/services'

/** A finalized conversation-node window (the seats' currency). */
export function convNodes(): ConversationNodeLike[] {
  return [
    { kind: 'user', seq: 4, content: [{ type: 'text', text: 'window node hello' }] },
    { kind: 'assistant', seq: 5, messageId: 'm-5', blocks: [{ kind: 'text', text: 'window reply' }] },
  ]
}

/** A `useChat`-shaped hook over a ChatSnapshot (`legacy.nodes`). */
export function chatSeat(nodes: readonly ConversationNodeLike[] | undefined): UseChatLike {
  return selector => selector({ legacy: { nodes } })
}

/** The durable log events the history page builders map (one user message). */
function historyEvents(): unknown[] {
  return [
    {
      type: 'user/message',
      seq: 4,
      time: 1,
      data: { content: [{ type: 'text', text: 'history node hello' }] },
    },
    // The storage packs streaming deltas into chunk rows — unmappable noise here.
    { type: 'text-chunks', seq0: 5, time0: 2, members: [] },
  ]
}

/**
 * Arm a test ctx with the harness service faces the way the generation
 * composes them: the gateway remotes (the traced `remote` facade carrying
 * the session page, plus the direct `remote.session` service whose
 * undeclared reads throw) and the durable-image loader service. Arm the
 * plugin's declared inject (`watchHistoryFaces`) to resolve the page face.
 */
export function baselineCtx(): { ctx: TestClientCtx; calls: { page: unknown[]; image: { sessionId: string; attachment: unknown }[] } } {
  const ctx = new TestClientCtx()
  const calls: { page: unknown[]; image: { sessionId: string; attachment: unknown }[] } = { page: [], image: [] }
  const events = historyEvents()

  // The remote resolves the ClientResult itself; rows are
  // `{type:'event', event}` records.
  const page = (request: unknown): Promise<unknown> => {
    calls.page.push(request)
    return Promise.resolve({ ok: true, value: { records: events.map(event => ({ type: 'event', event })) } })
  }
  ctx.setService('remote', { session: { page } })
  ctx.setService('remote.session', {
    get page() { throw new Error('cannot get property "remote.session" without inject') },
  })

  ctx.setService('uiConversation', {
    imageUrl(sessionId: string, attachment: unknown): Promise<string> {
      calls.image.push({ sessionId, attachment })
      return Promise.resolve('blob:modern-image')
    },
  })
  return { ctx, calls }
}
