/**
 * Runtime globals of the browser bundle. The client half ships as a CJS
 * closure inside the web boot handoff: React and other platform modules
 * arrive through the injected `require`, and the handoff's `module.exports`
 * is what the loader reads. Declared here so the strict typecheck sees them.
 */

declare function require(id: string): unknown
declare let module: { exports: Record<string, unknown> }
declare let exports: Record<string, unknown>

// Stylesheet imports resolve through the bundle's CSS channels (see
// tsdown.config.ts): side-effect global sheets, ?inline text, and
// CSS Modules class maps.
declare module '*.css'
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
