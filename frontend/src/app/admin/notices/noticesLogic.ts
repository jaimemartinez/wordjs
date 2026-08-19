/**
 * Presentation logic for /admin/notices — kept out of the component so it can be unit-tested and so
 * the rules below live in ONE place instead of inline in JSX.
 *
 * Source of the data: GET /api/v1/notices, which reads the autoloaded `admin_notices` option. Its
 * only in-tree writer is the plugin CrashGuard (backend/src/core/plugins.ts), which appends a notice
 * when a plugin is auto-disabled after three consecutive boot crashes.
 */

export interface AdminNotice {
    id: string;
    type: string;
    message: string;
    dismissible: boolean;
    timestamp: number | null;
}

export type NoticeTone = "danger" | "warn" | "info" | "neutral";

/**
 * The stored `type` is a free string in the option blob, so it may NEVER pick classes or structure
 * directly. Closed map, unknown → neutral — same discipline the audit screen applies to its tones.
 */
const TONE_BY_TYPE: Record<string, NoticeTone> = {
    error: "danger",
    critical: "danger",
    warning: "warn",
    warn: "warn",
    info: "info",
    success: "info",
};

export function noticeTone(type: unknown): NoticeTone {
    if (typeof type !== "string") return "neutral";
    return TONE_BY_TYPE[type.toLowerCase()] || "neutral";
}

const ENTITIES: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
};

/**
 * Render a notice as TEXT, never as markup.
 *
 * CrashGuard writes its message with HTML in it (`<b>Critical Error:</b> … <strong>{slug}</strong>`),
 * and that slug is a directory name off disk. Feeding any of it to dangerouslySetInnerHTML would turn
 * a screen only administrators can open into a stored-XSS sink in the highest-privilege context in
 * the product — the exact hazard backend/src/core/plugin-api.ts already names when it puts
 * 'admin_notices' off-limits to plugins. That backend guard blocks one writer; this one makes the
 * SURFACE safe regardless of who wrote the row, which is the half that survives a new writer being
 * added later.
 *
 * So: drop the tags, keep the words. `<br>` and block ends become spaces so sentences don't fuse.
 */
export function noticeText(message: unknown): string {
    if (typeof message !== "string") return "";
    let out = message
        .replace(/<\s*br\s*\/?\s*>/gi, " ")
        .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, " ")
        .replace(/<[^>]*>/g, "");
    // Decode only the handful of named entities a message may legitimately carry. Deliberately NOT a
    // general decoder: this output goes into a text node, so anything left encoded is merely ugly,
    // while an over-eager decoder is how "&lt;script&gt;" becomes markup again somewhere downstream.
    out = out.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
    return out.replace(/\s+/g, " ").trim();
}

/**
 * The option is a JSON blob written by a crash-recovery path that must never throw, so this screen
 * treats every field as untrusted shape: anything without a usable `id` is dropped (there would be no
 * way to dismiss it, and it would collide as a React key), and the rest is coerced.
 */
export function normalizeNotices(raw: unknown): AdminNotice[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: AdminNotice[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        const id = typeof e.id === "string" ? e.id : typeof e.id === "number" ? String(e.id) : "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
            id,
            type: typeof e.type === "string" ? e.type : "info",
            message: noticeText(e.message),
            // Absent means dismissible: DELETE /notices/:id works on every row regardless, and hiding
            // the button on a malformed row would make it unprunable from here — the original bug.
            dismissible: e.dismissible !== false,
            timestamp: typeof e.timestamp === "number" && Number.isFinite(e.timestamp) ? e.timestamp : null,
        });
    }
    // Newest first. Rows without a timestamp keep their stored order at the end, because the option is
    // append-ordered and inventing a date for them would be a lie the operator cannot check.
    return out.sort((a, b) => (b.timestamp ?? -Infinity) - (a.timestamp ?? -Infinity) || 0);
}

export function formatNoticeDate(timestamp: number | null, locale?: string): string {
    if (timestamp === null) return "";
    const d = new Date(timestamp);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(locale, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}
