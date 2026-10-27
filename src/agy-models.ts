/**
 * `agy models` — the installed CLI's model catalogue.
 *
 * `model: auto` needs to answer one question at spawn time: which Gemini Flash
 * slug is the newest, and at its deepest thinking level? The answer must not be
 * hard-coded: agy ships new model families on its own schedule, and a retired
 * slug makes every run fail with `invalid model selection`.
 *
 * The probe itself is slow — measured 10.7 s against agy 1.4.7 because it goes
 * to the network — so the result is cached next to the conversation registry
 * (`$DSH_HOME/agy-models.json`) and reused for a day. A stale cache beats a
 * blank badge: when the refresh fails the previous answer keeps working.
 *
 * Pure parsing lives here so the selection rule can be unit-tested without an
 * agy install.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** One row of `agy models`: a slug and its human-readable name. */
export interface ModelEntry {
  id: string
  name: string
}

/** What `model: auto` resolves to, plus the evidence behind it. */
export interface ModelCatalog {
  /** Epoch milliseconds of the probe that produced this catalogue. */
  fetchedAt: number
  /** Newest Gemini Flash at its highest thinking level; '' when none matched. */
  chosen: string
  models: ModelEntry[]
}

/** How long a catalogue is trusted before a background refresh. */
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * `gemini-<version>-flash-<depth>`, e.g. `gemini-3.8-flash-high`.
 * Version is dotted and compared numerically, so `4.0` beats `3.10`.
 */
const FLASH_ID = /^gemini-(\d+(?:\.\d+)*)-flash-(high|medium|low)$/i

/** Depth order inside one version: high is the deepest thinking level. */
const DEPTH_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 }

function compareVersion(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/**
 * Parse the tab-separated output of `agy models`.
 *
 * The first line may be `Fetching available models...`; it has no tab and is
 * skipped. Slugs are validated loosely so a future naming scheme still shows
 * up in the panel instead of being dropped by an over-tight regexp.
 */
export function parseModels(text: string): ModelEntry[] {
  const entries: ModelEntry[] = []
  const seen = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || !line.includes('\t')) continue
    const [rawId, ...rest] = line.split('\t')
    const id = (rawId ?? '').trim()
    const name = rest.join('\t').trim()
    if (id.length === 0 || name.length === 0) continue
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    entries.push({ id, name })
  }
  return entries
}

/**
 * Pick the newest Gemini Flash at its highest thinking level.
 *
 * "Newest" wins before "deepest": when agy ships Gemini 4.0 Flash, its `low`
 * is still the model the user asked for, and downgrading back to 3.8 because
 * it has a `high` would defeat the point. Within one version, high > medium >
 * low. When no `-flash-` slug is present the function returns '' — the caller
 * then omits `--model` and agy's own default applies, which is the safest
 * fallback across versions.
 */
export function pickDeepestFlash(models: readonly ModelEntry[]): string {
  let best: { id: string; version: string; rank: number } | undefined
  for (const model of models) {
    const match = FLASH_ID.exec(model.id)
    if (match === null) continue
    const version = match[1] ?? ''
    const rank = DEPTH_RANK[(match[2] ?? '').toLowerCase()] ?? 0
    if (
      best === undefined ||
      compareVersion(version, best.version) > 0 ||
      (compareVersion(version, best.version) === 0 && rank > best.rank)
    ) {
      best = { id: model.id, version, rank }
    }
  }
  return best?.id ?? ''
}

/** Read a cached catalogue; corrupt or missing files read as `undefined`. */
export function readModelCatalog(file: string): ModelCatalog | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ModelCatalog>
    if (typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.models)) return undefined
    const models: ModelEntry[] = []
    for (const entry of parsed.models) {
      if (entry !== null && typeof entry === 'object') {
        const id = (entry as ModelEntry).id
        const name = (entry as ModelEntry).name
        if (typeof id === 'string' && typeof name === 'string') models.push({ id, name })
      }
    }
    return {
      fetchedAt: parsed.fetchedAt,
      chosen: typeof parsed.chosen === 'string' ? parsed.chosen : '',
      models,
    }
  } catch {
    return undefined
  }
}

/** Atomically replace the cache: a half-written file must never be read back. */
export function writeModelCatalog(file: string, catalog: ModelCatalog): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}
