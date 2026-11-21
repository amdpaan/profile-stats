# profile-stats

A Claude Code mod that adds a **Profile** panel beside the chat: a dark profile card with your token usage, read from Claude Code's own local session logs (`~/.claude/projects/**/*.jsonl`). Nothing leaves your machine.

What the panel shows:

- **Stat tiles:** lifetime tokens, peak day, longest task, estimated cost, longest streak and current streak.
- **Token activity:** a GitHub-style heatmap of the last 12 months (Daily), weekly totals as bars (Weekly) and the running total as a line (Cumulative). Hover any square, bar or point for the date, tokens and cost.
- **Top projects:** your five projects by tokens, with each one's estimated cost.

## Install

At the prompt of a terminal session:

```
/plugin install profile-stats --marketplace amdpaan/profile-stats
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```bash
claude plugin install profile-stats --marketplace amdpaan/profile-stats
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `amdpaan/profile-stats`, then **Add plugin**.

The panel opens by itself when a session starts. Type `/profile` to reopen it after closing it. It draws in the desktop app; the terminal shows a one-line note instead.

## Settings

Set at install time, or later from the config menu:

| Setting | What it does | Default |
|---|---|---|
| Display name | The name at the top of the card | `Paan` |
| Avatar initials | One or two letters for the avatar; empty uses the name's initials | empty |
| UTC offset (hours) | Your time zone, used for days and streaks | `8` |

The offset is fixed, so in a zone with daylight saving, days near midnight can be an hour off for part of the year.

## How the numbers are counted

- **Tokens** are every token the API processed for a reply: input, output, cache writes and cache reads. One reply is written to the log as several records with the same message id, so each reply is counted once.
- **Peak tokens** is the day with the most tokens.
- **Longest task** is the longest single turn, from your prompt to Claude's last message in it. Any gap over 5 minutes with no activity (a stalled retry, a command left running in the background) is left out.
- **Est. cost** prices each reply at Anthropic's API list prices for its model: input, output and cache reads, with cache writes at 1.25× input (5-minute cache) or 2× input (1-hour cache), and fast mode at 2×. It is what the usage would cost on the API, not what a subscription plan bills. A reply from a model the mod has no price for is priced as Claude Opus 5.5, and the tile says so.
- **Streaks** count consecutive days with any usage. The current streak still counts while today has no usage yet.
- **Top projects** names each project after the folder its session ran in. A Claude worktree (`<repo>/.claude/worktrees/<name>`) counts under its repo, and two folders with the same name count as one project.
- A malformed log line is skipped.

## How it stays fast

Stats refresh when a session starts, when each reply finishes, when a session ends, and every 5 minutes. Each log file is read from where the last read stopped, so a refresh only parses what was appended. The first read goes through all your logs once.

Claude Code deletes old session logs after a while (`cleanupPeriodDays`, about 30 days by default). The mod keeps its own record of daily totals that only ever grows, so days whose logs are gone still count toward lifetime totals, streaks and the heatmap.

## Development

The parsing and statistics live in `hooks/stats.ts` (no I/O), the panel and log reading in `hooks/register.tsx`. Run the tests with:

```bash
claude plugin test .
```

## License

MIT
