/**
 * dsh-context entry configuration: the `config:` block of the `dsh-context` loader row, plus
 * the per-user display preferences.
 *
 * The schema is schemastery so both consumers accept it: cordis validates the entry config
 * through its Standard Schema face before `apply`, and the harness's Config-form generation
 * derives the Plugins page's live form from the same schema, where the namespace is the entry
 * id and only the `.volatile()` fields are served and editable. Bound edits remount the entry
 * (the folds read them at apply); preference edits commit volatile-only and never remount.
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
}

/** The resolved fold bounds; derived from {@link DEFAULT_BOUNDS} so the two cannot drift. */
export type FoldBounds = typeof DEFAULT_BOUNDS

export type Config = Partial<FoldBounds> & Partial<PluginSettings>

/** Mark a field live-editable where the harness's schemastery ships `.volatile()`; a plain
 * field where the modifier is absent, so one schema serves every harness the gate admits. */
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
  // Loose: a stale persisted value degrades to the default instead of failing the entry.
  defaultPlacement: volatileField(z.union(['all', 'tab', 'sidebar']).default('all').loose()),
  defaultGranularity: volatileField(z.union(['step', 'turn']).default('step').loose()),
  defaultTrendMode: volatileField(z.union(['total', 'delta']).default('total').loose()),
  defaultDeltaBase: volatileField(z.union(['step', 'turn']).default('step').loose()),
  defaultToolSort: volatileField(z.union(['size', 'count', 'name']).default('count').loose()),
  defaultFileSort: volatileField(z.union(['count', 'latest', 'path']).default('count').loose()),
  insightsEntry: volatileField(z.union(['show', 'hide']).default('show').loose()),
  defaultDurationCurve: volatileField(z.union(['show', 'hide']).default('show').loose()),
  fleetTab: volatileField(z.union(['show', 'hide']).default('show').loose()),
})

export function resolveBounds(config: Config | undefined): FoldBounds {
  // The schema fills every default; the volatile preference fields are not fold data.
  const resolved = Config(config ?? {}) as FoldBounds & Record<string, unknown>
  return {
    maxRequestSteps: resolved.maxRequestSteps,
    maxKeptTurns: resolved.maxKeptTurns,
    maxEvents: resolved.maxEvents,
    maxNodes: resolved.maxNodes,
    maxArchiveNodes: resolved.maxArchiveNodes,
    maxFileOps: resolved.maxFileOps,
  }
}
