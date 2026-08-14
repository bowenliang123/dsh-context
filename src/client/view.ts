/**
 * Composition root of the client half: builds the ViewKit once and wires
 * every component factory into the ContextView the slot registers. Called
 * once per plugin apply (from index.ts), exactly like the pre-refactor
 * single-file makeView.
 */

import type * as ReactNS from 'react'
import { makeContextView } from './components/contextView'
import type { ContextViewProps } from './components/contextView'
import type { Translate } from './i18n'
import type { ClientCtx } from './services'
import { makeViewKit } from './viewkit'

export function makeView(ctx: ClientCtx, t: Translate): (props: ContextViewProps) => ReactNS.ReactElement {
  return makeContextView(ctx, makeViewKit(t))
}
