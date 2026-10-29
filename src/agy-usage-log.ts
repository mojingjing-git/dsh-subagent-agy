/**
 * Token totals from every agy conversation on this machine.
 *
 * Sources — both are plain JSONL, no SQLite:
 *
 *   ~/.gemini/antigravity-cli/brain/<conv>/.system_generated/logs/transcript.jsonl
 *   ~/.gemini/antigravity/brain/<conv>/.system_generated/logs/transcript.jsonl
 *
 * The second one is the Antigravity IDE's store: those conversations never show
 * up in this plugin's panel, but they spend the same account quota, so leaving
 * them out would under-count by roughly 4x on a normal day.
 *
 * Each MODEL step carries `created_at` plus `input_tokens` / `output_tokens` /
 * `cache_read_tokens`. Those are **increments for that step**, not running
 * totals: a conversation's input count climbs, then drops to a few thousand
 * with the rest recorded as cache reads once the prefix is cached. Summing is
 * therefore correct — and `cache_read_tokens` has to be summed too, because it
 * is the bulk of the volume.
 *
 * Files are cached by (mtime, size) so a refresh only re-reads what agy wrote
 * since the last look; a cold scan of ~150 transcripts takes a few hundred ms.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One token-bearing step. `t` is a Unix epoch in milliseconds. */
export interface TokenRow {
  t: number
  input: number
  output: number
  cacheRead: number
}

export interface TokenBucket {
  input: number
  output: number
  cacheRead: number
  /** input + output + cacheRead — what the account actually moved. */
  total: number
  steps: number
}

export interface TokenDay extends TokenBucket {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string
}

export interface TokenUsageReport {
  scannedAt: number
  /** Rolling window length in days (the last N local days, including today). */
  windowDays: number
  days: TokenDay[]
  window: TokenBucket
  allTime: TokenBucket & { from: string | null; to: string | null; conversations: number }
  /** Transcript files read, and how many were reused from the cache. */
  files: number
  reused: number
  error?: string
}

interface FileCacheEntry {
  mtime: number
  size: number
  rows: [number, number, number, number][]
}

interface CacheFile {
  version: number
  files: Record<string, FileCacheEntry>
}

const CACHE_VERSION = 1

/** Local calendar day of an epoch, as `YYYY-MM-DD`. */
export function dayKeyOf(ms: number): string {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

const emptyBucket = (): TokenBucket => ({ input: 0, output: 0, cacheRead: 0, total: 0, steps: 0 })

function addRow(bucket: TokenBucket, row: TokenRow): void {
  bucket.input += row.input
  bucket.output += row.output
  bucket.cacheRead += row.cacheRead
  bucket.total += row.input + row.output + row.cacheRead
  bucket.steps += 1
}

/**
 * Aggregate rows into `windowDays` zero-filled local days ending today, plus an
 * all-time total. Pure: no I/O, so the window arithmetic is testable.
 */
export function summarize(
  rows: readonly TokenRow[],
  now: number,
  windowDays: number,
): Pick<TokenUsageReport, 'days' | 'window' | 'allTime' | 'windowDays'> {
  const span = Math.max(1, Math.floor(windowDays))
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const firstWindowMs = today.getTime() - (span - 1) * 86_400_000
  // Calendar days, not 24h slices: DST shifts a local midnight by an hour and a
  // fixed-millisecond subtraction would then produce a 23- or 25-hour "day".
  const windowKeys: string[] = []
  for (let index = 0; index < span; index += 1) {
    const date = new Date(firstWindowMs)
    date.setDate(date.getDate() + index)
    windowKeys.push(dayKeyOf(date.getTime()))
  }
  const byDay = new Map<string, TokenDay>()
  for (const day of windowKeys) byDay.set(day, { day, ...emptyBucket() })
  const allTime = { ...emptyBucket(), from: null as string | null, to: null as string | null, conversations: 0 }
  const window = emptyBucket()
  for (const row of rows) {
    const day = dayKeyOf(row.t)
    const bucket = byDay.get(day)
    if (bucket !== undefined) {
      addRow(bucket, row)
      addRow(window, row)
    }
    addRow(allTime, row)
    if (allTime.from === null || day < allTime.from) allTime.from = day
    if (allTime.to === null || day > allTime.to) allTime.to = day
  }
  return {
    windowDays: span,
    days: windowKeys.map((day) => byDay.get(day) as TokenDay),
    window,
    allTime,
  }
}

/** Parse one transcript file into token rows. Unparsable lines are skipped. */
export function parseTranscript(text: string): TokenRow[] {
  const rows: TokenRow[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0 || line[0] !== '{') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const record = parsed as Record<string, unknown>
    const created = typeof record.created_at === 'string' ? Date.parse(record.created_at) : Number.NaN
    if (Number.isNaN(created)) continue
    const input = typeof record.input_tokens === 'number' ? record.input_tokens : 0
    const output = typeof record.output_tokens === 'number' ? record.output_tokens : 0
    const cacheRead = typeof record.cache_read_tokens === 'number' ? record.cache_read_tokens : 0
    if (input === 0 && output === 0 && cacheRead === 0) continue
    rows.push({ t: created, input, output, cacheRead })
  }
  return rows
}

function readCache(path: string): CacheFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CacheFile
    if (parsed.version === CACHE_VERSION && parsed.files !== null && typeof parsed.files === 'object') return parsed
  } catch {
    // A missing or corrupt cache just means a cold scan.
  }
  return { version: CACHE_VERSION, files: {} }
}

function writeCache(path: string, cache: CacheFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(cache), 'utf8')
    renameSync(temp, path)
  } catch {
    // The cache is an optimisation; failing to persist it must not fail a read.
  }
}

/** Every `transcript.jsonl` under `<root>/<conversation>/.system_generated/logs/`. */
function transcriptPaths(root: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const paths: string[] = []
  for (const entry of entries) {
    const path = join(root, entry, '.system_generated', 'logs', 'transcript.jsonl')
    if (existsSync(path)) paths.push(path)
  }
  return paths
}

export interface TokenUsageOptions {
  /** Absolute `brain` directories to scan. */
  roots: readonly string[]
  /** Where the (mtime, size) index lives; the file is optional. */
  cachePath: string
  now?: number
  windowDays?: number
}

/** Scan both stores and return the rolling window plus the local total. */
export function readTokenUsage(options: TokenUsageOptions): TokenUsageReport {
  const now = options.now ?? Date.now()
  const windowDays = options.windowDays ?? 7
  const cache = readCache(options.cachePath)
  const files: Record<string, FileCacheEntry> = {}
  const rows: TokenRow[] = []
  let reused = 0
  let conversations = 0

  for (const root of options.roots) {
    for (const path of transcriptPaths(root)) {
      conversations += 1
      let mtime = 0
      let size = 0
      try {
        const stat = statSync(path)
        mtime = stat.mtimeMs
        size = stat.size
      } catch {
        continue
      }
      const cached = cache.files[path]
      if (cached !== undefined && cached.mtime === mtime && cached.size === size) {
        reused += 1
        files[path] = cached
        for (const [t, input, output, cacheRead] of cached.rows) rows.push({ t, input, output, cacheRead })
        continue
      }
      let text = ''
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      const parsed = parseTranscript(text)
      const entry: FileCacheEntry = {
        mtime,
        size,
        rows: parsed.map((row) => [row.t, row.input, row.output, row.cacheRead]),
      }
      files[path] = entry
      for (const row of parsed) rows.push(row)
    }
  }

  if (reused !== Object.keys(files).length) writeCache(options.cachePath, { version: CACHE_VERSION, files })

  const summary = summarize(rows, now, windowDays)
  return {
    scannedAt: now,
    windowDays: summary.windowDays,
    days: summary.days,
    window: summary.window,
    allTime: { ...summary.allTime, conversations },
    files: conversations,
    reused,
  }
}
