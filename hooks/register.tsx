import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Mode, Stats } from '../types'
import {
  type Cache,
  type FileEntry,
  type History,
  MONTHS,
  initialsOf,
  setUtcOffsetHours,
  tzOffset,
  addDays,
  emptyHistory,
  fmtDay,
  fmtDur,
  fmtTokens,
  fmtUsd,
  fmtWeekday,
  freshEntry,
  mergeHistory,
  plural,
  summarize,
  take,
  utf8len,
} from './stats'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const PANE = 'profile'
// Set from the mod's options in `register` (plugin.json `userConfig`).
let NAME = 'Paan'
let INITIALS = 'P'
const REFRESH_MS = 5 * 60 * 1000
// The per-file cache is rebuilt from the logs whenever its key changes.
const CACHE_KEY = 'cache-v5'
const OLD_CACHE_KEYS = ['cache-v1', 'cache-v2', 'cache-v3', 'cache-v4']
// Daily totals that outlive the logs. Never deleted by a cache rebuild; bump
// it only if the counting itself changes (it would otherwise keep old values).
const HISTORY_KEY = 'history-v1'

const C = {
  card: '#0d1117',
  tile: '#161b22',
  border: '#30363d',
  text: '#e6edf3',
  dim: '#8b949e',
  accent: '#4aa3ff',
  // empty, then darker to brighter blue
  heat: ['#2a3444', '#0e3a66', '#145da0', '#2b84dd', '#5cb3ff'],
}

const stats = atom({ plugin: 'profile-stats', key: 'stats' } as const, null, {
  shape: 'stats-4',
})
const mode = atom({ plugin: 'profile-stats', key: 'mode' } as const, 'daily')

// ---------------------------------------------------------------------------
// Reading the logs
// ---------------------------------------------------------------------------

async function listLogs($: any, root: string): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = []
  const walk = async (dir: string, depth: number) => {
    if (depth > 4) return
    let entries: any[] = []
    try {
      entries = await $.fs.list(dir)
    } catch {
      return
    }
    for (const en of entries) {
      const p = `${dir}/${en.name}`
      if (en.kind === 'dir') await walk(p, depth + 1)
      else if (en.kind === 'file' && en.name.endsWith('.jsonl'))
        out.push({ path: p, size: en.size })
    }
  }
  await walk(root, 0)
  return out
}

// `$.fs.read` stops at 4 MiB and many logs are bigger, so the bytes appended
// since the last read are streamed through `tail` and `head` instead.
async function readNew($: any, path: string, f: FileEntry, size: number) {
  const len = size - f.off
  if (len <= 0) return
  const proc = $.process.spawn({
    argv: [
      '/bin/sh',
      '-c',
      'tail -c +"$1" "$2" | head -c "$3"',
      'sh',
      String(f.off + 1),
      path,
      String(len),
    ],
  })
  let buf = ''
  let consumed = 0
  for await (const piece of proc) {
    if (!piece || piece.stream !== 'stdout') continue
    buf += piece.text
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl)
      take(f, line)
      consumed += utf8len(line) + 1
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
    }
  }
  // A last line with no newline yet: count it only if it is complete JSON.
  if (buf) {
    let isWhole = false
    try {
      JSON.parse(buf)
      isWhole = true
    } catch {}
    if (isWhole) {
      take(f, buf)
      consumed += utf8len(buf)
    }
  }
  f.off += consumed
}

let running: Promise<void> | undefined

function refresh($: any): Promise<void> {
  if (running) return running
  running = (async () => {
    try {
      const home = await $.env.get('HOME')
      if (!home) return
      for (const k of OLD_CACHE_KEYS) await $.store.delete(k).catch(() => {})
      const cache: Cache = ((await $.store.get(CACHE_KEY)) as Cache) ?? { files: {} }
      if (!cache.files) cache.files = {}
      let history: History = ((await $.store.get(HISTORY_KEY)) as History) ?? emptyHistory()
      const logs = await listLogs($, `${home}/.claude/projects`)
      const todo = logs.filter(l => (cache.files[l.path]?.off ?? -1) !== l.size)
      if (todo.length > 0 && !(await read($, stats))) {
        const t0 = await $.clock.now()
        await update($, stats, () => summarize(history, t0, true))
      }
      let sinceSave = 0
      for (const l of todo) {
        let f = cache.files[l.path]
        if (!f || l.size < f.off) f = cache.files[l.path] = freshEntry() // new or rewritten
        try {
          await readNew($, l.path, f, l.size)
        } catch {
          // unreadable file: leave it for the next refresh
        }
        sinceSave += 1
        if (sinceSave >= 10) {
          sinceSave = 0
          await $.store.set(CACHE_KEY, cache)
        }
      }
      if (todo.length > 0) await $.store.set(CACHE_KEY, cache)
      history = mergeHistory(history, cache)
      await $.store.set(HISTORY_KEY, history)
      const now = await $.clock.now()
      await update($, stats, () => summarize(history, now, false))
    } finally {
      running = undefined
    }
  })()
  return running
}

// ---------------------------------------------------------------------------
// Heatmap (SVG)
// ---------------------------------------------------------------------------

type Cell = { key: string; v: number; usd: number; label: string }

// `width` is the drawing's width in CSS pixels, sized to the panel so the
// labels draw at their real font size instead of being shrunk to fit.
function heatmap(s: Stats | null, m: Mode, width: number): { source: string; height: number } | null {
  if (s === null) return null
  const WEEKS = 53
  const FONT = 10
  const LEFT = 26
  // A narrow panel draws the year as two stacked halves of 7 rows each, so
  // the squares stay a readable size; a wide one draws one strip.
  const BLOCKS = width < 640 ? 2 : 1
  const PER = Math.ceil(WEEKS / BLOCKS)
  const STEP = (width - LEFT) / PER
  const CELL = Math.max(2, STEP - Math.max(1, STEP * 0.18))
  const r = (n: number) => Math.round(n * 100) / 100
  const today = s.today
  const dow = new Date(today + 'T00:00:00Z').getUTCDay() // 0 = Sunday
  const start = addDays(today, -dow - (WEEKS - 1) * 7) // a Sunday

  // value per cell, and the words its hover shows
  const cols: Cell[][] = []
  let runTokens = 0
  let runUsd = 0
  for (const [k, v] of Object.entries(s.days)) if (k < start) runTokens += v
  for (const [k, v] of Object.entries(s.costDays)) if (k < start) runUsd += v
  for (let w = 0; w < WEEKS; w++) {
    const col: Cell[] = []
    for (let d = 0; d < 7; d++) {
      const key = addDays(start, w * 7 + d)
      if (key > today) break
      const v = s.days[key] ?? 0
      const usd = s.costDays[key] ?? 0
      runTokens += v
      runUsd += usd
      col.push(
        m === 'cumulative'
          ? { key, v: runTokens, usd: runUsd, label: `Through ${fmtWeekday(key)}` }
          : { key, v, usd, label: fmtWeekday(key) },
      )
    }
    if (m === 'weekly' && col.length > 0) {
      const total = col.reduce((a, c) => a + c.v, 0)
      const usd = col.reduce((a, c) => a + c.usd, 0)
      const label = `Week of ${fmtDay(col[0].key)}`
      for (const c of col) Object.assign(c, { v: total, usd, label })
    }
    cols.push(col)
  }
  if (m !== 'daily') return trend(cols, m, width)

  // levels: quartiles of the non-zero values
  const vals = cols.flat().map(c => c.v).filter(v => v > 0).sort((a, b) => a - b)
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] ?? 0
  const cuts = [q(0.25), q(0.5), q(0.75)]
  const level = (v: number) => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4)
  const tip = (c: Cell) =>
    c.v > 0 ? `${c.label} · ${fmtTokens(c.v)} tokens · ${fmtUsd(c.usd)}` : `${c.label} · no usage`

  const gridH = 7 * STEP
  const blockH = gridH + FONT + 6
  const GAP = 8
  const LEGEND_H = FONT + 8
  const height = Math.ceil(BLOCKS * blockH + (BLOCKS - 1) * GAP + LEGEND_H)
  const parts: string[] = [
    `<style>rect.c:hover{stroke:${C.text};stroke-width:1}</style>`,
  ]
  const minGap = Math.ceil((FONT * 2.2) / STEP)
  for (let b = 0; b < BLOCKS; b++) {
    const y0 = b * (blockH + GAP)
    const from = b * PER
    const to = Math.min(WEEKS, from + PER)
    for (let w = from; w < to; w++) {
      const x = LEFT + (w - from) * STEP
      cols[w].forEach((c, d) =>
        parts.push(
          `<rect class="c" x="${r(x)}" y="${r(y0 + d * STEP)}" width="${r(CELL)}" height="${r(CELL)}" rx="${r(Math.min(2, CELL / 4))}" fill="${C.heat[level(c.v)]}"><title>${tip(c)}</title></rect>`,
        ),
      )
    }
    // day labels, centred on their row
    for (const [d, t] of [
      [1, 'Mon'],
      [3, 'Wed'],
      [5, 'Fri'],
    ] as const)
      parts.push(
        `<text x="0" y="${r(y0 + d * STEP + CELL / 2)}" dominant-baseline="middle" font-size="${FONT}" fill="${C.dim}">${t}</text>`,
      )
    // month labels under each half, never closer than one label's width
    let lastLabel = -100
    for (let w = from; w < to; w++) {
      const first = cols[w][0]?.key
      if (!first) continue
      const prevFirst = w > from ? cols[w - 1][0]?.key : undefined
      const isNewMonth =
        prevFirst === undefined
          ? Number(first.slice(8, 10)) <= 7
          : first.slice(5, 7) !== prevFirst.slice(5, 7)
      const x = LEFT + (w - from) * STEP
      if (isNewMonth && w - lastLabel >= minGap && x + FONT * 2 <= width) {
        parts.push(
          `<text x="${r(x)}" y="${r(y0 + gridH + FONT + 2)}" font-size="${FONT}" fill="${C.dim}">${MONTHS[Number(first.slice(5, 7)) - 1]}</text>`,
        )
        lastLabel = w
      }
    }
  }
  {
    const sw = Math.max(8, Math.min(11, CELL))
    const ly = height - sw - 1
    const moreW = FONT * 2.4
    const x0 = width - moreW - 5 * (sw + 2) - 4
    parts.push(`<text x="${r(width)}" y="${r(ly + sw / 2)}" dominant-baseline="middle" text-anchor="end" font-size="${FONT}" fill="${C.dim}">More</text>`)
    C.heat.forEach((col, i) =>
      parts.push(`<rect x="${r(x0 + i * (sw + 2))}" y="${r(ly)}" width="${r(sw)}" height="${r(sw)}" rx="2" fill="${col}"/>`),
    )
    parts.push(`<text x="${r(x0 - 4)}" y="${r(ly + sw / 2)}" dominant-baseline="middle" text-anchor="end" font-size="${FONT}" fill="${C.dim}">Less</text>`)
  }
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="-apple-system, system-ui, sans-serif">${parts.join('')}</svg>`,
    height,
  }
}

const tipOf = (c: Cell) =>
  c.v > 0 ? `${c.label} · ${fmtTokens(c.v)} tokens · ${fmtUsd(c.usd)}` : `${c.label} · no usage`

// Weekly: one bar per week. Cumulative: the running total as a line over the
// days. Both on a token axis, with a hover on every bar or day.
function trend(cols: Cell[][], m: Mode, width: number): { source: string; height: number } {
  const FONT = 10
  const LEFT = 38
  const RIGHT = 4
  const TOP = 8
  const BOTTOM = FONT + 8
  const height = Math.max(150, Math.min(240, Math.round(width * 0.4)))
  const plotW = width - LEFT - RIGHT
  const plotH = height - TOP - BOTTOM
  const baseY = TOP + plotH
  const r = (n: number) => Math.round(n * 100) / 100

  const points: Cell[] =
    m === 'weekly' ? cols.map(col => col[0]).filter((c): c is Cell => c !== undefined) : cols.flat()
  const max = Math.max(1, ...points.map(p => p.v))
  const top = max * 1.08
  const y = (v: number) => baseY - (v / top) * plotH
  const slot = plotW / points.length

  const parts: string[] = [
    `<style>.h{fill:transparent}.h:hover{fill:rgba(255,255,255,0.07)}.b:hover .bar{fill:${C.heat[4]}}</style>`,
  ]
  // gridlines and axis labels at 0, half and the maximum
  for (const v of [0, max / 2, max]) {
    parts.push(
      `<line x1="${LEFT}" x2="${width - RIGHT}" y1="${r(y(v))}" y2="${r(y(v))}" stroke="${C.border}" stroke-width="1"${v === 0 ? '' : ' stroke-dasharray="2 3"'}/>`,
      `<text x="${LEFT - 6}" y="${r(y(v))}" dominant-baseline="middle" text-anchor="end" font-size="${FONT}" fill="${C.dim}">${v === 0 ? '0' : fmtTokens(v)}</text>`,
    )
  }

  if (m === 'weekly') {
    const bw = Math.max(1, slot * 0.72)
    points.forEach((p, i) => {
      const x = LEFT + i * slot
      const h = Math.max(p.v > 0 ? 1 : 0, baseY - y(p.v))
      parts.push(
        `<g class="b"><title>${tipOf(p)}</title><rect class="h" x="${r(x)}" y="${TOP}" width="${r(slot)}" height="${r(plotH)}"/>` +
          `<rect class="bar" x="${r(x + (slot - bw) / 2)}" y="${r(baseY - h)}" width="${r(bw)}" height="${r(h)}" rx="${r(Math.min(2, bw / 3))}" fill="${C.heat[3]}"/></g>`,
      )
    })
  } else {
    const xs = (i: number) => LEFT + (i + 0.5) * slot
    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${r(xs(i))},${r(y(p.v))}`).join('')
    parts.push(
      `<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.heat[3]}" stop-opacity="0.35"/><stop offset="1" stop-color="${C.heat[3]}" stop-opacity="0"/></linearGradient></defs>`,
      `<path d="${line}L${r(xs(points.length - 1))},${baseY}L${r(xs(0))},${baseY}Z" fill="url(#fade)"/>`,
      `<path d="${line}" fill="none" stroke="${C.heat[4]}" stroke-width="2" stroke-linejoin="round"/>`,
    )
    points.forEach((p, i) =>
      parts.push(
        `<rect class="h" x="${r(LEFT + i * slot)}" y="${TOP}" width="${r(slot)}" height="${r(plotH)}"><title>${tipOf(p)}</title></rect>`,
      ),
    )
  }

  // month labels where a month starts, never closer than one label's width
  let lastX = -100
  points.forEach((p, i) => {
    const prev = points[i - 1]
    const isNew = prev === undefined ? Number(p.key.slice(8, 10)) <= 7 : p.key.slice(5, 7) !== prev.key.slice(5, 7)
    const x = LEFT + i * slot
    if (isNew && x - lastX >= FONT * 2.6 && x + FONT * 2 <= width) {
      parts.push(
        `<text x="${r(x)}" y="${r(baseY + FONT + 4)}" font-size="${FONT}" fill="${C.dim}">${MONTHS[Number(p.key.slice(5, 7)) - 1]}</text>`,
      )
      lastX = x
    }
  })

  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="-apple-system, system-ui, sans-serif">${parts.join('')}</svg>`,
    height,
  }
}

const avatar = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b84dd"/><stop offset="1" stop-color="#7c5cff"/></linearGradient></defs><circle cx="16" cy="16" r="16" fill="url(#g)"/><text x="16" y="21" text-anchor="middle" font-size="14" font-weight="600" fill="#fff" font-family="-apple-system, system-ui, sans-serif">${INITIALS}</text></svg>`

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const name = typeof options.displayName === 'string' ? options.displayName.trim() : ''
  NAME = name || 'Me'
  const initials = typeof options.initials === 'string' ? options.initials.trim() : ''
  INITIALS = (initials || initialsOf(NAME)).slice(0, 2).toUpperCase()
  if (typeof options.utcOffsetHours === 'number') setUtcOffsetHours(options.utcOffsetHours)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'profile', description: 'Open the Profile stats panel' })
    void $.ui.open({ id: PANE, title: 'Profile' })
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void refresh($)
    return done
  })

  on('session.end', async ($, e, next) => {
    await refresh($).catch(() => {})
    return next(e)
  })

  on('command.run', { command: 'profile' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Profile' })
    void refresh($)
    return { text: 'Profile panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>The Profile panel draws in the desktop app.</Text>
    }
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    const s = await read($, stats)
    const m = await read($, mode)
    // The pane's width in cells, turned into the card's inner width in CSS
    // pixels. Fitted to the desktop app at two widths (49 cells drew a 339 px
    // card, 129 cells a 1143 px one), kept a little under both so it never
    // spills past the card.
    const cols = (e.props as { bodyColumns?: number }).bodyColumns ?? 48
    const heatWidth = Math.max(260, Math.min(1400, Math.round(cols * 9.5 - 130)))
    const heat = heatmap(s ?? null, m, heatWidth)

    const tile = (label: string, value: string, sub?: string) => (
      <Box
        flexDirection="column"
        flexGrow={1}
        minWidth={10}
        paddingX="sm"
        paddingY="xs"
        borderStyle="round"
        borderColor={C.border}
        backgroundColor={C.tile}
      >
        <Text size="caption" color={C.dim} wrap="truncate">{label}</Text>
        <Text weight="semibold" color={C.text} tabular>{value}</Text>
        {sub !== undefined && <Text size="caption" color={C.dim}>{sub}</Text>}
      </Box>
    )

    const card = (children: any) => (
      <Box
        flexDirection="column"
        gap="sm"
        padding="sm"
        borderStyle="round"
        borderColor={C.border}
        backgroundColor={C.card}
      >
        {children}
      </Box>
    )

    const toggle = (k: Mode, label: string) => (
      <Button
        key={`mode-${k}`}
        label={label}
        variant={m === k ? 'primary' : 'secondary'}
        dimColor={m !== k}
        onPress={() => update($, mode, () => k)}
      />
    )

    const costNote =
      s === null || s.unpriced === 0
        ? 'API list price'
        : `Estimate: ${plural(s.unpriced, 'reply')} from unpriced models`

    return (
      <Box flexDirection="column" gap="sm" padding="xs">
        {card(
          <Box flexDirection="row" alignItems="center" gap="sm">
            <Svg source={avatar()} alt={`${NAME} avatar`} width={32} height={32} />
            <Box flexDirection="column">
              <Text weight="semibold" color={C.text}>{NAME}</Text>
              <Text size="caption" color={C.dim}>
                {s === null || s.isParsing
                  ? 'Reading session logs…'
                  : `Updated ${new Date(s.updatedAt + tzOffset()).toISOString().slice(11, 16)}`}
              </Text>
            </Box>
          </Box>,
        )}

        {s !== null && (
          <Box flexDirection="row" flexWrap="wrap" gap="xs">
            {tile('Lifetime tokens', fmtTokens(s.lifetime))}
            {tile('Peak tokens', s.peak ? fmtTokens(s.peak.tokens) : '0', s.peak ? fmtDay(s.peak.day) : undefined)}
            {tile('Longest task', fmtDur(s.longestTurnMs))}
            {tile('Est. cost', fmtUsd(s.costUsd), costNote)}
            {tile('Longest streak', plural(s.longestStreak, 'day'))}
            {tile('Current streak', plural(s.currentStreak, 'day'))}
          </Box>
        )}

        {s !== null &&
          card(
            <Box flexDirection="column" gap="xs">
              <Box flexDirection="row" justifyContent="space-between" alignItems="center">
                <Text weight="semibold" color={C.text}>Token activity</Text>
                <Box flexDirection="row" gap="xs">
                  {toggle('daily', 'Daily')}
                  {toggle('weekly', 'Weekly')}
                  {toggle('cumulative', 'Cumulative')}
                </Box>
              </Box>
              {heat && (
                // An interactive SVG is drawn in a frame that does not size
                // itself to the markup, so its size is given here.
                <Svg
                  source={heat.source}
                  alt={
                    m === 'daily'
                      ? 'Daily token activity heatmap for the last 12 months'
                      : m === 'weekly'
                        ? 'Weekly token totals for the last 12 months, as bars'
                        : 'Running token total over the last 12 months, as a line'
                  }
                  width={heatWidth}
                  height={heat.height}
                  isInteractive
                />
              )}
            </Box>,
          )}

        {s !== null &&
          card(
            <Box flexDirection="column" gap={0}>
              <Text weight="semibold" color={C.text}>Top projects</Text>
              {s.topProjects.length === 0 && <Text size="footnote" color={C.dim}>No usage yet.</Text>}
              {s.topProjects.map(p => (
                <Box key={`project-${p.name}`} flexDirection="row" justifyContent="space-between" gap="sm">
                  <Text size="footnote" color={C.text} wrap="truncate">{p.name}</Text>
                  <Text size="footnote" color={C.dim} tabular>
                    {`${fmtTokens(p.tokens)} · ${fmtUsd(p.usd)}`}
                  </Text>
                </Box>
              ))}
            </Box>,
          )}
      </Box>
    )
  })
}
