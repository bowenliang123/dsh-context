export interface FoldJournalDrain {
  ids: string[] | null
  workerIds: string[] | null
}

const FOLDED_IDS_MAX = 4096

export function makeFoldJournal(): {
  note: (id: string, viaWorker?: boolean) => void
  drain: () => FoldJournalDrain
} {
  let idsOverflow = false
  const ids = new Set<string>()
  const workers = new Set<string>()
  return {
    note(id: string, viaWorker = false): void {
      if (idsOverflow) return
      ids.add(id)
      if (ids.size > FOLDED_IDS_MAX) {
        ids.clear()
        idsOverflow = true
      }
      if (viaWorker) workers.add(id)
    },
    drain(): FoldJournalDrain {
      const drainedIds = idsOverflow ? null : [...ids]
      const drainedWorkers = idsOverflow ? null : [...workers]
      ids.clear()
      workers.clear()
      idsOverflow = false
      return { ids: drainedIds, workerIds: drainedWorkers }
    },
  }
}
