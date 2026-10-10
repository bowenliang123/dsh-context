/**
 * The Agent Teams plane of the Fleet tab — the pure model behind the team panel and every
 * member/task badge elsewhere. The harness's experimental `agentTeam` projection rides the LEAD
 * session's wire values (and every session-list row's projection hints with it), so the tab reads
 * the family roster and the shared task board off the snapshot it already holds — no extra fetch.
 *
 * The projection exists only when the deployment composes the experimental agent-team plugin, and
 * its payload is untrusted like every other wire value: absent stays null (the panel hides), and
 * malformed entries drop alone.
 */

import { asRecord } from './services'

export interface FleetTeamMember {
  id: string
  name: string
  role: 'lead' | 'teammate'
  /** Durable lifecycle; the lead's row is always active. */
  phase: 'provisioning' | 'active' | 'failed'
  error?: string
}

export interface FleetTeamTask {
  id: string
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Owner membership NAME (the wire view carries names, not ids — join by name). */
  ownerName?: string
  blockedBy: string[]
  writeScopes: string[]
  /** Server-computed readiness: pending with every blocker completed. Readiness never auto-starts the owner. */
  ready: boolean
  warnings: string[]
}

export interface FleetTeam {
  /** Lead first (the harness synthesizes its row), then roster order. */
  members: FleetTeamMember[]
  /** The non-deleted task board, in board order. */
  tasks: FleetTeamTask[]
  /** The first rejected durable record; the board then sits at its last valid state. */
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
    ...(typeof rec.ownerName === 'string' && rec.ownerName !== '' ? { ownerName: rec.ownerName } : {}),
    blockedBy: stringsOf(rec.blockedBy),
    writeScopes: stringsOf(rec.writeScopes),
    ready: rec.ready === true,
    warnings: stringsOf(rec.writeScopeWarnings),
  }
}

/** Narrow a delivered `agentTeam` projection value; a record without a sound member list degrades whole to null. */
export function teamOf(value: unknown): FleetTeam | null {
  const rec = asRecord(value)
  if (rec === null || !Array.isArray(rec.members)) return null
  const members: FleetTeamMember[] = []
  for (const entry of rec.members) {
    const member = memberOf(entry)
    if (member !== null) members.push(member)
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

/** The membership row of one session id, or null when the session sits outside the roster. */
export function teamMemberOf(team: FleetTeam | null, sessionId: string): FleetTeamMember | null {
  if (team === null) return null
  for (const member of team.members) {
    if (member.id === sessionId) return member
  }
  return null
}

/** A member's id off their roster NAME — the task board's ownership join key. */
export function memberIdByName(team: FleetTeam | null, name: string | undefined): string | undefined {
  if (team === null || name === undefined) return undefined
  for (const member of team.members) {
    if (member.name === name) return member.id
  }
  return undefined
}

/** The tasks one member owns, in board order. */
export function tasksOfOwner(team: FleetTeam | null, ownerName: string | undefined): FleetTeamTask[] {
  if (team === null || ownerName === undefined) return []
  return team.tasks.filter(task => task.ownerName === ownerName)
}
