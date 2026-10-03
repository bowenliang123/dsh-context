import { z } from 'zod'
import type { BilledUsage } from './fold'

/** The last provider sample; a retry boundary closes its replacement slot. */
export interface BilledSample {
  turn: number
  step: number
  time: number
  provider: string
  model?: string
  day?: string
  buckets: BilledUsage
}

export const billedSampleSchema = z.object({
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  time: z.number(),
  provider: z.string(),
  model: z.string().optional(),
  day: z.string().optional(),
  buckets: z.object({
    input: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }).strict(),
}).strict() as unknown as z.ZodType<BilledSample>

export function sameAttempt(sample: BilledSample | undefined, data: Record<string, unknown> | undefined): boolean {
  return sample !== undefined && sample.turn === data?.turn && sample.step === data.step
}

export function billingSample(
  data: Record<string, unknown> | undefined,
  time: number,
  buckets: BilledUsage,
  provider: string,
  model?: string,
  day?: string,
): BilledSample | undefined {
  const turn = data?.turn
  const step = data?.step
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0
    || typeof step !== 'number' || !Number.isInteger(step) || step < 0
    || !Number.isFinite(time)) return undefined
  return { turn, step, time, provider, buckets, ...(model !== undefined ? { model } : {}), ...(day !== undefined ? { day } : {}) }
}

export function negateUsage(b: BilledUsage): BilledUsage {
  return { input: -b.input, cacheRead: -b.cacheRead, cacheWrite: -b.cacheWrite, output: -b.output }
}
