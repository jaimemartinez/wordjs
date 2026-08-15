/**
 * Editor engine flag (F3) — decides which block editor the admin mounts:
 *
 *   - "legacy" → PuckEditor (the current wrapper over the vendored @wordjs/puck fork).
 *     ABSOLUTE DEFAULT: without an explicit opt-in the admin behaves byte-identically to today.
 *   - "verso"  → VersoEditor (the new engine, frontend/src/components/verso/*).
 *
 * Resolution order (first explicit, valid value wins):
 *   1. URL query `?engine=verso|legacy` — per-visit override, never persisted.
 *   2. localStorage `wjs_editor_engine`  — per-browser opt-in.
 *   3. env `NEXT_PUBLIC_WORDJS_EDITOR_ENGINE` — per-deploy default (inlined at build time).
 *   4. "legacy".
 *
 * Anything that is not exactly "verso" or "legacy" at a given level is treated as ABSENT (falls
 * through to the next level) — a typo can never flip a site to an unintended engine.
 *
 * `resolveEditorEngine` is pure (inputs injected) so the whole matrix is unit-testable in node;
 * `resolveEditorEngineFromBrowser` is the thin browser binding the editor pages call after mount
 * (window/localStorage do not exist during SSR, and reading them post-mount avoids a hydration
 * mismatch between the server-rendered tree and the client's pick).
 */

export type EditorEngine = "verso" | "legacy";

/** localStorage key for the per-browser engine opt-in (contract with support docs/scripts). */
export const EDITOR_ENGINE_STORAGE_KEY = "wjs_editor_engine";

/** URL query parameter for the per-visit engine override. */
export const EDITOR_ENGINE_QUERY_PARAM = "engine";

function asEngine(value: string | null | undefined): EditorEngine | null {
    return value === "verso" || value === "legacy" ? value : null;
}

export interface ResolveEditorEngineInputs {
    /** Raw value of the `engine` query param (null/undefined when absent). */
    query?: string | null;
    /** Raw value of localStorage `wjs_editor_engine` (null/undefined when absent). */
    stored?: string | null;
    /** Raw value of NEXT_PUBLIC_WORDJS_EDITOR_ENGINE (null/undefined when absent). */
    env?: string | null;
}

/** Pure precedence: query > stored > env > "legacy". Invalid values fall through, never coerce. */
export function resolveEditorEngine(inputs: ResolveEditorEngineInputs = {}): EditorEngine {
    return asEngine(inputs.query) ?? asEngine(inputs.stored) ?? asEngine(inputs.env) ?? "legacy";
}

/**
 * Browser binding — call AFTER mount (client only). Each source is read defensively: a blocked
 * localStorage (Safari private mode / storage policies) must not take the editor down, it just
 * removes that level from the chain.
 */
export function resolveEditorEngineFromBrowser(): EditorEngine {
    let query: string | null = null;
    let stored: string | null = null;
    try {
        query = new URLSearchParams(window.location.search).get(EDITOR_ENGINE_QUERY_PARAM);
    } catch {
        /* no window / malformed URL — level absent */
    }
    try {
        stored = window.localStorage.getItem(EDITOR_ENGINE_STORAGE_KEY);
    } catch {
        /* storage blocked — level absent */
    }
    // NEXT_PUBLIC_* is inlined at build time; the literal member access is required for that.
    const env = process.env.NEXT_PUBLIC_WORDJS_EDITOR_ENGINE ?? null;
    return resolveEditorEngine({ query, stored, env });
}
