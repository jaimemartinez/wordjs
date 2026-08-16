/**
 * Pure decision logic for the block editor wrapper's background autosave.
 *
 * Extracted verbatim from the autosave effect/handleManualSave of the retired legacy wrapper so the
 * contract can be exercised by real behavior tests instead of source-text pins. The live consumers are
 * components/verso/editor/VersoEditor.tsx and components/verso/editor/saveFlow.ts, which import these
 * functions rather than re-implementing the decisions inline. See f0-audit-core.md "Contratos duros"
 * (wrapper-integration): autosave fires 8s after the page first becomes dirty with a 30s floor between
 * runs, only while status==='draft' (a published record must never go live in the background), and a
 * save whose result is exactly `false` must not be treated as success.
 */

/** Floor: an autosave never fires sooner than this many ms after the page first becomes dirty. */
export const AUTOSAVE_DEBOUNCE_FLOOR_MS = 8000;
/** Floor: two autosave runs are never closer together than this many ms. */
export const AUTOSAVE_REPEAT_FLOOR_MS = 30000;

/**
 * Should the autosave effect arm a timer at all? Mirrors the wrapper's guard exactly:
 * `status !== "draft" || !onSave || !hasChanges || saving` (inverted to a positive predicate).
 * `hasOnSave` is passed as a plain boolean (not the callback itself) so this stays a pure, easily
 * fuzzed function — the caller still needs its own `if (!onSave) return` for TypeScript narrowing
 * before it actually invokes onSave.
 */
export function shouldRunAutosave(opts: {
    status: string;
    hasOnSave: boolean;
    hasChanges: boolean;
    saving: boolean;
}): boolean {
    return opts.status === "draft" && opts.hasOnSave && opts.hasChanges && !opts.saving;
}

/**
 * How long to wait before the next autosave fires, given `now` and the timestamp of the last
 * autosave run (0 if none has ever run). Always at least AUTOSAVE_DEBOUNCE_FLOOR_MS, and enforces
 * AUTOSAVE_REPEAT_FLOOR_MS between runs when the last run was recent.
 */
export function computeAutosaveWaitMs(now: number, lastAutosaveAt: number): number {
    return Math.max(AUTOSAVE_DEBOUNCE_FLOOR_MS, AUTOSAVE_REPEAT_FLOOR_MS - (now - lastAutosaveAt));
}

/**
 * The exact options object the wrapper passes to `onSave` for a background save — the backend
 * (routes/posts.ts) uses this literal `autosave: true` flag to skip the revision snapshot. Returns a
 * fresh object each call (matches the original `{ autosave: true }` literal at the call site; callers
 * must not rely on referential identity across calls).
 */
export function buildAutosaveSaveOptions(): { autosave: true } {
    return { autosave: true };
}

/**
 * Did a save (autosave or manual) actually succeed? The onSave contract (f0-audit-core.md) says
 * `false` means blocked/failed and the caller must NOT stamp the UI as saved; anything else
 * (true/undefined/void) means success.
 */
export function didSaveSucceed(result: unknown): boolean {
    return result !== false;
}
