/** The terminal half loads only where a dsh-TUI session-data service exists, so a web deployment never executes it. */

import type { Context } from '@deepseek-ai/cordis'
import { liveRead, resolveBounds, type Config } from './config'

type TerminalModule = typeof import('../tui/index')

export function watchTerminal(ctx: Context, config: Config, load: () => Promise<TerminalModule> = () => import('../tui/index')): void {
  const granularity = liveRead(config.defaultGranularity)
  const fileSort = liveRead(config.defaultFileSort)
  ctx.inject(['tuiSessionData'], async (c) => {
    const tui = await load()
    tui.mountTerminal(ctx, c, {
      bounds: resolveBounds(config),
      preferences: () => ({ granularity: granularity(), fileSort: fileSort() }),
    })
  })
}
