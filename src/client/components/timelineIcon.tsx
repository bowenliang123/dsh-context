import type { ReactElement } from 'react'

export function TimelineIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 4.75v2M3.5 9.25v2" />
      <circle cx="3.5" cy="3.5" r="1.25" />
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="3.5" cy="12.5" r="1.25" />
      <path d="M7 3.5h6M7 8h4M7 12.5h6" />
    </svg>
  )
}
