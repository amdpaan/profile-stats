// Pure parsing and statistics for the Profile panel: no `$`, no I/O, so the
// tests in stats.test.ts exercise exactly what the panel runs.

import type { Stats } from '../types'

// Days and streaks are counted in a fixed UTC offset, set from the mod's
// `utcOffsetHours` option (default +8, Asia/Kuala_Lumpur, which has no
// daylight saving). A zone with daylight saving is off by an hour part of
// the year.
let tzOffsetMs = 8 * 3600 * 1000
export const setUtcOffsetHours = (hours: number) => {
  if (Number.isFinite(hours) && hours >= -12 && hours <= 14) tzOffsetMs = hours * 3600 * 1000
}
export const tzOffset = () => tzOffsetMs
// A gap longer than this inside a turn (a stalled retry, a backgrounded
// command) does not count toward "Longest task".
export const STALL_MS = 5 * 60 * 1000

// USD per million tokens: input, output, cache read. Cache writes cost 1.25x
// input for the 5-minute cache and 2x input for the 1-hour cache (the rates
// Claude Code's own cost records use); fast mode costs 2x. Anthropic API list
// prices. A model missing here is priced as Claude Opus 5.5 and counted as
// unpriced, so the panel can say the cost is partly a guess.
export const PRICES: Record<string, [number, number, number]> = {
  'claude-fable-5-2': [8, 40, 0.2],
  'claude-mythos-5-2': [8, 40, 0.2],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.1],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
}
const FALLBACK_MODEL = 'claude-opus-5-5'

// A session's folder named as a project: its last path part, with a Claude
// worktree (<repo>/.claude/worktrees/<name>) counted under its repo.
export const projectName = (cwd: string) => {
  const repo = cwd.replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/, '')
  return repo.split(/[\\/]/).filter(Boolean).pop() ?? repo
}
export const NO_PROJECT = 'Other'

// ---------------------------------------------------------------------------
// Per-file cache: one entry per log file, read incrementally from a byte
// offset, so a refresh only parses what was appended since the last one.
// ---------------------------------------------------------------------------

export type FileEntry = {
  off: number // bytes consumed so far
  lastId?: string // last assistant message id (split records repeat it)
  ts?: number // open turn: start ms
  te?: number // open turn: last activity ms
  ta?: number // open turn: active ms so far (stalls left out)
  longest: number // longest closed turn in this file, active ms
  days: Record<string, number> // all tokens per local day
  cost: Record<string, number> // estimated USD per local day
  cwd?: string // last folder the session ran in
  projects: Record<string, Usage> // project -> tokens and USD
  unpriced: number // responses from a model missing from PRICES
}
export type Usage = { tokens: number; usd: number }
export type Cache = { files: Record<string, FileEntry> }

export const freshEntry = (): FileEntry => ({
  off: 0,
  longest: 0,
  days: {},
  cost: {},
  projects: {},
  unpriced: 0,
})

// ---------------------------------------------------------------------------
// History: totals that outlive the logs. Claude Code deletes old session
// logs, and the per-file cache is rebuilt whenever the counting changes, so
// every refresh folds its totals into this record, which nothing resets.
// Each value only ever grows, so merging takes the larger of the two.
// ---------------------------------------------------------------------------

export type History = {
  days: Record<string, Usage>
  projects: Record<string, Usage>
  longest: number
  unpriced: number
}

export const emptyHistory = (): History => ({ days: {}, projects: {}, longest: 0, unpriced: 0 })

export const dayKey = (ms: number) => new Date(ms + tzOffsetMs).toISOString().slice(0, 10)

// "Paan" -> "P", "Ada Lovelace" -> "AL"
export const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]!.toUpperCase())
    .join('') || '?'

export const addDays = (key: string, n: number) =>
  new Date(Date.parse(key + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)

export const utf8len = (s: string) => {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

// A turn starts at a prompt the person (or the app on their behalf) sent:
// a user record that is not a tool result, not meta and not a subagent's.
export const isPrompt = (d: any) => {
  if (d.type !== 'user' || d.isMeta || d.isSidechain) return false
  if (d.toolUseResult !== undefined && d.toolUseResult !== null) return false
  let c = d.message?.content
  if (Array.isArray(c)) {
    if (c.some((b: any) => b && b.type === 'tool_result')) return false
    c = c
      .filter((b: any) => b && b.type === 'text')
      .map((b: any) => b.text ?? '')
      .join(' ')
  }
  if (typeof c !== 'string') return false
  const t = c.trimStart()
  if (!t) return false
  return !(
    t.startsWith('<local-command') ||
    t.startsWith('<command-') ||
    t.startsWith('[Request interrupted')
  )
}

export function costOf(model: string, u: any): { usd: number; isPriced: boolean } {
  const isPriced = model in PRICES
  const [pin, pout, pread] = PRICES[isPriced ? model : FALLBACK_MODEL]
  const write = Number(u.cache_creation_input_tokens) || 0
  const w1h = Math.min(write, Number(u.cache_creation?.ephemeral_1h_input_tokens) || 0)
  const w5m = write - w1h
  const usd =
    ((Number(u.input_tokens) || 0) * pin +
      (Number(u.output_tokens) || 0) * pout +
      (Number(u.cache_read_input_tokens) || 0) * pread +
      w5m * pin * 1.25 +
      w1h * pin * 2) /
    1e6
  return { usd: u.speed === 'fast' ? usd * 2 : usd, isPriced }
}

// Folds one log line into the file's entry. A malformed line is skipped.
export function take(f: FileEntry, line: string) {
  if (!line) return
  let d: any
  try {
    d = JSON.parse(line)
  } catch {
    return
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return
  const ms = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN
  const hasMs = Number.isFinite(ms)
  if (typeof d.cwd === 'string' && d.cwd) f.cwd = d.cwd

  // Turn timing
  if (hasMs && isPrompt(d)) {
    if (f.ts !== undefined) f.longest = Math.max(f.longest, f.ta ?? 0)
    f.ts = ms
    f.te = ms
    f.ta = 0
  } else if (
    hasMs &&
    (d.type === 'user' || d.type === 'assistant') &&
    !d.isSidechain &&
    f.ts !== undefined
  ) {
    const gap = ms - (f.te ?? ms)
    if (gap > 0 && gap <= STALL_MS) f.ta = (f.ta ?? 0) + gap
    f.te = Math.max(f.te ?? ms, ms)
  }

  if (d.type !== 'assistant') return
  const m = d.message
  if (!m || typeof m !== 'object') return

  // One API response is written as several records (one per content block),
  // each carrying the same id and the same usage: count it once.
  const id = typeof m.id === 'string' ? m.id : undefined
  if (id !== undefined && id === f.lastId) return
  f.lastId = id
  const u = m.usage
  if (!u || typeof u !== 'object' || !hasMs) return
  // Every token the API processed: input, output, cache writes, cache reads.
  const n =
    (Number(u.input_tokens) || 0) +
    (Number(u.output_tokens) || 0) +
    (Number(u.cache_creation_input_tokens) || 0) +
    (Number(u.cache_read_input_tokens) || 0)
  if (n <= 0) return
  const k = dayKey(ms)
  f.days[k] = (f.days[k] ?? 0) + n
  const { usd, isPriced } = costOf(typeof m.model === 'string' ? m.model : '', u)
  f.cost[k] = (f.cost[k] ?? 0) + usd
  if (!f.projects) f.projects = {}
  const p = (f.projects[f.cwd ? projectName(f.cwd) : NO_PROJECT] ??= { tokens: 0, usd: 0 })
  p.tokens += n
  p.usd += usd
  if (!isPriced) f.unpriced = (f.unpriced ?? 0) + 1
}

// The cache's totals folded into the history: the larger value wins, so a
// day whose logs are gone keeps what it had, and a growing day takes the new.
export function mergeHistory(prev: History, cache: Cache): History {
  const days: History['days'] = {}
  for (const [k, v] of Object.entries(prev.days)) days[k] = { ...v }
  const now: History['days'] = {}
  const projects: History['projects'] = {}
  let longest = 0
  let unpriced = 0
  for (const f of Object.values(cache.files)) {
    for (const [k, v] of Object.entries(f.days)) {
      const d = (now[k] ??= { tokens: 0, usd: 0 })
      d.tokens += v
      d.usd += f.cost?.[k] ?? 0
    }
    for (const [k, v] of Object.entries(f.projects ?? {})) {
      const p = (projects[k] ??= { tokens: 0, usd: 0 })
      p.tokens += v.tokens
      p.usd += v.usd
    }
    longest = Math.max(longest, f.longest, f.ta ?? 0)
    unpriced += f.unpriced ?? 0
  }
  for (const [k, v] of Object.entries(now)) {
    const old = days[k]
    if (!old || v.tokens >= old.tokens) days[k] = v
  }
  const allProjects: History['projects'] = {}
  for (const [k, v] of Object.entries(prev.projects ?? {})) allProjects[k] = { ...v }
  for (const [k, v] of Object.entries(projects)) {
    const old = allProjects[k]
    if (!old || v.tokens >= old.tokens) allProjects[k] = v
  }
  return {
    days,
    projects: allProjects,
    longest: Math.max(prev.longest, longest),
    unpriced: Math.max(prev.unpriced, unpriced),
  }
}

export function summarize(h: History, now: number, isParsing: boolean): Stats {
  let lifetime = 0
  let costUsd = 0
  let peak: Stats['peak'] = null
  for (const [k, v] of Object.entries(h.days)) {
    lifetime += v.tokens
    costUsd += v.usd
    if (!peak || v.tokens > peak.tokens) peak = { day: k, tokens: v.tokens }
  }
  const has = (k: string) => (h.days[k]?.tokens ?? 0) > 0
  const active = Object.keys(h.days).filter(has).sort()
  let longestStreak = 0
  let run = 0
  let prev: string | undefined
  for (const k of active) {
    run = prev !== undefined && addDays(prev, 1) === k ? run + 1 : 1
    longestStreak = Math.max(longestStreak, run)
    prev = k
  }
  const today = dayKey(now)
  // A streak still counts while today has no usage yet.
  let cur = has(today) ? today : addDays(today, -1)
  let currentStreak = 0
  while (has(cur)) {
    currentStreak++
    cur = addDays(cur, -1)
  }
  const days: Record<string, number> = {}
  const costDays: Record<string, number> = {}
  const from = addDays(today, -380)
  for (const [k, v] of Object.entries(h.days)) {
    if (k < from) continue
    days[k] = v.tokens
    costDays[k] = v.usd
  }
  const topProjects = Object.entries(h.projects ?? {})
    .filter(([, v]) => v.tokens > 0)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, 5)
    .map(([name, v]) => ({ name, tokens: v.tokens, usd: v.usd }))
  return {
    lifetime,
    peak,
    longestTurnMs: h.longest,
    costUsd,
    unpriced: h.unpriced,
    longestStreak,
    currentStreak,
    today,
    days,
    costDays,
    topProjects,
    updatedAt: now,
    isParsing,
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export const fmtTokens = (n: number) => {
  // One decimal, as in 148.5m; a trailing .0 is dropped (2m, not 2.0m).
  const one = (x: number) => (Math.round(x * 10) / 10).toString()
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) return `${one(n / 1e3)}k`
  if (n < 1e9) return `${one(n / 1e6)}m`
  return `${(Math.round((n / 1e9) * 100) / 100).toString()}b`
}
export const fmtUsd = (n: number) => {
  if (n < 1000) return `$${n.toFixed(2)}`
  if (n < 1e6) return `$${(Math.round(n / 100) / 10).toString()}k`
  return `$${(Math.round(n / 1e5) / 10).toString()}m`
}
export const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${r}s`
  return `${r}s`
}
export const fmtDay = (k: string) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${Number(k.slice(8, 10))}`
export const fmtWeekday = (k: string) =>
  `${WEEKDAYS[new Date(k + 'T00:00:00Z').getUTCDay()]}, ${fmtDay(k)}`
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
