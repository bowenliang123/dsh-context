import { calculateSessionCost, priceLookupsOf, type PriceFace, type PriceMiss } from '../shared/pricing'
import type {
  CostPriceFace,
  CostPriceMiss,
  SessionCostRead,
  SessionCostUsage,
} from '../shared/types'
import type { CatalogService } from './catalog'

export interface CostSource {
  read(usage: SessionCostUsage | null | undefined): SessionCostRead | undefined
  usd(usage: SessionCostUsage | null | undefined): number | null
  ready(): boolean
  version?(): number
}

function faceOf(provider: string, model: string, face: PriceFace): CostPriceFace {
  return {
    provider,
    model,
    rate: face.rate,
    via: face.via,
    confidence: face.confidence,
    ...(face.canonical === undefined ? {} : { canonical: face.canonical }),
  }
}

function missOf(provider: string, model: string, miss: PriceMiss): CostPriceMiss {
  return {
    provider,
    model,
    reason: miss.reason,
    ...(miss.reason === 'ambiguous' ? { candidates: miss.candidates } : {}),
  }
}

export function createCostSource(catalog: CatalogService): CostSource {
  return {
    ready(): boolean {
      return catalog.book() !== null
    },
    read(usage: SessionCostUsage | null | undefined): SessionCostRead | undefined {
      if (usage === null || usage === undefined) return undefined
      catalog.ensure()
      const book = catalog.book()
      if (book === null) return { usd: null, ready: false }
      const usd = calculateSessionCost(usage, book)
      const faces: CostPriceFace[] = []
      const misses: CostPriceMiss[] = []
      for (const lookup of priceLookupsOf(usage, book)) {
        if (lookup.face !== null) faces.push(faceOf(lookup.provider, lookup.model, lookup.face))
        else misses.push(missOf(lookup.provider, lookup.model, lookup.miss))
      }
      return {
        usd,
        ready: true,
        ...(faces.length === 0 ? {} : { faces }),
        ...(misses.length === 0 ? {} : { misses }),
      }
    },
    usd(usage: SessionCostUsage | null | undefined): number | null {
      if (usage === null || usage === undefined) return null
      catalog.ensure()
      return calculateSessionCost(usage, catalog.book())
    },
    version(): number {
      return catalog.pricesVersion()
    },
  }
}

interface Costed {
  cost?: SessionCostUsage
}

export function withCost<T extends object>(cost: CostSource | undefined, value: T): T & { costRead?: SessionCostRead } {
  if (cost === undefined) return value
  const read = cost.read((value as Costed).cost)
  return read === undefined ? value : { ...value, costRead: read }
}

export function withDetailCost<T extends object>(
  cost: CostSource | undefined,
  detail: T,
): T & { head?: Costed & { costRead?: SessionCostRead } } {
  const head = (detail as { head?: Costed }).head
  if (cost === undefined || head === undefined) return detail
  return { ...detail, head: withCost(cost, head) }
}
