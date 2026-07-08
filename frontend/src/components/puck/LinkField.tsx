"use client";

import React from "react";
import { postsApi, Post } from "@/lib/api";

/**
 * LinkField — a link picker for Puck fields (and the inline-text link popover): a free URL input
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
            {label && <label className="block text-xs text-gray-500 mb-1">{label}</label>}
            <div className="flex gap-1.5">
                <input
                    className="flex-1 min-w-0 p-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-editor-primary/30 focus:border-editor-primary"
                    value={value || ""}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder="https://… o /pagina"
                    spellCheck={false}
                />
                <button
                    type="button"
                    title="Buscar contenido del sitio"
                    onClick={() => setOpen((o) => !o)}
                    className={`px-2.5 rounded-lg border text-sm transition ${open ? "bg-editor-primary/10 border-editor-primary text-editor-primary" : "bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100"}`}
                >
                    <i className="fa-solid fa-magnifying-glass text-xs"></i>
                </button>
            </div>
            {open && (
                <div className="absolute left-0 right-0 top-full mt-1.5 z-[5000] rounded-xl bg-white shadow-2xl border border-gray-200 p-2">
                    <input
                        autoFocus
                        className="w-full p-2 mb-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-editor-primary/30"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Buscar páginas y entradas…"
                    />
                    <div className="max-h-[220px] overflow-y-auto">
                        {searching && <div className="px-2 py-2 text-xs text-gray-400">Buscando…</div>}
                        {!searching && query.trim().length >= 2 && results.length === 0 && (
                            <div className="px-2 py-2 text-xs text-gray-400">Sin resultados.</div>
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
                                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-gray-50"
                            >
                                <i className={`fa-solid ${r.type === "page" ? "fa-file" : "fa-newspaper"} text-[11px] text-gray-400 shrink-0`}></i>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-sm text-gray-800 truncate">{r.title}</span>
                                    <span className="block text-[11px] text-gray-400 truncate">/{r.slug}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
