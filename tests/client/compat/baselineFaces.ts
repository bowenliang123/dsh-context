// Per-baseline harness client faces (tests/baselines.ts): the in-memory
// service implementations a given dsh generation actually serves, so the
// always-on suite can drive the plugin's client half through each baseline's
// seams. The real-code complement runs via `pnpm run test:compat`.

import type { Baseline } from '../../baselines'
import { TestClientCtx } from '../helpers/harness'
import type { ConversationNodeLike, UseChatLike, UseSessionLike } from '../../../src/client/services'

/** A finalized conversation-node window (the seats' currency, both baselines). */
export function convNodes(): ConversationNodeLike[] {
  return [
    { kind: 'user', seq: 4, content: [{ type: 'text', text: 'window node hello' }] },
    { kind: 'assistant', seq: 5, messageId: 'm-5', blocks: [{ kind: 'text', text: 'window reply' }] },
  ]
}

/** A `useSession`-shaped hook over the given snapshot (the pre-0.1.2 seat). */
export function sessionSeat(nodes: readonly ConversationNodeLike[] | undefined): UseSessionLike {
  return selector => selector({ nodes })
}

/** A `useChat`-shaped hook over a ChatSnapshot (`legacy.nodes`, dsh 0.1.2+). */
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
    // The 0.1.2 storage packs streaming deltas into chunk rows — unmappable noise here.
    { type: 'text-chunks', seq0: 5, time0: 2, members: [] },
  ]
}

/**
 * Arm a test ctx with ONLY the baseline's service faces, the way that
 * generation composes them: the image loader service, the history face, and
 * nothing from the other baseline. The returned props hooks pick the seats.
 */
export function baselineCtx(baseline: Baseline): { ctx: TestClientCtx; calls: { history: unknown[]; page: unknown[]; image: { sessionId: string; attachment: unknown }[] } } {
  const ctx = new TestClientCtx()
  const calls: { history: unknown[]; page: unknown[]; image: { sessionId: string; attachment: unknown }[] } = { history: [], page: [], image: [] }
  const events = historyEvents()

  if (baseline.client.historyFace === 'api.sessions.history') {
    ctx.setService('connection', {
      api: {
        sessions: {
          history(request: unknown): Promise<unknown> {
            calls.history.push(request)
            // The 0.1.1 api client nests the result envelope.
            return Promise.resolve({ result: { ok: true, value: { events } } })
          },
        },
      },
    })
  } else {
    // The 0.1.2 gateway remotes mount as a traced cordis service literally
    // named `remote.session`; the remote resolves the ClientResult itself.
    ctx.setService('remote.session', {
      page(request: unknown): Promise<unknown> {
        calls.page.push(request)
        return Promise.resolve({ ok: true, value: { records: events.map(event => ({ type: 'event', event })) } })
      },
    })
  }

  if (baseline.client.imageFace.service === 'conversation') {
    ctx.setService('conversation', {
      resolveImage(sessionId: string, attachment: unknown): Promise<string> {
        calls.image.push({ sessionId, attachment })
        return Promise.resolve('blob:legacy-image')
      },
    })
  } else {
    ctx.setService('uiConversation', {
      imageUrl(sessionId: string, attachment: unknown): Promise<string> {
        calls.image.push({ sessionId, attachment })
        return Promise.resolve('blob:modern-image')
      },
    })
  }
  return { ctx, calls }
}
