/**
 * Entry configuration: the `config:` block of the `dsh-context` loader row plus the per-user display preferences. The
 * schemastery schema serves both cordis validation and the harness's Config-form generation; bound edits remount the
 * entry (the folds read them at apply), while preference edits commit volatile-only.
 */

import z from '@deepseek-ai/schemastery'
import type { PluginSettings } from '../shared/types'

export const DEFAULT_BOUNDS = {
  maxRequestSteps: 1500,
  /** Newest whole-turn window kept; trimming crosses whole turns, never mid-turn. */
  maxKeptTurns: 300,
  maxEvents: 400,
  /** Pathological-session backstop only: each push ships the whole value (~150B/node). */
  maxNodes: 2000,
  maxArchiveNodes: 400,
  maxFileOps: 400,
  maxCommands: 400,
  /** The command text caps per record; the card offers the full text through the browser's message body. */
  maxCommandChars: 4096,
}

/** The resolved fold bounds; derived from {@link DEFAULT_BOUNDS} so the two cannot drift. */
export type FoldBounds = typeof DEFAULT_BOUNDS

export type Config = Partial<FoldBounds> & Partial<PluginSettings>

/** Mark a field live-editable where the harness's schemastery ships `.volatile()`; a plain field where the modifier is absent, so one
 * schema serves every harness the gate admits. */
export function volatileField<S extends z>(field: S): S {
  const volatile = (field as unknown as { volatile?: () => S }).volatile
  return typeof volatile === 'function' ? volatile.call(field) : field
}

function count(defaultValue: number) {
  return z.number().min(1).step(1).default(defaultValue)
}

export const Config = z.object({
  maxRequestSteps: count(DEFAULT_BOUNDS.maxRequestSteps),
  maxKeptTurns: count(DEFAULT_BOUNDS.maxKeptTurns),
  maxEvents: count(DEFAULT_BOUNDS.maxEvents),
  maxNodes: count(DEFAULT_BOUNDS.maxNodes),
  maxArchiveNodes: count(DEFAULT_BOUNDS.maxArchiveNodes),
  maxFileOps: count(DEFAULT_BOUNDS.maxFileOps),
  maxCommands: count(DEFAULT_BOUNDS.maxCommands),
  maxCommandChars: count(DEFAULT_BOUNDS.maxCommandChars),
  // Loose: a stale persisted value degrades to the default instead of failing the entry.
  defaultPlacement: volatileField(z.union(['all', 'tab', 'sidebar', 'hide']).default('all').loose()),
  defaultGranularity: volatileField(z.union(['step', 'turn']).default('step').loose()),
  defaultTrendMode: volatileField(z.union(['total', 'delta']).default('total').loose()),
  defaultDeltaBase: volatileField(z.union(['step', 'turn']).default('step').loose()),
  defaultToolSort: volatileField(z.union(['size', 'count', 'name']).default('count').loose()),
  defaultFileSort: volatileField(z.union(['count', 'lines', 'latest', 'path', 'name']).default('lines').loose()),
  insightsEntry: volatileField(z.union(['show', 'hide']).default('show').loose()),
  defaultDurationCurve: volatileField(z.union(['show', 'hide']).default('show').loose()),
  overviewAutoSteps: volatileField(z.union(['100', '200', '300', 'off']).default('200').loose()),
  defaultOverviewRange: volatileField(z.union(['today', '7d', '30d', 'all']).default('30d').loose()),
  fleetTab: volatileField(z.union(['show', 'hide']).default('show').loose()),
  displayCurrency: volatileField(z.union(['auto', 'cny', 'usd']).default('auto').loose()),
  // Loose: a stale persisted value (or a non-string) degrades to the empty default instead of failing the entry.
  promptPrefix: volatileField(z.string().default('').loose()),
  promptSuffix: volatileField(z.string().default('').loose()),
})

export function resolveBounds(config: Config | undefined): FoldBounds {
  const resolved = Config(config ?? {}) as FoldBounds & Record<string, unknown>
  return {
    maxRequestSteps: resolved.maxRequestSteps,
    maxKeptTurns: resolved.maxKeptTurns,
    maxEvents: resolved.maxEvents,
    maxNodes: resolved.maxNodes,
    maxArchiveNodes: resolved.maxArchiveNodes,
    maxFileOps: resolved.maxFileOps,
    maxCommands: resolved.maxCommands,
    maxCommandChars: resolved.maxCommandChars,
  }
}
