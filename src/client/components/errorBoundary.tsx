/**
 * ErrorBoundary — the tab's no-white-screen guarantee.
 *
 * A render error anywhere in the subtree (a foreign or corrupt projection
 * value that slips past the shape guards in services.ts, a framework
 * surprise, a future bug) would otherwise propagate into the harness's slot
 * renderer and unmount the whole conversation view. This boundary catches
 * render errors of its subtree and degrades to a styled error card with the
 * offending message — the surrounding harness UI (chat, tabs, composer)
 * keeps working as if nothing happened.
 *
 * A class component: the only React primitive that can catch render errors
 * of a subtree (there is no hook-based boundary in React 18). The Retry
 * button resets the boundary; if the underlying condition persists the
 * boundary catches again, once a healthy value arrives the tab resumes.
 */

import type * as ReactNS from 'react'
import type { Translate } from '../i18n'

import { React } from '../react'

export function makeErrorBoundary(t: Translate): ReactNS.ComponentType<{ children?: ReactNS.ReactNode }> {
  return class ErrorBoundary extends React.Component<{ children?: ReactNS.ReactNode }, { error: Error | null }> {
    constructor(props: { children?: ReactNS.ReactNode }) {
      super(props)
      this.state = { error: null }
    }

    static getDerivedStateFromError(error: unknown): { error: Error | null } {
      return { error: error instanceof Error ? error : new Error(String(error)) }
    }

    render(): ReactNS.ReactNode {
      const error = this.state.error
      if (error === null) return this.props.children
      return (
        <div className="lc-root">
          <div className="lc-empty lc-error">
            <span>{t('error')}</span>
            <code className="lc-error-msg">{error.message}</code>
            <button
              type="button"
              className="lc-error-retry"
              onClick={() => { this.setState({ error: null }) }}
            >{t('error.retry')}</button>
          </div>
        </div>
      )
    }
  }
}
