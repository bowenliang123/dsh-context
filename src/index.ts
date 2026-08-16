/**
 * dsh-context — canonical package entry (host half).
 *
 * The npm-package main entry (`lib/index.js`) is bundled from this file by
 * `scripts/build.mjs`; the harness loads it as the `dsh-context` loader row.
 * All value/type exports live in the host module — this file only re-exports
 * them so the source tree keeps the conventional `src/index.ts` entry shape.
 */

export * from './host/index'
