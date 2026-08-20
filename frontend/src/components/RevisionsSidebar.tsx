"use client";

import React, { useEffect, useRef, useState } from "react";
import { revisionsApi, Revision, User, usersApi } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";
import MSym from "@/components/editor/MSym";
import { buildRevisionRestoreMessage } from "@/lib/revisionRestoreDescription";

interface RevisionsSidebarProps {
    postId: number;
    isOpen: boolean;
    onClose: () => void;
    onRestore: (revision: Revision) => void | Promise<void>;
}

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function formatRelativeDate(value: string, language: string): string {
    const then = new Date(value).getTime();
    if (!Number.isFinite(then)) return "";
    const deltaMs = then - Date.now();
    const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
    const minutes = Math.round(deltaMs / 60_000);
    if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
    const hours = Math.round(deltaMs / 3_600_000);
    if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
    const days = Math.round(deltaMs / 86_400_000);
    if (Math.abs(days) < 30) return rtf.format(days, "day");
    return new Date(value).toLocaleDateString(language, { dateStyle: "medium", timeStyle: undefined });
}

// ---------------------------------------------------------------------------
// Word-level diff (LCS) for the "View changes" panel. Inputs are HTML: we strip
// tags and diff words. Common prefix/suffix are trimmed first so the O(n·m) DP
// only runs on the changed middle; beyond a hard cap we degrade to a plain
// "old vs new" block instead of freezing the tab.
// ---------------------------------------------------------------------------
type DiffTok = { t: "same" | "add" | "del"; w: string };

function htmlToWords(html: string): string[] {
    return (html || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .split(/\s+/)
        .filter(Boolean);
}

function wordDiff(oldHtml: string, newHtml: string): DiffTok[] | null {
    const a = htmlToWords(oldHtml);
    const b = htmlToWords(newHtml);
    // Trim the common prefix/suffix (typical revisions change a small middle region).
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const ca = a.slice(start, endA), cb = b.slice(start, endB);
    if (ca.length * cb.length > 1_500_000) return null; // too different/large — caller degrades

    // LCS lengths over the changed middle.
    const m = ca.length, n = cb.length;
    const dp = new Int32Array((m + 1) * (n + 1));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i * (n + 1) + j] = ca[i] === cb[j]
                ? dp[(i + 1) * (n + 1) + j + 1] + 1
                : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
        }
    }
    const out: DiffTok[] = a.slice(0, start).map((w) => ({ t: "same" as const, w }));
    let i = 0, j = 0;
    while (i < m && j < n) {
        if (ca[i] === cb[j]) { out.push({ t: "same", w: ca[i] }); i++; j++; }
        else if (dp[(i + 1) * (n + 1) + j] >= dp[i * (n + 1) + j + 1]) { out.push({ t: "del", w: ca[i] }); i++; }
        else { out.push({ t: "add", w: cb[j] }); j++; }
    }
    while (i < m) { out.push({ t: "del", w: ca[i] }); i++; }
    while (j < n) { out.push({ t: "add", w: cb[j] }); j++; }
    for (const w of a.slice(endA)) out.push({ t: "same", w });
    return out;
}

function DiffText({ toks }: { toks: DiffTok[] }) {
    return (
        <p className="text-sm leading-relaxed text-[var(--ed-on-surface)] whitespace-pre-wrap">
            {toks.map((tok, i) => tok.t === "same"
                ? <span key={i}>{tok.w} </span>
                : tok.t === "add"
                    ? <ins key={i} className="bg-emerald-100 text-emerald-900 no-underline rounded px-0.5">{tok.w} </ins>
                    : <del key={i} className="bg-[var(--ed-error-container)] text-[var(--ed-on-error-container)] rounded px-0.5">{tok.w} </del>)}
        </p>
    );
}

export default function RevisionsSidebar({ postId, isOpen, onClose, onRestore }: RevisionsSidebarProps) {
    const [revisions, setRevisions] = useState<Revision[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [restoringId, setRestoringId] = useState<number | null>(null);
    const [users, setUsers] = useState<Record<number, User>>({});
    const [diffRev, setDiffRev] = useState<Revision | null>(null); // revision being compared with the latest
    const { confirm } = useModal();
    const { language } = useI18n();
    const tr = (value: string) => trStr(value, language);
    const panelRef = useRef<HTMLElement | null>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        if (isOpen && postId) {
            setDiffRev(null);
            loadRevisions();
        }
    // `loadRevisions` only reads postId; these dependencies intentionally describe the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, postId]);

    useEffect(() => {
        if (!isOpen) return;
        previousFocusRef.current = document.activeElement as HTMLElement | null;
        panelRef.current?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                return;
            }
            if (event.key !== "Tab") return;
            const panel = panelRef.current;
            if (!panel) return;
            const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
                .filter((el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0);
            if (!focusable.length) {
                event.preventDefault();
                panel.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("keydown", onKeyDown, true);
            previousFocusRef.current?.focus();
            previousFocusRef.current = null;
        };
    }, [isOpen, onClose]);

    const loadRevisions = async () => {
        setLoading(true);
        setLoadError(false);
        try {
            const data = await revisionsApi.list(postId);
            setRevisions(data.revisions);

            // Collect author IDs to fetch names. Read the current users via the
            // functional updater to avoid a stale closure, then fetch all missing
            // authors in parallel and merge once.
            const authorIds = Array.from(new Set(data.revisions.map(r => r.authorId)));
            setUsers(prev => {
                const missing = authorIds.filter(id => !prev[id]);
                if (missing.length > 0) {
                    Promise.all(
                        missing.map(async (id) => {
                            try {
                                return [id, await usersApi.get(id)] as const;
                            } catch (e) {
                                console.error(`Failed to fetch user ${id}`, e);
                                return null;
                            }
                        })
                    ).then(results => {
                        const fetched = results.filter((r): r is readonly [number, User] => r !== null);
                        if (fetched.length > 0) {
                            setUsers(curr => {
                                const next = { ...curr };
                                for (const [id, user] of fetched) next[id] = user;
                                return next;
                            });
                        }
                    });
                }
                return prev;
            });
        } catch (error) {
            console.error("Failed to load revisions:", error);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    };

    /**
     * WHAT THE DIALOG HAS TO SAY, and why it is this long.
     *
     * A restore is not "put the old text back". `restoreRevision` (backend/src/core/revisions.ts)
     * rolls back the post row AND the VERSIONED meta — `_puck_data`, `_wjs_template`, `_thumbnail_id`
     * and the four SEO keys — and the roll-back is exact in both directions: a key the live post has
     * but the snapshot does not is CLEARED. So restoring a version older than the featured image, the
     * theme template or the SEO fields deletes them. The dialog used to say only "your current
     * unsaved changes will be lost", which described none of that; a UI that understates what a
     * button destroys is the same defect class as one that claims to save something it drops.
     *
     * What it must NOT claim: that everything else goes too. The scoped delete is the other half of
     * that fix — the editorial review thread (`_wjs_review_comments`), plugin meta and the trash
     * status stay exactly as they are, and saying so removes the reason to be afraid of the button.
     *
     * `frontend/src/components/__tests__/revisionRestoreDisclosure.test.ts` reads the key list out of
     * the real backend module, so a key added to a revision fails the build until this text names it.
     * Argument order is (message, title, isDanger) — see ModalContext.
     */
    const handleRestoreClick = async (revision: Revision) => {
        const when = new Date(revision.modified).toLocaleString();
        const ok = await confirm(
            buildRevisionRestoreMessage(revision, when),
            "Restore this version?",
            true,
        );
        if (ok) {
            setRestoringId(revision.id);
            try {
                await onRestore(revision);
            } finally {
                setRestoringId(null);
            }
        }
    };

    return (
        <>
            {isOpen && <div className="verso-overlay-scrim" aria-hidden="true" onMouseDown={onClose} />}
            <aside
                ref={panelRef}
                tabIndex={-1}
                inert={!isOpen}
                aria-hidden={!isOpen}
                role="dialog"
                aria-modal="true"
                aria-labelledby="revisions-title"
                className={`verso-drawer fixed inset-y-0 right-0 w-full max-w-[420px] transform transition-transform duration-200 ease-out border-l border-[var(--ed-outline-variant)] flex flex-col outline-none ${isOpen ? "translate-x-0" : "translate-x-full"}`}
            >
                <div className="min-h-16 flex items-center justify-between gap-3 px-4 border-b border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-low)] shrink-0">
                    <div className="flex items-center gap-3 min-w-0">
                        <span className="w-10 h-10 bg-[var(--ed-primary-fixed)] text-[var(--ed-primary)] rounded-xl flex items-center justify-center shrink-0">
                            <MSym name="history" size={20} />
                        </span>
                        <div className="min-w-0">
                            <h3 id="revisions-title" className="text-sm font-semibold text-[var(--ed-on-surface)] truncate">{tr("Historial de revisiones")}</h3>
                            <p className="text-[11px] text-[var(--ed-on-surface-variant)]">{tr("Control de versiones")}</p>
                        </div>
                    </div>
                    <button type="button" onClick={onClose} aria-label={tr("Cerrar historial de revisiones")} className="verso-icon-button w-11 h-11 rounded-xl flex items-center justify-center text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)] transition-colors">
                        <MSym name="close" size={20} />
                    </button>
                </div>

                <div aria-live="polite" className="sr-only">
                    {loading ? tr("Cargando revisiones") : restoringId ? tr("Restaurando revisión") : loadError ? tr("No se pudieron cargar las revisiones") : ""}
                </div>

                {diffRev && (
                    <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-5 custom-scrollbar">
                        <button type="button" onClick={() => setDiffRev(null)} className="mb-5 min-h-11 inline-flex items-center gap-2 px-3 rounded-xl border border-[var(--ed-outline-variant)] text-xs font-semibold text-[var(--ed-on-surface)] hover:border-[var(--ed-primary)] hover:text-[var(--ed-primary)] transition-colors">
                            <MSym name="chevron_left" size={18} /> {tr("Todas las revisiones")}
                        </button>
                        <div className="mb-5">
                            <p className="text-[11px] text-[var(--ed-on-surface-variant)] font-semibold uppercase tracking-wider mb-2">{tr("Comparando")}</p>
                            <p className="text-xs text-[var(--ed-on-surface-variant)] leading-relaxed">
                                <del className="bg-[var(--ed-error-container)] text-[var(--ed-on-error-container)] rounded px-1 no-underline">{new Date(diffRev.modified).toLocaleString()}</del>
                                <span className="mx-2" aria-hidden="true">→</span>
                                <ins className="bg-emerald-100 text-emerald-900 rounded px-1 no-underline">{tr("Última")}</ins>
                            </p>
                        </div>
                        {(() => {
                            const latest = revisions[0];
                            if (!latest) return null;
                            const titleToks = diffRev.title !== latest.title ? wordDiff(diffRev.title, latest.title) : null;
                            const toks = wordDiff(diffRev.content, latest.content);
                            return (
                                <div className="space-y-5">
                                    {titleToks && (
                                        <section>
                                            <h4 className="text-[11px] text-[var(--ed-on-surface-variant)] font-semibold uppercase tracking-wider mb-2">{tr("Título")}</h4>
                                            <div className="p-4 rounded-xl border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-low)]"><DiffText toks={titleToks} /></div>
                                        </section>
                                    )}
                                    <section>
                                        <h4 className="text-[11px] text-[var(--ed-on-surface-variant)] font-semibold uppercase tracking-wider mb-2">{tr("Contenido")}</h4>
                                        <div className="p-4 rounded-xl border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-low)]">
                                            {toks
                                                ? (toks.some((t) => t.t !== "same")
                                                    ? <DiffText toks={toks} />
                                                    : <p className="text-sm text-[var(--ed-on-surface-variant)]">{tr("Sin cambios de texto; la diferencia puede estar en las imágenes o el diseño.")}</p>)
                                                : <p className="text-sm text-[var(--ed-on-surface-variant)]">{tr("Las versiones difieren demasiado para compararlas aquí; restáurala para inspeccionarla.")}</p>}
                                        </div>
                                    </section>
                                    <button type="button" disabled={restoringId !== null} onClick={() => handleRestoreClick(diffRev)} className="w-full min-h-11 px-4 rounded-xl border border-[var(--ed-outline-variant)] text-sm font-semibold text-[var(--ed-on-surface)] hover:border-[var(--ed-primary)] hover:text-[var(--ed-primary)] disabled:opacity-50 transition-colors inline-flex items-center justify-center gap-2">
                                        <MSym name={restoringId === diffRev.id ? "sync" : "history"} size={18} className={restoringId === diffRev.id ? "animate-spin" : ""} /> {tr("Restaurar esta versión")}
                                    </button>
                                </div>
                            );
                        })()}
                    </div>
                )}

                <div className={`flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 custom-scrollbar ${diffRev ? "hidden" : ""}`}>
                    {loading ? (
                        <div role="status" className="grid gap-3" aria-label={tr("Cargando revisiones")}>
                            {Array.from({ length: 4 }, (_, i) => <div key={i} className="h-32 rounded-2xl bg-[var(--ed-surface-container)] animate-pulse" aria-hidden="true" />)}
                        </div>
                    ) : loadError ? (
                        <div role="alert" className="h-full min-h-64 flex flex-col items-center justify-center gap-3 text-center">
                            <span className="w-12 h-12 rounded-2xl bg-[var(--ed-error-container)] text-[var(--ed-on-error-container)] flex items-center justify-center"><MSym name="info" size={24} /></span>
                            <p className="text-sm font-semibold text-[var(--ed-on-surface)]">{tr("No se pudieron cargar las revisiones")}</p>
                            <p className="max-w-xs text-xs text-[var(--ed-on-surface-variant)]">{tr("Comprueba la conexión y vuelve a intentarlo.")}</p>
                            <button type="button" onClick={loadRevisions} className="min-h-11 px-4 rounded-xl border border-[var(--ed-outline-variant)] text-sm font-semibold hover:border-[var(--ed-primary)] hover:text-[var(--ed-primary)] transition-colors">{tr("Reintentar")}</button>
                        </div>
                    ) : revisions.length === 0 ? (
                        <div className="h-full min-h-64 flex flex-col items-center justify-center gap-3 text-center">
                            <span className="w-12 h-12 rounded-2xl bg-[var(--ed-surface-container)] text-[var(--ed-on-surface-variant)] flex items-center justify-center"><MSym name="history" size={24} /></span>
                            <p className="text-sm font-semibold text-[var(--ed-on-surface)]">{tr("Aún no hay revisiones")}</p>
                            <p className="max-w-xs text-xs text-[var(--ed-on-surface-variant)]">{tr("Guarda la página para crear su primera versión recuperable.")}</p>
                        </div>
                    ) : (
                        <ol className="space-y-3 list-none m-0 p-0">
                            {revisions.map((rev, index) => (
                                <li key={rev.id || index} className={`relative p-4 rounded-2xl border ${index === 0 ? "bg-[var(--ed-primary-fixed)] border-[var(--ed-primary-container)]" : "bg-[var(--ed-surface-container-lowest)] border-[var(--ed-outline-variant)] hover:border-[var(--ed-primary)]"} transition-colors`}>
                                    {index === 0 && <span className="absolute top-3 right-3 rounded-full bg-[var(--ed-primary-solid)] text-white text-[10px] font-semibold px-2 py-1">{tr("Última")}</span>}
                                    <div className="pr-14">
                                        <div className="flex items-center gap-2 mb-2">
                                            <span className="w-8 h-8 rounded-full bg-[var(--ed-surface-container-lowest)] border border-[var(--ed-outline-variant)] flex items-center justify-center text-[11px] text-[var(--ed-on-surface)] font-semibold">
                                                {users[rev.authorId]?.displayName?.charAt(0) || <MSym name="person" size={16} />}
                                            </span>
                                            <span className="text-sm font-semibold text-[var(--ed-on-surface)] truncate">{users[rev.authorId]?.displayName || `${tr("Autor")} #${rev.authorId}`}</span>
                                        </div>
                                        <p className="text-xs text-[var(--ed-on-surface-variant)]">{formatRelativeDate(rev.modified, language)}</p>
                                        <p className="text-[11px] text-[var(--ed-outline)] mt-1 tabular-nums" style={{ fontFamily: "var(--ed-font-family-monospaced)" }}>{new Date(rev.modified).toLocaleString()}</p>
                                    </div>
                                    <div className="flex flex-wrap gap-2 mt-4">
                                        <button type="button" disabled={restoringId !== null || rev.restore?.compatible === false} title={rev.restore?.compatible === false ? tr("Esta revisión usa un formato no compatible") : undefined} onClick={() => handleRestoreClick(rev)} className="min-h-10 flex-1 px-3 rounded-xl border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)] text-xs font-semibold text-[var(--ed-on-surface)] hover:border-[var(--ed-primary)] hover:text-[var(--ed-primary)] disabled:opacity-50 transition-colors inline-flex items-center justify-center gap-1.5">
                                            <MSym name={restoringId === rev.id ? "sync" : "history"} size={16} className={restoringId === rev.id ? "animate-spin" : ""} /> {tr("Restaurar")}
                                        </button>
                                        {index > 0 && (
                                            <button type="button" onClick={() => setDiffRev(rev)} className="min-h-10 flex-1 px-3 rounded-xl border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-lowest)] text-xs font-semibold text-[var(--ed-on-surface)] hover:border-[var(--ed-primary)] hover:text-[var(--ed-primary)] transition-colors inline-flex items-center justify-center gap-1.5">
                                                <MSym name="content_copy" size={16} /> {tr("Cambios")}
                                            </button>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ol>
                    )}
                </div>

                <div className="px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))] border-t border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-low)]">
                    <p className="text-[11px] text-[var(--ed-on-surface-variant)] text-center leading-relaxed">{tr("Restaurar reemplaza el contenido actual y conserva una revisión de su estado presente.")}</p>
                </div>
            </aside>
        </>
    );
}
