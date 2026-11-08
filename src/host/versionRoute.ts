import type { Context } from '@deepseek-ai/cordis'
import type { CatalogService } from './catalog'
import { failure, mountPostRoute, reply } from './postRoute'

export const VERSION_ROUTE = '/api/dsh-context/version'

export function watchVersionChannel(ctx: Context, catalog: CatalogService): void {
  mountPostRoute({
    ctx,
    deps: ['connection'],
    path: VERSION_ROUTE,
    label: 'dsh-context: version route',
    handler: () => async (): Promise<Response> => {
      try {
        const entry = await catalog.version()
        return reply({
          ok: true,
          value: {
            ready: entry.ready,
            failed: entry.failed,
            checkedAt: entry.checkedAt,
            current: catalog.currentVersion() ?? null,
            ...(entry.value === null ? {} : { latest: entry.value }),
          },
        })
      } catch (err) {
        return failure('gateway/internal', err instanceof Error ? err.message : String(err))
      }
    },
  })
}
