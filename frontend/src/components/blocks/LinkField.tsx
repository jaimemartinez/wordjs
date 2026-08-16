"use client";

import React from "react";
import MSym from "../editor/MSym";
import { postsApi, Post } from "@/lib/api";

/**
 * LinkField — a link picker for editor fields (and the inline-text link popover): a free URL input
 * plus live search over the site's own pages/posts, so internal linking never requires remembering
 * slugs. Selecting a result stores the origin-relative `/slug` (portable across hosts, same policy
 * as media sourceUrl).
 */

type Result = { id: number; title: string; slug: string; type: string };

export function useContentSearch(query: string) {
    const [results, setResults] = React.useState<Result[]>([]);
    const [searching, setSearching] = React.useState(false);
    React.useEffect(() => {
        const q = query.trim();
        if (q.length < 2) {
            setResults([]);
            return;
        }
        let alive = true;
        setSearching(true);
        const t = setTimeout(() => {
            Promise.all([
                postsApi.listPaged({ type: "page", status: "publish", search: q, perPage: 5 }),
                postsApi.listPaged({ type: "post", status: "publish", search: q, perPage: 5 }),
            ])
                .then(([pages, posts]) => {
                    if (!alive) return;
                    const toResult = (p: Post, type: string): Result => ({
                        id: p.id,
                        title: p.title || "(sin título)",
                        slug: p.slug,
                        type,
                    });
                    setResults([
                        ...(pages.data || []).map((p) => toResult(p, "page")),
                        ...(posts.data || []).map((p) => toResult(p, "post")),
                    ]);
                })
                .catch(() => alive && setResults([]))
                .finally(() => alive && setSearching(false));
        }, 250);
        return () => {
            alive = false;
            clearTimeout(t);
        };
    }, [query]);
    return { results, searching };
}

export default function LinkField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label?: string }) {
    const [query, setQuery] = React.useState("");
    const [open, setOpen] = React.useState(false);
    const ref = React.useRef<HTMLDivElement>(null);
    const { results, searching } = useContentSearch(query);

    React.useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", onDoc, true);
        return () => document.removeEventListener("mousedown", onDoc, true);
    }, [open]);

    return (
        <div ref={ref} className="relative">
            {label && <label className="block text-[11px] font-medium text-[var(--ed-on-surface-variant)] mb-1">{label}</label>}
            <div className="flex gap-1.5">
                <input
                    className="flex-1 min-w-0 px-2 py-1.5 bg-white border border-[var(--ed-outline-variant)] rounded text-[13px] text-[var(--ed-on-surface)] focus:outline-none focus:border-[var(--ed-primary)] focus:ring-1 focus:ring-[var(--ed-primary)]"
                    value={value || ""}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder="https://… o /pagina"
                    spellCheck={false}
                />
                <button
                    type="button"
                    title="Buscar contenido del sitio"
                    onClick={() => setOpen((o) => !o)}
                    className={`px-2 rounded border inline-flex items-center transition ${open ? "bg-[var(--ed-primary)] border-[var(--ed-primary)] text-white shadow-sm" : "bg-white border-[var(--ed-outline-variant)] text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)]"}`}
                >
                    <MSym name="search" size={14} />
                </button>
            </div>
            {open && (
                <div className="absolute left-0 right-0 top-full mt-1.5 z-[5000] rounded-lg bg-white shadow-lg border border-[var(--ed-outline-variant)] p-1.5">
                    <input
                        autoFocus
                        className="w-full px-2 py-1.5 mb-1.5 bg-white border border-[var(--ed-outline-variant)] rounded text-[13px] text-[var(--ed-on-surface)] focus:outline-none focus:border-[var(--ed-primary)] focus:ring-1 focus:ring-[var(--ed-primary)]"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Buscar páginas y entradas…"
                    />
                    <div className="max-h-[220px] overflow-y-auto">
                        {searching && <div className="px-2 py-2 text-xs text-[var(--ed-outline)]">Buscando…</div>}
                        {!searching && query.trim().length >= 2 && results.length === 0 && (
                            <div className="px-2 py-2 text-xs text-[var(--ed-outline)]">Sin resultados.</div>
                        )}
                        {results.map((r) => (
                            <button
                                key={`${r.type}-${r.id}`}
                                type="button"
                                onClick={() => {
                                    onChange(`/${r.slug}`);
                                    setOpen(false);
                                    setQuery("");
                                }}
                                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-[var(--ed-surface-container)]"
                            >
                                <MSym name={r.type === "page" ? "description" : "newspaper"} size={14} className="text-[var(--ed-outline)] shrink-0" />
                                <span className="min-w-0 flex-1">
                                    <span className="block text-[13px] text-[var(--ed-on-surface)] truncate">{r.title}</span>
                                    <span
                                        className="block text-[11px] text-[var(--ed-outline)] truncate"
                                        style={{ fontFamily: "var(--ed-font-family-monospaced)" }}
                                    >/{r.slug}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
