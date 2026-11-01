import { type CommsRow, type SettledVariant } from './fleetDetail'
import type { ViewKit } from './viewkit'

export const NAME_PARTY_PREFIX = '@name:'
export const UNKNOWN_PARTY = '@unknown'
export const NEUTRAL_HUE = 'var(--dsw-alias-label-secondary)'

export type CommsRole = 'lead' | 'teammate' | 'subagent' | 'agent' | 'other'

export interface CommsAgent {
  id: string
  name: string
  role: CommsRole
  self: boolean
  hue: string
  initials?: string
  description?: string
}

export type CommsKindFilter = 'all' | 'message' | 'report'

export interface CommsChannel {
  key: string
  a: string
  b: string
  rows: CommsRow[]
  out: number
  back: number
  lastTime: number
  kinds: Record<CommsRow['kind'], number>
}

const PREVIEW_MAX = 600
const CHANNEL_SEP = '\u0000'

export function fromPartyOf(row: CommsRow): string {
  if (row.from !== undefined) return row.from
  if (row.fromName !== undefined) return NAME_PARTY_PREFIX + row.fromName
  return UNKNOWN_PARTY
}

export function channelKeyOf(row: CommsRow): string {
  const from = fromPartyOf(row)
  return from <= row.to ? `${from}${CHANNEL_SEP}${row.to}` : `${row.to}${CHANNEL_SEP}${from}`
}

export function nameOfParty(party: string): string | undefined {
  return party.startsWith(NAME_PARTY_PREFIX) ? party.slice(NAME_PARTY_PREFIX.length) : undefined
}

export function kindGroupOf(row: CommsRow): Exclude<CommsKindFilter, 'all'> {
  return row.kind === 'settled' ? 'report' : 'message'
}

export function includesAgent(row: CommsRow, id: string): boolean {
  return fromPartyOf(row) === id || row.to === id
}

export function settledToneOf(variant: SettledVariant | null): 'done' | 'warning' | 'error' | 'idle' {
  if (variant === 'finished' || variant === 'finishedFinal') return 'done'
  if (variant === 'failed') return 'error'
  if (variant === 'stopped' || variant === 'outOfRoom' || variant === 'declined') return 'warning'
  return 'idle'
}

export function previewOf(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const out = plain !== '' ? plain : text.replace(/\s+/g, ' ').trim()
  return out.length > PREVIEW_MAX ? out.slice(0, PREVIEW_MAX) + '…' : out
}

export function initialsOf(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') return '?'
  const chars = Array.from(trimmed)
  if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(chars[0])) {
    return chars.filter(char => !/\s/.test(char)).slice(0, 2).join('')
  }
  const words = trimmed.split(/[\s._-]+/).filter(word => word !== '')
  if (words.length >= 2) {
    const a = Array.from(words[0])[0]
    const b = Array.from(words[1])[0]
    return (a + b).toUpperCase()
  }
  const word = words[0] ?? ''
  if (word === '') return '?'
  return Array.from(word).slice(0, 2).join('').toUpperCase()
}

export function avatarNameOf(name: string, role: CommsRole, t: ViewKit['t']): string {
  return role === 'lead' ? t('fleet.role.lead') : name
}

export function avatarLabelsOf(entries: Iterable<{ id: string; name: string }>): ReadonlyMap<string, string> {
  const groups = new Map<string, string[]>()
  for (const entry of entries) {
    const base = initialsOf(entry.name)
    const ids = groups.get(base)
    if (ids === undefined) groups.set(base, [entry.id])
    else if (!ids.includes(entry.id)) ids.push(entry.id)
  }
  const labels = new Map<string, string>()
  for (const [base, ids] of groups) {
    if (ids.length === 1) labels.set(ids[0], base)
    else ids.sort().forEach((id, index) => labels.set(id, `${base}${index + 1}`))
  }
  return labels
}

export function channelsOf(rows: readonly CommsRow[], anchorId?: string): CommsChannel[] {
  const groups = new Map<string, CommsRow[]>()
  for (const row of rows) {
    const key = channelKeyOf(row)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [row])
    else group.push(row)
  }
  const channels: CommsChannel[] = []
  for (const [key, group] of groups) {
    const sep = key.indexOf(CHANNEL_SEP)
    const p1 = key.slice(0, sep)
    const p2 = key.slice(sep + CHANNEL_SEP.length)
    const sent1 = group.filter(row => fromPartyOf(row) === p1).length
    const sent2 = group.filter(row => fromPartyOf(row) === p2).length
    const preferP1 = anchorId === p1
      || (anchorId !== p2 && (sent1 > sent2 || (sent1 === sent2 && p1 <= p2)))
    const a = preferP1 ? p1 : p2
    const b = preferP1 ? p2 : p1
    group.sort((x, y) => y.time - x.time)
    let out = 0
    let back = 0
    const kinds: Record<CommsRow['kind'], number> = { relay: 0, mailbox: 0, settled: 0 }
    for (const row of group) {
      const from = fromPartyOf(row)
      if (from === a) out += 1
      else back += 1
      kinds[row.kind] += 1
    }
    const lastTime = Math.max(...group.map(row => row.time))
    channels.push({
      key,
      a,
      b,
      rows: group,
      out,
      back,
      lastTime,
      kinds,
    })
  }
  channels.sort((x, y) => y.lastTime - x.lastTime)
  return channels
}
