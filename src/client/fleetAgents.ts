import { LEAD_HUE, familyHue, type AgentNode } from './agentTree'
import {
  NEUTRAL_HUE,
  UNKNOWN_PARTY,
  avatarLabelsOf,
  avatarNameOf,
  nameOfParty,
  type CommsAgent,
  type CommsRole,
} from './commsModel'
import type { CommsRow } from './fleetDetail'
import type { FleetTeam } from './fleetTeam'
import type { ViewKit } from './viewkit'
import type { FleetMemberInfo } from '../shared/types'

export function attestedNamesOf(rows: readonly CommsRow[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const row of rows) {
    if (row.from !== undefined && row.fromName !== undefined && !names.has(row.from)) {
      names.set(row.from, row.fromName)
    }
  }
  return names
}

export function commsAgentsOf(
  nodes: readonly AgentNode[],
  team: FleetTeam | null,
  roster: readonly FleetMemberInfo[] | undefined,
  attested: ReadonlyMap<string, string>,
  t: ViewKit['t'],
): Map<string, CommsAgent> {
  const map = new Map<string, CommsAgent>()
  const info = new Map((roster ?? []).map(entry => [entry.name, entry]))
  const members = team?.members ?? []
  const memberAt = new Map(members.map((member, index) => [member.id, { member, index }]))
  for (const node of nodes) {
    const entry = memberAt.get(node.id)
    if (entry === undefined) {
      const name = attested.get(node.id)
      const role: CommsRole = name === 'lead'
        ? 'lead'
        : name !== undefined ? 'teammate' : node.isCurrent ? 'agent' : 'subagent'
      const shown = avatarNameOf(name ?? node.label, role, t)
      map.set(node.id, {
        id: node.id,
        name: shown,
        role,
        self: node.isCurrent,
        hue: role === 'lead' || node.isCurrent ? LEAD_HUE : familyHue(node.family),
        ...(name !== undefined && node.label !== shown ? { description: node.label } : {}),
      })
      continue
    }
    const role: CommsRole = entry.member.role
    const shown = avatarNameOf(entry.member.name, role, t)
    const description = info.get(entry.member.name)?.description ?? node.label
    map.set(node.id, {
      id: node.id,
      name: shown,
      role,
      self: node.isCurrent,
      hue: role === 'lead' ? LEAD_HUE : familyHue(entry.index),
      ...(description !== '' && description !== shown ? { description } : {}),
    })
  }
  for (const [index, member] of members.entries()) {
    if (map.has(member.id)) continue
    const role: CommsRole = member.role
    const description = info.get(member.name)?.description
    map.set(member.id, {
      id: member.id,
      name: avatarNameOf(member.name, role, t),
      role,
      self: false,
      hue: role === 'lead' ? LEAD_HUE : familyHue(index),
      ...(description !== undefined && description !== '' ? { description } : {}),
    })
  }
  const labels = avatarLabelsOf(map.values())
  for (const agent of map.values()) agent.initials = labels.get(agent.id)
  return map
}

function shortIdOf(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + '…' : id
}

export function fallbackAgentOf(
  party: string,
  titles: ReadonlyMap<string, string>,
  attested: ReadonlyMap<string, string>,
  t: ViewKit['t'],
): CommsAgent {
  const named = nameOfParty(party)
  if (named !== undefined) return { id: party, name: named, role: 'other', self: false, hue: NEUTRAL_HUE }
  const known = attested.get(party)
  if (known !== undefined) return { id: party, name: known, role: 'other', self: false, hue: NEUTRAL_HUE }
  const title = titles.get(party)
  if (title !== undefined) {
    return { id: party, name: title, role: 'other', self: false, hue: NEUTRAL_HUE, description: party }
  }
  return {
    id: party,
    name: party === UNKNOWN_PARTY ? t('fleet.comms.unknown') : t('fleet.comms.agentId', { id: shortIdOf(party) }),
    role: 'other',
    self: false,
    hue: NEUTRAL_HUE,
  }
}

export function agentResolverOf(
  agents: ReadonlyMap<string, CommsAgent>,
  titles: ReadonlyMap<string, string>,
  attested: ReadonlyMap<string, string>,
  t: ViewKit['t'],
): (party: string) => CommsAgent {
  return party => agents.get(party) ?? fallbackAgentOf(party, titles, attested, t)
}
