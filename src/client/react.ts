/**
 * The browser module table supplies React through the injected `require` —
 * every component imports it from here instead of repeating the require.
 */

import type * as ReactNS from 'react'

export const React: typeof ReactNS = require('react')
export const h = React.createElement
