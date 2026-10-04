/**
 * dsh-context entry configuration — the `config:` block of the `dsh-context`
 * loader row in cordis.yml, plus the per-user display preferences.
 *
 * The schema is schemastery so both consumers it must serve accept it: cordis
 * validates the entry config through the schema's Standard Schema face before
 * `apply` runs (defaults per field, unknown keys merged through), and the
 * harness's Config-form generation (dsh 0.1.7+) derives the Plugins page's
 * live form from this same schema — there the namespace is the entry id
 * (`dsh-context`) and only the `.volatile()` preference fields are served and
 * editable. Bounds edits remount the entry (the folds read them at apply);
 * preference edits commit volatile-only and never remount. On the older lines
 * the preferences are inert here — their surface is the registered settings
 * namespace (settings.ts). The `Config` type describes the RESOLVED shape
 * cordis hands to `apply`; the raw patch values are partial and the schema
 * fills every default.
 */

import z from '@deepseek-ai/schemastery'
import type { DefaultFileSort, DefaultGranularity, DefaultDurationCurve, DefaultPlacement, DefaultTrendMode, DefaultToolSort, InsightsEntry } from '../shared/types'

export interface Config {
  /** Cap on kept per-step request records (the hard step backstop). */
  maxRequestSteps?: number
  /** Newest whole-turn window kept; trimming crosses whole turns, never mid-turn. */
  maxKeptTurns?: number
  maxEvents?: number
  /**
    * Served surface nodes (newest carry the signal; live inject nodes are pinned — they land first and are few). Deliberately generous:
    * auto-compaction keeps healthy surfaces far below it, so the browser effectively lists every live node; the bound is a
    * pathological-session backstop (each push ships the whole value, ~150B/node).
   */
  maxNodes?: number
  /** Removed (shadowed) surface nodes kept for per-step reconstruction. */
  maxArchiveNodes?: number
  /** Fold-derived file-operation records kept (the File Activity card's raw material). */
  maxFileOps?: number
  /** Where the Context view is offered (the conversation tab, the right Sidebar, or both). */
  defaultPlacement?: DefaultPlacement
  /** Timeline default granularity (per step or per turn). */
  defaultGranularity?: DefaultGranularity
  /** Timeline default trend mode (total or delta). */
  defaultTrendMode?: DefaultTrendMode
  /** Tool-definition row default order. */
  defaultToolSort?: DefaultToolSort
  /** File Activity row default order. */
  defaultFileSort?: DefaultFileSort
  /** Whether the Context Insights panel's sidebar entry is offered. */
  insightsEntry?: InsightsEntry
  /** Whether the trend chart mounts with the duration curve overlaid. */
  defaultDurationCurve?: DefaultDurationCurve
}

/** The fold's retention/slice bounds, as the schema resolves them. */
export interface FoldBounds {
  maxRequestSteps: number
  maxKeptTurns: number
  maxEvents: number
  maxNodes: number
  maxArchiveNodes: number
  maxFileOps: number
}

export const DEFAULT_BOUNDS: FoldBounds = {
  maxRequestSteps: 1500,
  maxKeptTurns: 300,
  maxEvents: 400,
  maxNodes: 2000,
  maxArchiveNodes: 400,
  maxFileOps: 400,
}

/**
 * Mark a field live-editable where the harness's schemastery ships the
 * `.volatile()` modifier (the Config-form generation reads the mark to serve
 * the field on the Plugins page); a plain field on the older lines whose
 * schemastery predates the modifier.
 */
export function volatileField<S extends z>(field: S): S {
  const volatile = (field as unknown as { volatile?: () => S }).volatile
  return typeof volatile === 'function' ? volatile.call(field) : field
}

/** One bounded positive-integer count. */
function count(defaultValue: number) {
  return z.number().min(1).step(1).default(defaultValue)
}

/** The cordis `Config` validator and the Config-form generation's served schema. */
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
})

/** Resolve the fold's retention bounds (the schema fills every default). */
export function resolveBounds(config: Config | undefined): FoldBounds {
  // The schema resolves defaults for every omitted field, so the bounds are
  // all present; the volatile preference references are not fold data and
  // stay out of the returned object.
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
