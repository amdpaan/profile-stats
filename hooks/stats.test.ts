import { expect, test } from 'claude-code/testing'

import {
  type Cache,
  type FileEntry,
  costOf,
  dayKey,
  emptyHistory,
  initialsOf,
  setUtcOffsetHours,
  fmtDur,
  fmtTokens,
  fmtUsd,
  freshEntry,
  mergeHistory,
  projectName,
  summarize,
  take,
  utf8len,
} from './stats'

const NOW = Date.parse('2026-11-19T04:00:00Z') // 12:00 in Kuala Lumpur

const line = (o: unknown) => JSON.stringify(o)

const prompt = (ts: string, text = 'do it') =>
  line({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })

const toolResult = (ts: string) =>
  line({
    type: 'user',
    timestamp: ts,
    toolUseResult: {},
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
  })

const reply = (
  ts: string,
  id: string,
  usage: Record<string, unknown>,
  content: unknown[] = [{ type: 'text', text: 'hi' }],
  model = 'claude-opus-5-5',
) =>
  line({
    type: 'assistant',
    timestamp: ts,
    message: { id, model, role: 'assistant', content, usage },
  })

const feed = (lines: string[]): FileEntry => {
  const f = freshEntry()
  for (const l of lines) take(f, l)
  return f
}

const cents = (n: number) => Math.round(n * 100)

test('malformed and non-object lines are skipped, not fatal', () => {
  const f = feed([
    '{not json',
    '',
    '[1,2,3]',
    'null',
    '42',
    line({ type: 'assistant' }), // no message
    line({ type: 'assistant', timestamp: 'nope', message: { id: 'x', usage: { input_tokens: 5 } } }),
    reply('2026-11-18T02:00:00Z', 'm1', { input_tokens: 10, output_tokens: 5 }),
  ])
  expect(f.days).toEqual({ '2026-11-18': 15 })
})

test('a reply split over several records is counted once', () => {
  const usage = {
    input_tokens: 2,
    output_tokens: 100,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 400,
  }
  const f = feed([
    reply('2026-11-18T02:00:00Z', 'm1', usage, [{ type: 'thinking', thinking: '' }]),
    reply('2026-11-18T02:00:01Z', 'm1', usage, [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }]),
    reply('2026-11-18T02:00:01Z', 'm1', usage, [
      { type: 'tool_use', id: 'b', name: 'mcp__Roblox_Studio__execute_luau', input: {} },
    ]),
  ])
  expect(f.days['2026-11-18']).toBe(1502)
  expect(f.projects.Other.tokens).toBe(1502) // no cwd in these records
})

test('days are counted in Kuala Lumpur time (UTC+8)', () => {
  const f = feed([
    reply('2026-11-18T15:59:59Z', 'a', { input_tokens: 1 }), // 23:59:59 on the 18th
    reply('2026-11-18T16:00:00Z', 'b', { input_tokens: 2 }), // 00:00:00 on the 19th
  ])
  expect(f.days).toEqual({ '2026-11-18': 1, '2026-11-19': 2 })
})

test('cost: list prices, 5-minute vs 1-hour cache writes, fast mode', () => {
  // Opus 5.5: $4 in, $20 out, $0.20 cache read, writes 1.25x / 2x input.
  const u = {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 2_000_000,
    cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 1_000_000 },
  }
  const base = costOf('claude-opus-5-5', u)
  expect(cents(base.usd)).toBe(cents(4 + 20 + 0.2 + 5 + 8))
  expect(base.isPriced).toBe(true)
  expect(cents(costOf('claude-opus-5-5', { ...u, speed: 'fast' }).usd)).toBe(cents(2 * 37.2))
  expect(cents(costOf('claude-sonnet-5-5', { output_tokens: 1_000_000 }).usd)).toBe(1000)
})

test('a model with no price is priced as Opus 5.5 and flagged', () => {
  const c = costOf('claude-future-9', { output_tokens: 1_000_000 })
  expect(c.isPriced).toBe(false)
  expect(cents(c.usd)).toBe(2000)
  const f = feed([reply('2026-11-18T02:00:00Z', 'a', { output_tokens: 10 }, undefined, 'claude-future-9')])
  expect(f.unpriced).toBe(1)
})

test('a turn runs from the prompt to its last activity, stalls over 5 minutes left out', () => {
  const f = feed([
    prompt('2026-11-18T02:00:00Z'),
    reply('2026-11-18T02:02:00Z', 'a', { output_tokens: 1 }), // +2m
    toolResult('2026-11-18T02:22:00Z'), // a 20m stall: not counted
    reply('2026-11-18T02:25:00Z', 'b', { output_tokens: 1 }), // +3m
    prompt('2026-11-18T03:00:00Z'), // closes the turn at 5m
    reply('2026-11-18T03:01:00Z', 'c', { output_tokens: 1 }), // open turn: 1m
  ])
  expect(f.longest).toBe(5 * 60 * 1000)
  expect(f.ta).toBe(60 * 1000)
})

test('tool results and slash-command output do not start a turn', () => {
  const f = feed([
    prompt('2026-11-18T02:00:00Z'),
    toolResult('2026-11-18T02:04:00Z'),
    prompt('2026-11-18T02:05:00Z', '<local-command-stdout>ok</local-command-stdout>'),
    reply('2026-11-18T02:08:00Z', 'a', { output_tokens: 1 }),
  ])
  expect(f.ta).toBe(8 * 60 * 1000)
})

test('streaks: longest run, and the current one still counts before today has usage', () => {
  const h = emptyHistory()
  for (const d of ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-10', '2026-11-17', '2026-11-18'])
    h.days[d] = { tokens: 1, usd: 0 }
  const s = summarize(h, NOW, false)
  expect(s.longestStreak).toBe(3)
  expect(s.currentStreak).toBe(2) // the 17th and 18th; the 19th has nothing yet
  h.days['2026-11-16'] = { tokens: 1, usd: 0 }
  h.days['2026-11-19'] = { tokens: 1, usd: 0 }
  expect(summarize(h, NOW, false).currentStreak).toBe(4)
})

test('history keeps days whose logs are gone and takes growing days', () => {
  const day = (tokens: number, usd: number) => ({ tokens, usd })
  const prev = {
    ...emptyHistory(),
    days: { '2026-09-01': day(500, 1), '2026-11-18': day(10, 0.1) },
    projects: { gone: day(500, 1), 'profile-stats': day(10, 0.1) },
    longest: 9000,
  }
  const f = feed([
    line({ type: 'user', cwd: '/Users/paan/Projects/profile-stats', timestamp: '2026-11-18T02:00:00Z', message: { role: 'user', content: 'go' } }),
    reply('2026-11-18T02:00:00Z', 'a', { output_tokens: 40 }),
  ])
  const cache: Cache = { files: { '/log.jsonl': f } }
  const h = mergeHistory(prev, cache)
  expect(h.days['2026-09-01']).toEqual(day(500, 1)) // log deleted, total kept
  expect(h.days['2026-11-18'].tokens).toBe(40) // grew
  expect(h.projects.gone).toEqual(day(500, 1)) // log deleted, total kept
  expect(h.projects['profile-stats'].tokens).toBe(40) // grew
  expect(h.longest).toBe(9000)
  const s = summarize(h, NOW, false)
  expect(s.lifetime).toBe(540)
  expect(s.peak).toEqual({ day: '2026-09-01', tokens: 500 })
})

test('projects: named after the folder, worktrees under their repo, top 5 by tokens', () => {
  expect(projectName('/Users/paan/Projects/net-watch')).toBe('net-watch')
  expect(projectName('/Users/paan/Projects/net-watch/')).toBe('net-watch')
  expect(projectName('/Users/paan/Projects/net-watch/.claude/worktrees/fix-x')).toBe('net-watch')
  expect(projectName('C:\\Users\\paan\\wifi-heatmap')).toBe('wifi-heatmap')

  const at = (cwd: string, ts: string, id: string, n: number) => [
    line({ type: 'user', cwd, timestamp: ts, message: { role: 'user', content: 'go' } }),
    reply(ts, id, { output_tokens: n }),
  ]
  const f = feed([
    ...at('/p/a', '2026-11-18T02:00:00Z', '1', 10),
    ...at('/p/b/.claude/worktrees/w', '2026-11-18T02:01:00Z', '2', 30),
    ...at('/p/b', '2026-11-18T02:02:00Z', '3', 5),
    ...at('/p/c', '2026-11-18T02:03:00Z', '4', 1),
    ...at('/p/d', '2026-11-18T02:04:00Z', '5', 2),
    ...at('/p/e', '2026-11-18T02:05:00Z', '6', 3),
    ...at('/p/f', '2026-11-18T02:06:00Z', '7', 4),
  ])
  const s = summarize(mergeHistory(emptyHistory(), { files: { '/l.jsonl': f } }), NOW, false)
  expect(s.topProjects.map(p => [p.name, p.tokens])).toEqual([
    ['b', 35],
    ['a', 10],
    ['f', 4],
    ['e', 3],
    ['d', 2],
  ])
  expect(s.topProjects[0].usd).toBeGreaterThan(0)
})

test('a history saved before projects existed still loads', () => {
  const old = { days: { '2026-11-18': { tokens: 5, usd: 0 } }, tools: { Bash: 3 }, longest: 0, unpriced: 0 } as any
  expect(summarize(old, NOW, false).topProjects).toEqual([])
  expect(mergeHistory(old, { files: {} }).projects).toEqual({})
})

test('initials come from the display name; the UTC offset moves the day boundary', () => {
  expect(initialsOf('Paan')).toBe('P')
  expect(initialsOf('  Ada   Lovelace King ')).toBe('AL')
  expect(initialsOf('')).toBe('?')
  const ms = Date.parse('2026-11-18T20:00:00Z')
  setUtcOffsetHours(-5)
  expect(dayKey(ms)).toBe('2026-11-18')
  setUtcOffsetHours(99) // out of range: ignored
  expect(dayKey(ms)).toBe('2026-11-18')
  setUtcOffsetHours(8)
  expect(dayKey(ms)).toBe('2026-11-19')
})

test('formatting', () => {
  expect(fmtTokens(148_512_000)).toBe('148.5m')
  expect(fmtTokens(1_040_389_508)).toBe('1.04b')
  expect(fmtTokens(856_767)).toBe('856.8k')
  expect(fmtDur((23 * 60 + 33) * 1000)).toBe('23m 33s')
  expect(fmtDur(5405 * 1000)).toBe('1h 30m')
  expect(fmtUsd(454.756)).toBe('$454.76')
  expect(fmtUsd(1234)).toBe('$1.2k')
  expect(utf8len('aé€😀')).toBe(1 + 2 + 3 + 4)
})
