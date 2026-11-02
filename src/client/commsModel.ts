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

const PREVIEW_MAX = 600

export function fromPartyOf(row: CommsRow): string {
  if (row.from !== undefined) return row.from
  if (row.fromName !== undefined) return NAME_PARTY_PREFIX + row.fromName
  return UNKNOWN_PARTY
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

const AVATAR_LINE_MAX = 3

export interface AvatarLabel {
  lines: readonly string[]
  condensed: boolean
}

export function avatarLabelOf(label: string): AvatarLabel {
  const glyphs = Array.from(label)
  if (glyphs.length <= AVATAR_LINE_MAX) {
    return { lines: [label], condensed: glyphs.length === AVATAR_LINE_MAX }
  }
  const parts = /^(\D+)(\d+)$/.exec(label)
  if (parts !== null) return { lines: [parts[1], parts[2]], condensed: false }
  const breakAt = Math.ceil(glyphs.length / 2)
  return { lines: [glyphs.slice(0, breakAt).join(''), glyphs.slice(breakAt).join('')], condensed: false }
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
