/**
 * Runtime globals of the browser bundle. The client half ships as a CJS
 * closure inside the web boot handoff: React and other platform modules
 * arrive through the injected `require`, and the handoff's `module.exports`
 * is what the loader reads. Declared here so the strict typecheck sees them.
 */

declare function require(id: string): any
declare var module: { exports: Record<string, unknown> }
declare var exports: Record<string, unknown>
