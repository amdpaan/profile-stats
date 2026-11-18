export type Mode = 'daily' | 'weekly' | 'cumulative'

export type Stats = {
  lifetime: number
  peak: { day: string; tokens: number } | null
  longestTurnMs: number
  costUsd: number
  unpriced: number // replies from models with no price, priced as Opus 5.5
  longestStreak: number
  currentStreak: number
  today: string
  days: Record<string, number> // tokens per local day, last ~12 months
  costDays: Record<string, number> // USD per local day, last ~12 months
  topTools: { name: string; count: number }[]
  updatedAt: number
  isParsing: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'profile-stats': { stats: Shaped<Stats | null>; mode: Mode }
  }
}
