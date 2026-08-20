"use client";

/**
 * ReviewComments — internal editorial comment thread for a page/post (Figma/Webflow-style),
 * shown as a right-hand drawer in the editor chrome (M3 --ed-* tokens, Material Symbols subset).
 *
 * STORAGE: the whole thread lives in the post meta key `_wjs_review_comments` as an array of
 * { id, author, authorId?, text, createdAt, resolved? }. It is NEVER rendered on the public
 * site — public pages only read `_puck_data` / the post body, so the thread stays team-internal.
 *
 * WRITE PATH (merge semantics, verified):
 * - The backend meta write is a PER-KEY UPSERT, not a whole-map replacement:
 *   backend/src/routes/posts.ts L444-450 (PUT /posts/:id iterates Object.entries(meta) →
 *   Post.updateMeta per key) and L548-594 (POST /posts/:id/meta upserts ONE key).
 *   backend/src/models/Post.ts L686+ (updateMeta = single-row upsert, JSON.stringify objects).
 * - We use POST /posts/:id/meta with { key, value } so a comment write touches NOTHING but this
 *   key: no revision snapshot churn (PUT triggers saveRevision), no status/title side effects.
 *
 * RACE ANALYSIS (autosave + concurrent commenters):
 * - Editor autosave sends `meta: { _puck_data }` ONLY (frontend/src/app/admin/pages/[id]/page.tsx
 *   L212-217). Combined with the per-key upsert above, an autosave can NEVER clobber
 *   `_wjs_review_comments`, and a comment write can never clobber `_puck_data`. No cross-key race.
 * - The remaining race is SAME-KEY: two users mutating the thread concurrently do a
 *   read-modify-write on one meta row (last write wins). Mitigation: persist() re-reads the
 *   latest server-side list immediately before writing and applies the mutation on top of it,
 *   shrinking the lost-update window to the read→write round-trip; the drawer also reloads on
 *   open and offers a manual refresh. A truly conflict-free thread would need a server-side
 *   append endpoint — out of scope for a zero-backend-change feature.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { apiPost, postsApi } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useI18n } from "@/contexts/I18nContext";
import { useModal } from "@/contexts/ModalContext";
import { trStr } from "@/lib/editorI18n";
import MSym from "./MSym";

const META_KEY = "_wjs_review_comments";
const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export interface ReviewComment {
    id: string;
    author: string;
    authorId?: number;
    text: string;
    createdAt: string; // ISO
    resolved?: boolean;
}

interface ReviewCommentsProps {
    postId: number;
    isOpen: boolean;
    onClose: () => void;
}

function genId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `c_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Defensive parse: meta arrives JSON.parsed by the backend (Post.getAllMeta), but tolerate a raw
 *  string (older writers) and drop malformed entries instead of crashing the drawer. */
function parseComments(meta: Record<string, unknown> | undefined | null): ReviewComment[] {
    let raw: unknown = meta ? meta[META_KEY] : undefined;
    if (typeof raw === "string") {
        try { raw = JSON.parse(raw); } catch { return []; }
    }
    if (!Array.isArray(raw)) return [];
    return raw.filter(
        (c): c is ReviewComment =>
            !!c && typeof c === "object" &&
            typeof (c as ReviewComment).id === "string" &&
            typeof (c as ReviewComment).text === "string"
    );
}

/** Tiny relative-date formatter (es/en/pt via trStr templates); falls back to a locale date. */
function formatRelative(iso: string, tr: (s: string) => string): string {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return "";
    const mins = Math.floor((Date.now() - then) / 60000);
    if (mins < 1) return tr("Ahora mismo");
    if (mins < 60) return tr("hace {n} min").replace("{n}", String(mins));
    const hours = Math.floor(mins / 60);
    if (hours < 24) return tr("hace {n} h").replace("{n}", String(hours));
    const days = Math.floor(hours / 24);
    if (days < 7) return tr("hace {n} d").replace("{n}", String(days));
    return new Date(iso).toLocaleDateString();
}

export default function ReviewComments({ postId, isOpen, onClose }: ReviewCommentsProps) {
    const { user, can } = useAuth();
    const { language } = useI18n();
    const { confirm } = useModal();
    const tr = useCallback((s: string) => trStr(s, language), [language]);

    const [comments, setComments] = useState<ReviewComment[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [saving, setSaving] = useState(false);
    const [text, setText] = useState("");
    const [liveMsg, setLiveMsg] = useState("");
    const composerRef = useRef<HTMLTextAreaElement | null>(null);
    const drawerRef = useRef<HTMLElement | null>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);

    const load = useCallback(async () => {
        if (!postId) return;
        setLoading(true);
        setLoadError(false);
        try {
            const post = await postsApi.get(postId);
            setComments(parseComments(post.meta));
        } catch (err) {
            console.error("Failed to load review comments:", err);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, [postId]);

    // Reload on open + focus the composer (after the slide-in transition starts).
    useEffect(() => {
        if (!isOpen) return;
        load();
        const t = window.setTimeout(() => composerRef.current?.focus(), 120);
        return () => window.clearTimeout(t);
    }, [isOpen, load]);

    // Modal drawer semantics: Escape closes, Tab stays inside and focus returns to the trigger.
    useEffect(() => {
        if (!isOpen) return;
        previousFocusRef.current = document.activeElement as HTMLElement | null;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
                return;
            }
            if (e.key !== "Tab") return;
            const panel = drawerRef.current;
            if (!panel) return;
            const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
                .filter((el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0);
            if (!focusable.length) {
                e.preventDefault();
                panel.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
                e.preventDefault();
                first.focus();
            }
        };
        document.addEventListener("keydown", onKey, true);
        return () => {
            document.removeEventListener("keydown", onKey, true);
            previousFocusRef.current?.focus();
            previousFocusRef.current = null;
        };
    }, [isOpen, onClose]);

    /** Re-read the latest server-side thread, apply `mutate` on top of it, and write ONLY the
     *  `_wjs_review_comments` key via the single-key meta endpoint (see race note above). */
    const persist = useCallback(async (mutate: (latest: ReviewComment[]) => ReviewComment[]) => {
        const post = await postsApi.get(postId);
        const next = mutate(parseComments(post.meta));
        await apiPost(`/posts/${postId}/meta`, { key: META_KEY, value: next });
        return next;
    }, [postId]);

    const handleAdd = async () => {
        const trimmed = text.trim();
        if (!trimmed || !user || saving) return;
        const comment: ReviewComment = {
            id: genId(),
            author: user.displayName || user.username,
            authorId: user.id,
            text: trimmed,
            createdAt: new Date().toISOString(),
        };
        // Optimistic append; rolled back below if the write fails.
        setComments((prev) => [...(prev ?? []), comment]);
        setText("");
        setSaving(true);
        try {
            const next = await persist((latest) => [...latest.filter((c) => c.id !== comment.id), comment]);
            setComments(next);
            setLiveMsg(tr("Comentario añadido"));
        } catch (err) {
            console.error("Failed to add review comment:", err);
            setComments((prev) => (prev ?? []).filter((c) => c.id !== comment.id));
            setText(trimmed); // give the draft back so it isn't lost
            setLiveMsg(tr("No se pudo añadir el comentario"));
        } finally {
            setSaving(false);
        }
    };

    const handleToggleResolved = async (id: string) => {
        const prevList = comments ?? [];
        const target = prevList.find((c) => c.id === id);
        if (!target) return;
        const nextResolved = !target.resolved;
        setComments(prevList.map((c) => (c.id === id ? { ...c, resolved: nextResolved } : c)));
        try {
            const next = await persist((latest) =>
                latest.map((c) => (c.id === id ? { ...c, resolved: nextResolved } : c))
            );
            setComments(next);
        } catch (err) {
            console.error("Failed to update review comment:", err);
            setComments(prevList);
            setLiveMsg(tr("No se pudo actualizar el comentario"));
        }
    };

    const handleDelete = async (id: string) => {
        // ModalContext.confirm signature is (message, title?, isDanger?) — message FIRST.
        const ok = await confirm(
            tr("¿Eliminar este comentario? Esta acción no se puede deshacer."),
            tr("Eliminar comentario"),
            true
        );
        if (!ok) return;
        const prevList = comments ?? [];
        setComments(prevList.filter((c) => c.id !== id));
        try {
            const next = await persist((latest) => latest.filter((c) => c.id !== id));
            setComments(next);
            setLiveMsg(tr("Comentario eliminado"));
        } catch (err) {
            console.error("Failed to delete review comment:", err);
            setComments(prevList);
            setLiveMsg(tr("No se pudo eliminar el comentario"));
        }
    };

    const canDelete = (c: ReviewComment) =>
        (c.authorId != null && user != null && c.authorId === user.id) || can("moderate_comments");

    const openCount = (comments ?? []).filter((c) => !c.resolved).length;

    return (
        <>
        {isOpen && <div className="verso-overlay-scrim" aria-hidden="true" onMouseDown={onClose} />}
        <aside
            ref={drawerRef}
            tabIndex={-1}
            inert={!isOpen}
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-comments-title"
            aria-hidden={!isOpen}
            className={`verso-drawer fixed inset-y-0 right-0 w-full max-w-[420px] transform transition-transform duration-200 ease-out flex flex-col border-l border-[var(--ed-outline-variant)] outline-none ${isOpen ? "translate-x-0" : "translate-x-full"}`}
        >
            {/* Screen-reader announcements for add/delete/error outcomes. */}
            <div aria-live="polite" className="sr-only">{liveMsg}</div>

            {/* Header */}
            <div className="h-16 flex items-center justify-between px-4 border-b border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-low)] shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-[var(--ed-primary-fixed)] text-[var(--ed-primary)] flex items-center justify-center shrink-0">
                        <MSym name="forum" size={20} />
                    </div>
                    <div className="min-w-0">
                        <h3 id="review-comments-title" className="text-sm font-semibold text-[var(--ed-on-surface)] leading-tight truncate">
                            {tr("Comentarios de revisión")}
                        </h3>
                        <p className="text-[11px] text-[var(--ed-on-surface-variant)] leading-tight truncate">
                            {tr("Solo visible para el equipo")}
                        </p>
                    </div>
                    {openCount > 0 && (
                        <span className="ml-1 shrink-0 rounded-full bg-[var(--ed-secondary-container)] text-white text-[11px] font-medium px-2 py-0.5">
                            {tr("{n} abiertos").replace("{n}", String(openCount))}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        type="button"
                        onClick={load}
                        title={tr("Actualizar")}
                        aria-label={tr("Actualizar")}
                        className="verso-icon-button w-11 h-11 rounded-xl flex items-center justify-center text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)] transition-colors"
                    >
                        <MSym name="refresh" size={20} className={loading ? "animate-spin" : ""} />
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        title={tr("Cerrar")}
                        aria-label={tr("Cerrar")}
                        className="verso-icon-button w-11 h-11 rounded-xl flex items-center justify-center text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)] transition-colors"
                    >
                        <MSym name="close" size={20} />
                    </button>
                </div>
            </div>

            {/* Thread */}
            <div className="flex-1 overflow-y-auto px-4 py-4">
                {loading && comments === null ? (
                    <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--ed-on-surface-variant)]">
                        <MSym name="refresh" size={28} className="animate-spin" />
                        <span className="text-xs">{tr("Cargando comentarios…")}</span>
                    </div>
                ) : loadError ? (
                    <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--ed-on-surface-variant)]">
                        <span className="text-[var(--ed-error)]"><MSym name="info" size={28} /></span>
                        <span className="text-xs text-center">{tr("No se pudieron cargar los comentarios")}</span>
                        <button
                            type="button"
                            onClick={load}
                            className="px-4 h-9 rounded-full border border-[var(--ed-outline)] text-xs font-medium text-[var(--ed-on-surface)] hover:bg-[var(--ed-surface-container-high)] transition-colors"
                        >
                            {tr("Reintentar")}
                        </button>
                    </div>
                ) : (comments ?? []).length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--ed-on-surface-variant)] opacity-70">
                        <MSym name="forum" size={32} />
                        <span className="text-xs text-center">{tr("Sin comentarios. Escribe el primero.")}</span>
                    </div>
                ) : (
                    <ul className="space-y-3 list-none m-0 p-0">
                        {(comments ?? []).map((c) => (
                            <li
                                key={c.id}
                                className={`rounded-2xl border p-3 transition-colors ${c.resolved
                                    ? "border-transparent bg-[var(--ed-surface-container)] opacity-60"
                                    : "border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)]"}`}
                            >
                                <div className="flex items-start gap-2.5">
                                    <div className="w-7 h-7 rounded-full bg-[var(--ed-primary-container)] text-[var(--ed-on-primary-container)] flex items-center justify-center text-[11px] font-bold shrink-0 mt-0.5">
                                        {c.author ? c.author.charAt(0).toUpperCase() : <MSym name="person" size={14} />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-baseline gap-2 flex-wrap">
                                            <span className="text-[13px] font-semibold text-[var(--ed-on-surface)] truncate">
                                                {c.author}
                                            </span>
                                            <span className="text-[11px] text-[var(--ed-on-surface-variant)]">
                                                {formatRelative(c.createdAt, tr)}
                                            </span>
                                            {c.resolved && (
                                                <span className="text-[10px] font-medium text-[var(--ed-success)] uppercase tracking-wide">
                                                    {tr("Resuelto")}
                                                </span>
                                            )}
                                        </div>
                                        <p className={`text-[13px] leading-relaxed text-[var(--ed-on-surface)] whitespace-pre-wrap break-words mt-0.5 ${c.resolved ? "line-through" : ""}`}>
                                            {c.text}
                                        </p>
                                    </div>
                                    <div className="flex flex-col gap-1 shrink-0">
                                        <button
                                            type="button"
                                            onClick={() => handleToggleResolved(c.id)}
                                            title={c.resolved ? tr("Reabrir") : tr("Marcar como resuelto")}
                                            aria-label={c.resolved ? tr("Reabrir") : tr("Marcar como resuelto")}
                                            aria-pressed={!!c.resolved}
                                            className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors hover:bg-[var(--ed-surface-container-high)] ${c.resolved ? "text-[var(--ed-success)]" : "text-[var(--ed-on-surface-variant)]"}`}
                                        >
                                            <MSym name="check_circle" size={18} fill={!!c.resolved} />
                                        </button>
                                        {canDelete(c) && (
                                            <button
                                                type="button"
                                                onClick={() => handleDelete(c.id)}
                                                title={tr("Eliminar comentario")}
                                                aria-label={tr("Eliminar comentario")}
                                                className="w-8 h-8 rounded-full flex items-center justify-center text-[var(--ed-on-surface-variant)] hover:text-[var(--ed-error)] hover:bg-[var(--ed-error-container)] transition-colors"
                                            >
                                                <MSym name="delete" size={18} />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* Composer */}
            <div className="border-t border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-low)] p-3 shrink-0">
                <textarea
                    ref={composerRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                            e.preventDefault();
                            handleAdd();
                        }
                    }}
                    placeholder={tr("Escribe un comentario…")}
                    aria-label={tr("Escribe un comentario…")}
                    rows={3}
                    className="w-full resize-none rounded-xl border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)] text-[13px] text-[var(--ed-on-surface)] placeholder:text-[var(--ed-outline)] p-2.5 outline-none focus:border-[var(--ed-primary)] focus:ring-1 focus:ring-[var(--ed-primary)] transition-colors"
                />
                <div className="flex justify-end mt-2">
                    <button
                        type="button"
                        onClick={handleAdd}
                        disabled={!text.trim() || saving || !user}
                        className="inline-flex items-center gap-1.5 px-4 h-10 rounded-full bg-[var(--ed-primary)] text-white text-[13px] font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 active:scale-95 transition-all"
                    >
                        <MSym name="add_circle" size={18} />
                        {tr("Añadir comentario")}
                    </button>
                </div>
            </div>
        </aside>
        </>
    );
}
