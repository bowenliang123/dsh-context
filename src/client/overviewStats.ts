export interface TokenPartTotal {
  key: string
  color: string
  value: number
}

export interface DayTotals {
  tokens: number
  sessions: number
  cost: number | null
}
