import { asRecord } from './services'
import type { AgentForest, AgentNode } from './agentTree'

export interface FleetTeamMember {
  id: string
  name: string
  role: 'lead' | 'teammate'
  phase: 'provisioning' | 'active' | 'failed'
  error?: string
}

export interface FleetTeamTask {
  id: string
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed'
  ownerId?: string
  ownerName?: string
  blockedBy: string[]
  writeScopes: string[]
  ready: boolean
  warnings: string[]
}

export interface FleetTeam {
  members: FleetTeamMember[]
  tasks: FleetTeamTask[]
  failure?: string
}

function memberOf(value: unknown): FleetTeamMember | null {
  const rec = asRecord(value)
  if (rec === null) return null
  if (typeof rec.id !== 'string' || rec.id === '') return null
  if (typeof rec.name !== 'string' || rec.name === '') return null
  if (rec.role !== 'lead' && rec.role !== 'teammate') return null
  if (rec.phase !== 'provisioning' && rec.phase !== 'active' && rec.phase !== 'failed') return null
  return {
    id: rec.id,
    name: rec.name,
    role: rec.role,
    phase: rec.phase,
    ...(typeof rec.error === 'string' && rec.error !== '' ? { error: rec.error } : {}),
  }
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v !== '')
}

function taskOf(value: unknown): FleetTeamTask | null {
  const rec = asRecord(value)
  if (rec === null) return null
  if (typeof rec.id !== 'string' || rec.id === '') return null
  if (typeof rec.subject !== 'string' || rec.subject === '') return null
  if (rec.status !== 'pending' && rec.status !== 'in_progress' && rec.status !== 'completed') return null
  return {
    id: rec.id,
    subject: rec.subject,
    description: typeof rec.description === 'string' ? rec.description : '',
    status: rec.status,
    ...(typeof rec.ownerId === 'string' && rec.ownerId !== '' ? { ownerId: rec.ownerId } : {}),
    ...(typeof rec.ownerName === 'string' && rec.ownerName !== '' ? { ownerName: rec.ownerName } : {}),
    blockedBy: stringsOf(rec.blockedBy),
    writeScopes: stringsOf(rec.writeScopes),
    ready: rec.ready === true,
    warnings: stringsOf(rec.writeScopeWarnings),
  }
}

export function teamOf(value: unknown): FleetTeam | null {
  const rec = asRecord(value)
  if (rec === null || rec.enabled === false) return null
  if (!Array.isArray(rec.members) && !Array.isArray(rec.tasks)) return null
  const members: FleetTeamMember[] = []
  if (Array.isArray(rec.members)) {
    for (const entry of rec.members) {
      const member = memberOf(entry)
      if (member !== null) members.push(member)
    }
  }
  const tasks: FleetTeamTask[] = []
  if (Array.isArray(rec.tasks)) {
    for (const entry of rec.tasks) {
      const task = taskOf(entry)
      if (task !== null) tasks.push(task)
    }
  }
  return {
    members,
    tasks,
    ...(typeof rec.failure === 'string' && rec.failure !== '' ? { failure: rec.failure } : {}),
  }
}

export function teamMemberOf(team: FleetTeam | null, sessionId: string): FleetTeamMember | null {
  if (team === null) return null
  for (const member of team.members) {
    if (member.id === sessionId) return member
  }
  return null
}

export function teammateNameOf(team: FleetTeam | null, node: AgentNode): string | undefined {
  if (node.isCurrent) return undefined
  const member = teamMemberOf(team, node.id)
  return member !== null && member.role === 'teammate' ? member.name : undefined
}

export function memberIdByName(team: FleetTeam | null, name: string | undefined): string | undefined {
  if (team === null || name === undefined) return undefined
  for (const member of team.members) {
    if (member.name === name) return member.id
  }
  return undefined
}

export function taskOwnerIdOf(team: FleetTeam | null, task: FleetTeamTask): string | undefined {
  return task.ownerId ?? memberIdByName(team, task.ownerName)
}

export function tasksOfOwnerId(team: FleetTeam | null, ownerId: string): FleetTeamTask[] {
  if (team === null) return []
  return team.tasks.filter(task => taskOwnerIdOf(team, task) === ownerId)
}

export function familyOthersOf(forest: AgentForest | null, team: FleetTeam | null): AgentNode[] {
  if (forest === null) return []
  const owners = new Set<string>()
  for (const task of team?.tasks ?? []) {
    const ownerId = taskOwnerIdOf(team, task)
    if (ownerId !== undefined) owners.add(ownerId)
  }
  return forest.nodes.filter(n => !n.isCurrent && teamMemberOf(team, n.id) === null && !owners.has(n.id))
}
