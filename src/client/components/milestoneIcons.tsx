import type { ReactElement } from 'react'
import type { MilestoneKind } from './trendMilestones'

export const MILESTONE_COLOR: Record<MilestoneKind, string> = {
  compaction: 'var(--dsw-alias-state-error-primary)',
  prune: 'var(--color-violet-500)',
  skill: 'var(--color-orange-500)',
  agent: 'var(--color-purple-500)',
  spawn: 'var(--dsw-alias-state-success-primary)',
  model: 'var(--dsw-alias-label-secondary)',
  longest: 'var(--color-blue-500)',
  growth: 'var(--color-teal-500)',
  'goal-create': 'var(--color-blue-500)',
  'goal-complete': 'var(--dsw-alias-state-success-primary)',
  'todo-add': 'var(--color-indigo-500)',
  'todo-done': 'var(--color-teal-500)',
  ask: 'var(--dsw-alias-state-warn-primary)',
  'team-task-create': 'var(--color-pink-500)',
  'team-task-complete': 'var(--color-violet-500)',
}

const GLYPHS: Record<MilestoneKind, ReactElement> = {
  compaction: <path d="M1.6 2.2h6.8L6 5.1v2.4L4 8.3V5.1z" />,
  prune: (
    <>
      <circle cx="2.6" cy="2.6" r="1.2" />
      <circle cx="2.6" cy="7.4" r="1.2" />
      <path d="M3.6 3.4L8.2 6.8M3.6 6.6L8.2 3.2" />
    </>
  ),
  skill: <path d="M5 1.2l.9 2.6 2.6.9-2.6.9L5 8.8 4.1 5.6 1.5 4.7l2.6-.9z" />,
  agent: (
    <>
      <path d="M1.8 2.2h6.4v4.1H5.1L3 8.1V6.3H1.8z" />
      <circle cx="3.6" cy="4.3" r=".35" fill="currentColor" stroke="none" />
      <circle cx="6.4" cy="4.3" r=".35" fill="currentColor" stroke="none" />
    </>
  ),
  spawn: (
    <>
      <circle cx="2.5" cy="2.5" r="1" />
      <circle cx="2.5" cy="7.5" r="1" />
      <circle cx="7.5" cy="5" r="1" />
      <path d="M3.5 2.5h1.6v2.5M3.5 7.5h1.6V5" />
    </>
  ),
  model: <path d="M1.8 3.4h5.2L5.6 2M8.2 6.6H3L4.4 8" />,
  longest: (
    <>
      <circle cx="5" cy="5.6" r="3.1" />
      <path d="M5 2.5V1.4M4 1.4h2M5 5.6l1.4 1" />
    </>
  ),
  growth: (
    <>
      <path d="M1.5 7.4L4 4.9l1.4 1.4L8.5 3" />
      <path d="M6.3 3h2.2v2.2" />
    </>
  ),
  'goal-create': (
    <>
      <circle cx="5" cy="5" r="3.2" />
      <circle cx="5" cy="5" r="1.2" />
      <path d="M5 1.8V.6M8.2 5h1.2" />
    </>
  ),
  'goal-complete': (
    <>
      <path d="M2.2 8.6V1.4M2.2 1.8h5.4L6.6 3.6l1 1.8H2.2" />
      <path d="M6.2 7.1l1 1 1.8-1.8" />
    </>
  ),
  'todo-add': (
    <>
      <path d="M1.8 2.2h4.4M1.8 5h3M1.8 7.8h3" />
      <path d="M7.2 5.4v3.2M5.6 7h3.2" />
    </>
  ),
  'todo-done': (
    <>
      <path d="M1.8 2.2h4.4M1.8 5h3M1.8 7.8h2.2" />
      <path d="M5.8 7l1.2 1.2 2-2.2" />
    </>
  ),
  ask: (
    <>
      <path d="M1.8 2h6.4v4H5.2L3.1 7.8V6H1.8z" />
      <path d="M4 3.3c.1-.5.5-.8 1-.8.6 0 1 .4 1 .9 0 .7-.9.8-.9 1.4" />
      <circle cx="5.1" cy="5.2" r=".25" fill="currentColor" stroke="none" />
    </>
  ),
  'team-task-create': (
    <>
      <rect x="2.8" y="1.8" width="4.4" height="6.4" rx=".5" />
      <path d="M4 1.8V1h2v.8" />
      <path d="M5 4v2.2M3.9 5.1h2.2" />
    </>
  ),
  'team-task-complete': (
    <>
      <rect x="2.8" y="1.8" width="4.4" height="6.4" rx=".5" />
      <path d="M4 1.8V1h2v.8" />
      <path d="M4.1 5l.8.8 1.5-1.5" />
    </>
  ),
}

export function MilestoneIcon({ kind }: { kind: MilestoneKind }): ReactElement {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[kind]}
    </svg>
  )
}
