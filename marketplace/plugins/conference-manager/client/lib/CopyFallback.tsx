// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * When a copy could not be done (2.36.8, lib/clipboard): the text in a read-only field, already selected, with
 * «Mantén presionado el texto y elige Copiar», «Copiar de nuevo» (a new tap: the browser may allow it now) and,
 * on a phone, «Compartir» (WhatsApp, Messages…). The same panel on the admin and on the coordinators' portal:
 * portalled to <body> in the confirm layer, styled inline (the portal does not compile the admin's classes),
 * Escape and the backdrop close it.
 *
 * `useCopy()` is how a screen uses it: `copy(text)` copies inside the tap and says «Copiado» only when it worked;
 * otherwise it opens this panel. Render `copyUi` somewhere in the screen.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LAYER, overlayZ, pushEscape } from "./overlay";
import { canShare, copyLater as copyLaterRaw, copyText, shareText } from "./clipboard";

const WORDS: Record<string, Record<string, string>> = {
    es: { title: "Copia el enlace", text: "Copia el texto", hint: "Tu navegador no dejó copiar solo. Mantén presionado el texto y elige «Copiar».", retry: "Copiar de nuevo", share: "Compartir", close: "Cerrar", done: "Copiado" },
    en: { title: "Copy the link", text: "Copy the text", hint: "Your browser did not let it copy by itself. Press and hold the text and choose «Copy».", retry: "Copy again", share: "Share", close: "Close", done: "Copied" },
    pt: { title: "Copie o link", text: "Copie o texto", hint: "Seu navegador não deixou copiar sozinho. Mantenha pressionado o texto e escolha «Copiar».", retry: "Copiar de novo", share: "Compartilhar", close: "Fechar", done: "Copiado" },
};
// No language given: the admin's (the app's stored language), else the page's.
const pageLang = (): string => {
    try { const s = localStorage.getItem("wordjs-lang"); if (s) return s; } catch { /* private mode */ }
    return typeof document !== "undefined" ? document.documentElement.lang || "" : "";
};
export const copyWords = (lang?: string) => WORDS[String(lang || pageLang()).slice(0, 2)] || WORDS.es;

const isLink = (s: string) => /^https?:\/\/\S+$/i.test(String(s || "").trim());

export function CopyFallback({ text, title, lang, onClose, onCopied }: { text: string; title?: string; lang?: string; onClose: () => void; onCopied?: (msg: string) => void }) {
    const w = copyWords(lang);
    const field = useRef<HTMLTextAreaElement | null>(null);
    const [again, setAgain] = useState<"" | "no">("");
    const select = () => { const el = field.current; if (!el) return; try { el.focus({ preventScroll: true }); el.select(); el.setSelectionRange(0, el.value.length); } catch { /* ignore */ } };
    useEffect(() => { select(); return pushEscape(onClose); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    const retry = () => {
        copyText(text).then((ok) => { if (ok) { onCopied && onCopied(w.done); onClose(); } else { setAgain("no"); select(); } });
    };
    const share = () => {
        shareText(isLink(text) ? { url: text.trim() } : { text }).then((r) => { if (r !== "unsupported") onClose(); });
    };
    const btn: React.CSSProperties = { minHeight: 44, padding: "0 16px", borderRadius: 14, fontWeight: 800, fontSize: 14, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer" };
    const node = (
        // React events cross portals: stopped here so a tap in the panel never reaches the sheet it was opened from.
        <div data-copy-fallback="" onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}
            onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
            style={{ position: "fixed", inset: 0, zIndex: overlayZ(LAYER.confirm), background: "rgba(17,24,39,.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
            <div role="dialog" aria-modal="true" aria-label={title || (isLink(text) ? w.title : w.text)}
                style={{ background: "#fff", borderRadius: 20, width: "100%", maxWidth: 480, padding: 20, boxShadow: "0 20px 50px rgba(0,0,0,.25)", display: "grid", gap: 12 }}>
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#111827" }}>{title || (isLink(text) ? w.title : w.text)}</h3>
                <p role="status" style={{ margin: 0, fontSize: 14, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 12, padding: "8px 12px" }}>{w.hint}</p>
                {/* 16px: a smaller field makes Safari zoom in. Read-only: no keyboard; the text stays selectable. */}
                <textarea ref={field} readOnly value={text} onFocus={select} onClick={select} rows={isLink(text) ? 3 : 6} data-copy-fallback-text=""
                    style={{ width: "100%", boxSizing: "border-box", fontSize: 16, lineHeight: 1.4, padding: 12, borderRadius: 12, border: "2px solid #e5e7eb", color: "#111827", background: "#f9fafb", resize: "none", wordBreak: "break-all", userSelect: "text", WebkitUserSelect: "text" }} />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
                    {canShare() && <button type="button" onClick={share} data-copy-fallback-share="" style={{ ...btn, background: "#2563eb", color: "#fff", border: 0 }}><i className="fa-solid fa-share-nodes" aria-hidden="true"></i>{w.share}</button>}
                    <button type="button" onClick={retry} data-copy-fallback-retry={again} style={{ ...btn, background: "#fff", color: "#374151", border: "2px solid #e5e7eb" }}><i className="fa-solid fa-copy" aria-hidden="true"></i>{w.retry}</button>
                    <button type="button" onClick={onClose} data-copy-fallback-close="" style={{ ...btn, background: "#111827", color: "#fff", border: 0 }}>{w.close}</button>
                </div>
            </div>
        </div>
    );
    return typeof document !== "undefined" && document.body ? createPortal(node, document.body) : node;
}

/**
 * `copy(text)` — call it straight from the tap (no await before it). `onCopied(msg)` shows the screen's own
 * «Copiado» toast; a failed copy opens the panel, so nothing fails silently. `copyLater(promise)` is the same for
 * a text still being fetched. `share(data)` opens the phone's share sheet, and copies when there is none.
 */
export function useCopy({ onCopied, lang }: { onCopied?: (msg: string) => void; lang?: string } = {}) {
    const [manual, setManual] = useState<{ text: string; title?: string } | null>(null);
    const done = useRef(onCopied); done.current = onCopied;
    const w = copyWords(lang);
    const settle = (text: string, title: string | undefined, msg: string | undefined) => (ok: boolean) => {
        if (ok) { done.current && done.current(msg || w.done); } else setManual({ text, title });
        return ok;
    };
    const copy = useCallback((text: string, opts: { title?: string; done?: string } = {}) =>
        copyText(text).then(settle(text, opts.title, opts.done)), [lang]); // eslint-disable-line react-hooks/exhaustive-deps
    const copyLater = useCallback((text: Promise<string>, opts: { title?: string; done?: string } = {}) =>
        copyLaterRaw(text).then(async (ok) => {
            if (ok) return settle("", opts.title, opts.done)(true);
            const value = await text; // a text that could not be made throws: the caller shows its error
            return value ? settle(value, opts.title, opts.done)(false) : false;
        }), [lang]); // eslint-disable-line react-hooks/exhaustive-deps
    const share = useCallback(async (data: { title?: string; text?: string; url?: string }, opts: { title?: string; done?: string } = {}) => {
        const r = await shareText(data);
        if (r !== "unsupported") return true;
        const text = [data.text, data.url].filter(Boolean).join("\n");
        return copy(text, opts);
    }, [copy]);
    const copyUi = manual ? <CopyFallback text={manual.text} title={manual.title} lang={lang} onClose={() => setManual(null)} onCopied={(m) => done.current && done.current(m)} /> : null;
    return { copy, copyLater, share, canShare: canShare(), copyUi };
}
