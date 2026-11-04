import type { RequestRecord } from '../shared/types'

export function actualOf(req: RequestRecord): number | null {
  const prompt = req.prompt
  return prompt !== undefined && Number.isFinite(prompt) && prompt > 0 ? prompt : null
}

export function actualMaxOf(requests: readonly RequestRecord[]): number {
  let max = 0
  for (const req of requests) {
    const actual = actualOf(req)
    if (actual !== null && actual > max) max = actual
  }
  return max
}
