/**
 * Step-boundary message identity guard (issue #51 compatibility).
 *
 * The harness refuses to LOAD any session whose durable log carries a
 * `user/message` event whose message lacks a non-empty string `id`
 * (`assertMessageEventShape`) — while the runtime append path runs no such
 * check. One unidentified message therefore persists silently and permanently
 * bricks the session at its next load (`... failed validation: session event
 * at seq N lacks an identified message`). The observed archive held a wrap-up
 * notice whose `id` (and `summary`) had been stripped upstream of the append —
 * a shape no shipped harness producer emits, i.e. a delivery-boundary rebuild
 * outside the audited paths of both this plugin and the harness.
 *
 * This guard hardens the durability boundary from the plugin side. The agent
 * loop appends every step-boundary `user/message` from the `agent/pre-step`
 * decision's `messages` — the one seam all claimed inbox input (prompts,
 * steering, tool-deferred context) flows through before it persists. A
 * prepended listener sits OUTERMOST in that waterfall, so after `next()`
 * resolves it sees the final message list: any message that would persist
 * unidentified gets a fresh id; everything else passes by reference, and the
 * decision object is copied only when a mint happened.
 *
 * Fail-open by contract: a hostile entry (one that throws on property access),
 * a missing list, or any unexpected shape leaves the decision verbatim — a
 * guard must never break the turn it protects. Minted ids carry the `dshctx-`
 * prefix so a backfilled message stays identifiable in the wild.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

/** Prefix marking an id this guard minted (forensically distinguishable). */
const MINTED_ID_PREFIX = 'dshctx-'

/** The loop's step decision, narrowed to the fields the guard may touch. */
export interface PreStepDecision {
  kind?: unknown
  messages?: unknown[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/pre-step'(
      this: Context,
      input: { agent: unknown; messages: unknown[]; signal: AbortSignal; step: number; turn: number },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision>
  }
}

/**
 * Whether the message fails the harness's restore-time identity check (a
 * non-empty string id). Non-object entries are unfixable (an id needs a
 * container) and stay verbatim.
 */
function lacksId(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  const id = (message as { id?: unknown }).id
  return typeof id !== 'string' || id === ''
}

/**
 * Mint ids for the messages that would persist unidentified.
 * @param messages - the decision's message list, in append order.
 * @returns the rewritten list (untouched entries by reference), or undefined
 *   when every entry already carries an identity.
 */
export function identifiedMessages(messages: readonly unknown[]): unknown[] | undefined {
  let copy: unknown[] | undefined
  for (const [index, message] of messages.entries()) {
    if (!lacksId(message)) {
      copy?.push(message)
      continue
    }
    copy ??= messages.slice(0, index)
    copy.push({ ...(message as object), id: MINTED_ID_PREFIX + randomUUID() })
  }
  return copy
}

/** Arm the prepended `agent/pre-step` guard on the plugin's context. */
export function watchStepIdentity(ctx: Context): void {
  ctx.on('agent/pre-step', async (_input, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      const identified = identifiedMessages(decision.messages)
      return identified === undefined
        ? decision
        : { ...decision, messages: identified }
    } catch {
      return decision
    }
  }, { prepend: true })
}
