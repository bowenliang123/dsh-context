/**
 * `/context` — a client-owned slash command that opens the context modal
 * (current composition + recent trend) in the center of the page.
 *
 * Implemented as the plugin's own '/' trigger source instead of a host
 * command: nothing is dispatched to the host, no session log records are
 * written, and nothing becomes model-visible — the invocation never enters
 * the message history. Both paths answer `'handled'` and open the modal,
 * leaving the `/context` token in the composer while it is open; the modal's
 * close path consumes the token then (see modalStore.ts).
 */

import { modalStoreOf, setPendingConsume } from './modalStore'
import type { ClientCtx, InputTriggersFace } from './services'
import type { ViewKit } from './viewkit'

const COMMAND = 'context'
const LINE = '/' + COMMAND

export function registerContextCommand(ctx: ClientCtx, kit: ViewKit): void {
  ctx.effect(() => {
    // Soft dependency (ctx.get, not the inject list): a harness without the
    // input-trigger service keeps the tab working and only the command
    // absent.
    const inputTriggers = ctx.get('inputTriggers') as InputTriggersFace | undefined
    if (inputTriggers === undefined) return () => {}

    return inputTriggers.registerSource({
      trigger: '/',
      name: COMMAND,
      order: 1,
      candidates: (_session, req) => {
        if (req.position !== 'leading') return Promise.resolve([])
        const query = req.query.trim().toLowerCase()
        if (query !== '' && !COMMAND.startsWith(query)) return Promise.resolve([])
        return Promise.resolve([{ name: COMMAND, description: kit.t('cmd.desc') }])
      },
      onPick: (pick) => {
        // Open and remember the token span: the modal's close path consumes
        // it (span CAS — a draft changed meanwhile is left untouched).
        setPendingConsume(pick.session.sessionId, { kind: 'span', span: pick.span })
        modalStoreOf(pick.session.sessionId).set(true)
        return 'handled'
      },
      matchEnter: (session, line) => {
        if (line !== LINE) return Promise.resolve(undefined)
        // Same deferred consume, bare-token guard (the trimmed draft must
        // still equal the command line when the modal closes).
        setPendingConsume(session.sessionId, { kind: 'bare-token', token: LINE })
        modalStoreOf(session.sessionId).set(true)
        return Promise.resolve<'handled'>('handled')
      },
    })
  }, 'dsh-context: /context command')
}
