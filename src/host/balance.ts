/**
 * The account-balance route of the Context card: one same-origin read of the
 * configured provider account's wallet, served beside the session's cost
 * estimates so the card can show what is LEFT next to what the session has
 * spent.
 *
 * The transport is Connection's exact Fetch-route registry
 * (`ctx.connection.fetch.register`) — the same seam the harness's own file
 * upload and media-reference routes mount through, riding the authenticated
 * `/api` fence (detail.ts serves the on-demand detail read the same way). The
 * provider key never reaches the browser: the route resolves the credentials
 * seam's `DEEPSEEK_API_KEY` (the ref the `deepseek-official` provider stores
 * its key under) and reads the balance endpoint host-side.
 *
 * Load order is never assumed: `watchBalanceChannel` nests a `ctx.inject` on
 * the faces it reads (connection, credentials), so a service that activates
 * AFTER this plugin still arms the route, and either service unloading
 * withdraws it and closes the gate. A deployment whose connection carries no
 * fetch registry, or that has no credentials seam, stays inert — the client
 * then renders no balance cell at all (see client/balance.ts).
 *
 * Everything the upstream answers is untrusted wire input, so `balanceOf`
 * re-proves it at the boundary: only a finite non-negative amount and a known
 * currency survive; anything else becomes the typed failure envelope. The
 * handler never throws into the transport.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WalletBalance } from '../shared/types'
/** The plugin's balance route, under the authenticated `/api` fence. */
export const BALANCE_ROUTE = '/api/dsh-context/balance'

/** The credential ref the `deepseek-official` provider stores its key under. */
export const BALANCE_CREDENTIAL_REF = 'DEEPSEEK_API_KEY'

/** The upstream wallet endpoint, read host-side with that key. */
const BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** The route's liveness; the client store reads it before polling. */
export interface BalanceChannelGate {
  readonly live: boolean
}

/** The host `connection` service, as far as the route consumes it. */
interface ConnectionHostFace {
  fetch?: {
    register?(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered'
      fetch: (request: Request) => Promise<Response>
    }): () => void
  }
}

/** The host `credentials` service, as far as the route consumes it. */
interface CredentialsHostFace {
  resolve?(ref: string): Promise<{ value: string } | undefined>
}

/** One JSON reply; the wallet is live data, never cached. */
function reply(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

/** The typed failure envelope the client turns into "no balance to show". */
function failure(code: string, message: string): Response {
  return reply({ ok: false, error: { code, message } })
}

/**
 * The boundary sanitizer over one upstream payload: the first balance entry's
 * `total_balance` and `currency`, or undefined when nothing trustworthy is in
 * it (a non-record, a missing/NaN/negative amount). An unknown currency reads
 * as CNY — the endpoint's own default — rather than dropping an otherwise
 * usable amount.
 */
export function balanceOf(value: unknown): WalletBalance | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const infos = (value as { balance_infos?: unknown }).balance_infos
  const first: unknown = Array.isArray(infos) ? (infos as unknown[])[0] : undefined
  if (first === null || typeof first !== 'object') return undefined
  const amount = Number((first as { total_balance?: unknown }).total_balance)
  if (!Number.isFinite(amount) || amount < 0) return undefined
  const raw = (first as { currency?: unknown }).currency
  const currency = typeof raw === 'string' && raw.toLowerCase() === 'usd' ? 'usd' : 'cny'
  return { currency, amount }
}
/**
 * Serve the balance route whenever the connection and credentials services are
 * both composed (see the module header for the load-order contract). The
 * registration rides the injected fiber: either service unloading withdraws
 * the route and closes the gate.
 */
export function watchBalanceChannel(ctx: Context): BalanceChannelGate {
  const gate = { live: false }
  ctx.inject(['connection', 'credentials'], (c) => {
    const connection = c.get('connection') as ConnectionHostFace | undefined
    const credentials = c.get('credentials') as CredentialsHostFace | undefined
    // Bind at extraction (an unbound hand-off loses `this` on the real faces).
    const register = typeof connection?.fetch?.register === 'function'
      ? connection.fetch.register.bind(connection.fetch)
      : undefined
    const resolve = typeof credentials?.resolve === 'function'
      ? credentials.resolve.bind(credentials)
      : undefined
    if (register === undefined || resolve === undefined) return

    const handler = async (request: Request): Promise<Response> => {
      try {
        const resolved = await resolve(BALANCE_CREDENTIAL_REF)
        if (resolved === undefined) {
          return failure('dsh-context/no-credential', `no ${BALANCE_CREDENTIAL_REF} credential`)
        }
        const response = await fetch(BALANCE_URL, {
          method: 'GET',
          headers: { authorization: `Bearer ${resolved.value}`, accept: 'application/json' },
          signal: request.signal,
        })
        if (!response.ok) return failure('dsh-context/upstream', `balance endpoint HTTP ${response.status}`)
        const balance = balanceOf(await response.json())
        if (balance === undefined) return failure('dsh-context/malformed', 'balance payload is malformed')
        return reply({ ok: true, value: balance })
      } catch (error) {
        return failure('dsh-context/read-failed', error instanceof Error ? error.message : String(error))
      }
    }

    const dispose = register({
      path: BALANCE_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: handler,
    })
    gate.live = true
    c.effect(() => () => {
      gate.live = false
      dispose()
    }, 'dsh-context: balance route')
  })
  return gate
}
