/**
   * ErrorBoundary — the tab's no-white-screen guarantee: a render error in the subtree degrades to a styled error card instead of
   * propagating
  * into the harness's slot renderer and unmounting the conversation view. Class component: the only React primitive that can catch a
  * subtree's render errors (no hook-based boundary in React 18); Retry resets the boundary and a healthy value resumes.
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
