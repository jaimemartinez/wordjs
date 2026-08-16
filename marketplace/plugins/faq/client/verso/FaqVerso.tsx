// @ts-nocheck
"use client";

/**
 * Verso block "Faq" — an accordion of published FAQ entries WITH Google FAQPage JSON-LD
 * structured data (rich-results markup). That is the differentiator versus the core static
 * Accordion block: the questions here come from the FAQ database and are announced to
 * search engines as schema.org/FAQPage.
 *
 * Registered via manifest.frontend.versoComponents; the generated versoPluginRegistry composes
 * { ...versoComponentDef, render: default export }, so versoComponentDef must NOT carry a render.
 * Runs in the editor iframe AND on the public page, so data arrives via a client-mount fetch
 * against the plugin's PUBLIC endpoint, guarded with res.ok (an inactive plugin 404s — the
 * block degrades to a quiet Spanish placeholder instead of crashing the page).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

// Classes are namespaced under `.wjs-p-faq-` so a theme can NAME these surfaces through the
// manifest (plugin:faq:*). The prefix is derived from the plugin slug — see
// scripts/plugin-theme-surfaces.js — and manifest.json declares the same selectors under
// `themeSurfaces`; frontend/src/lib/__tests__/pluginSelectorContract.test.ts proves the two agree.
const STYLES = `
.wjs-p-faq-wrap { width: 100%; max-width: 100%; }
.wjs-p-faq-title { font-size: var(--wjs-h2-size, 1.75rem); font-weight: 700; margin: 0 0 1rem; color: inherit; }
.wjs-p-faq-list { display: flex; flex-direction: column; gap: .6rem; }
.wjs-p-faq-item { border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, .5rem); background: var(--wjs-bg-surface, #fff); overflow: hidden; }
.wjs-p-faq-question { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 1rem; padding: .95rem 1.15rem; background: transparent; border: none; cursor: pointer; text-align: left; font: inherit; font-weight: 600; line-height: 1.4; color: inherit; }
.wjs-p-faq-question:hover { background: rgba(0, 0, 0, .03); }
.wjs-p-faq-icon { flex: 0 0 auto; width: 1.5em; height: 1.5em; display: inline-flex; align-items: center; justify-content: center; font-size: 1.15em; font-weight: 400; line-height: 1; color: var(--wjs-color-text-muted, #6b7280); transition: transform .3s ease; }
.wjs-p-faq-item--open .wjs-p-faq-icon { transform: rotate(45deg); }
.wjs-p-faq-panel { max-height: 0; overflow: hidden; transition: max-height .35s ease; }
.wjs-p-faq-answer { padding: 0 1.15rem 1.05rem; white-space: pre-line; color: var(--wjs-color-text-muted, #4b5563); line-height: 1.65; }
.wjs-p-faq-empty { padding: 1.75rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, .5rem); font-size: .9rem; }
@media (max-width: 767.98px) { .wjs-p-faq-question { padding: .8rem .9rem; } .wjs-p-faq-answer { padding: 0 .9rem .9rem; } }
`;

// Module-level (never define a component inside a component — remounting steals state/focus).
// Smooth max-height transition: the panel animates between 0 and the measured content height.
function FaqItem({ item, open, onToggle }) {
    const innerRef = useRef(null);
    const [maxH, setMaxH] = useState(0);

    useEffect(() => {
        if (open && innerRef.current) setMaxH(innerRef.current.scrollHeight);
        else setMaxH(0);
    }, [open, item.answer]);

    return (
        <div className={"wjs-p-faq-item" + (open ? " wjs-p-faq-item--open" : "")}>
            <button type="button" className="wjs-p-faq-question" aria-expanded={open} onClick={onToggle}>
                <span>{item.question}</span>
                <span className="wjs-p-faq-icon" aria-hidden="true">+</span>
            </button>
            <div className="wjs-p-faq-panel" style={{ maxHeight: maxH + "px" }}>
                {/* Plain text on purpose (white-space: pre-line) — answers are NOT trusted HTML. */}
                <div ref={innerRef} className="wjs-p-faq-answer">{item.answer}</div>
            </div>
        </div>
    );
}

export const versoComponentDef = {
    category: "FAQ",
    fields: {
        title: { type: "text", label: "Título" },
        category: { type: "text", label: "Categoría (vacío = todas)" },
        maxItems: { type: "number", label: "Máximo de preguntas" },
        singleOpen: {
            type: "radio",
            label: "Abrir solo una a la vez",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        jsonLd: {
            type: "radio",
            label: "Datos estructurados FAQPage (SEO Google)",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
    },
    defaultProps: {
        title: "Preguntas frecuentes",
        category: "",
        maxItems: 20,
        singleOpen: true,
        jsonLd: true,
    },
};

export default function FaqVerso({ title, category, maxItems, singleOpen, jsonLd }) {
    const [items, setItems] = useState(null); // null = loading, [] = loaded-empty
    const [openIds, setOpenIds] = useState([]);

    const query = useMemo(() => {
        const p = new URLSearchParams();
        if (category) p.set("category", String(category).trim());
        p.set("limit", String(Math.min(100, Math.max(1, Number(maxItems) || 20))));
        return p.toString();
    }, [category, maxItems]);

    useEffect(() => {
        let alive = true;
        fetch(`/api/v1/plugin/faq/public/list?${query}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => { if (alive) setItems((data && data.faqs) || []); })
            .catch(() => { if (alive) setItems([]); });
        return () => { alive = false; };
    }, [query]);

    const toggle = (id) => {
        setOpenIds((prev) => {
            const isOpen = prev.includes(id);
            if (singleOpen) return isOpen ? [] : [id];
            return isOpen ? prev.filter((x) => x !== id) : [...prev, id];
        });
    };

    // FAQPage JSON-LD for Google rich results. Escaping "<" keeps any "</script>" inside an
    // answer from breaking out of the script element (JSON stays valid with <).
    const jsonLdPayload = useMemo(() => {
        if (!jsonLd || !items || items.length === 0) return null;
        const data = {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: items.map((it) => ({
                "@type": "Question",
                name: it.question,
                acceptedAnswer: { "@type": "Answer", text: it.answer },
            })),
        };
        return JSON.stringify(data).replace(/</g, "\\u003c");
    }, [jsonLd, items]);

    return (
        <div className="wjs-p-faq-wrap">
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {title ? <h2 className="wjs-p-faq-title">{title}</h2> : null}
            {items === null ? (
                <div className="wjs-p-faq-empty">Cargando preguntas frecuentes…</div>
            ) : items.length === 0 ? (
                <div className="wjs-p-faq-empty">
                    No hay preguntas frecuentes para mostrar
                    {category ? ` en la categoría "${category}"` : ""} — agrégalas en Admin → FAQ.
                </div>
            ) : (
                <div className="wjs-p-faq-list">
                    {items.map((it) => (
                        <FaqItem key={it.id} item={it} open={openIds.includes(it.id)} onToggle={() => toggle(it.id)} />
                    ))}
                </div>
            )}
            {jsonLdPayload ? (
                // A JSON-LD script in the BODY is valid for Google's FAQPage rich results.
                <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdPayload }} />
            ) : null}
        </div>
    );
}
