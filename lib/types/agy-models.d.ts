/** One row of `agy models`: a slug and its human-readable name. */
export interface ModelEntry {
    id: string;
    name: string;
}
/** What `model: auto` resolves to, plus the evidence behind it. */
export interface ModelCatalog {
    /** Epoch milliseconds of the probe that produced this catalogue. */
    fetchedAt: number;
    /** Newest Gemini Flash at its highest thinking level; '' when none matched. */
    chosen: string;
    models: ModelEntry[];
}
/** How long a catalogue is trusted before a background refresh. */
export declare const MODEL_CACHE_TTL_MS: number;
/**
 * Parse the tab-separated output of `agy models`.
 *
 * The first line may be `Fetching available models...`; it has no tab and is
 * skipped. Slugs are validated loosely so a future naming scheme still shows
 * up in the panel instead of being dropped by an over-tight regexp.
 */
export declare function parseModels(text: string): ModelEntry[];
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
export declare function pickDeepestFlash(models: readonly ModelEntry[]): string;
/** Read a cached catalogue; corrupt or missing files read as `undefined`. */
export declare function readModelCatalog(file: string): ModelCatalog | undefined;
/** Atomically replace the cache: a half-written file must never be read back. */
export declare function writeModelCatalog(file: string, catalog: ModelCatalog): void;
