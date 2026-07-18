// @ts-nocheck
"use client";

/**
 * Puck block "Faq" — an accordion of published FAQ entries WITH Google FAQPage JSON-LD
 * structured data (rich-results markup). That is the differentiator versus the core static
 * Accordion block: the questions here come from the FAQ database and are announced to
 * search engines as schema.org/FAQPage.
 *
 * Registered via manifest.frontend.puckComponents; the generated puckPluginRegistry composes
 * { ...puckComponentDef, render: default export }, so puckComponentDef must NOT carry a render.
 * Runs in the editor iframe AND on the public page, so data arrives via a client-mount fetch
 * against the plugin's PUBLIC endpoint, guarded with res.ok (an inactive plugin 404s — the
 * block degrades to a quiet Spanish placeholder instead of crashing the page).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

const STYLES = `
.wjfq-wrap { width: 100%; max-width: 100%; }
.wjfq-title { font-size: var(--wjs-h2-size, 1.75rem); font-weight: 700; margin: 0 0 1rem; color: inherit; }
.wjfq-list { display: flex; flex-direction: column; gap: .6rem; }
.wjfq-item { border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, .5rem); background: var(--wjs-bg-surface, #fff); overflow: hidden; }
.wjfq-q { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 1rem; padding: .95rem 1.15rem; background: transparent; border: none; cursor: pointer; text-align: left; font: inherit; font-weight: 600; line-height: 1.4; color: inherit; }
.wjfq-q:hover { background: rgba(0, 0, 0, .03); }
.wjfq-icon { flex: 0 0 auto; width: 1.5em; height: 1.5em; display: inline-flex; align-items: center; justify-content: center; font-size: 1.15em; font-weight: 400; line-height: 1; color: var(--wjs-color-text-muted, #6b7280); transition: transform .3s ease; }
.wjfq-open .wjfq-icon { transform: rotate(45deg); }
.wjfq-panel { max-height: 0; overflow: hidden; transition: max-height .35s ease; }
.wjfq-a { padding: 0 1.15rem 1.05rem; white-space: pre-line; color: var(--wjs-color-text-muted, #4b5563); line-height: 1.65; }
.wjfq-empty { padding: 1.75rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, .5rem); font-size: .9rem; }
@media (max-width: 767.98px) { .wjfq-q { padding: .8rem .9rem; } .wjfq-a { padding: 0 .9rem .9rem; } }
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
        <div className={"wjfq-item" + (open ? " wjfq-open" : "")}>
            <button type="button" className="wjfq-q" aria-expanded={open} onClick={onToggle}>
                <span>{item.question}</span>
                <span className="wjfq-icon" aria-hidden="true">+</span>
            </button>
            <div className="wjfq-panel" style={{ maxHeight: maxH + "px" }}>
                {/* Plain text on purpose (white-space: pre-line) — answers are NOT trusted HTML. */}
                <div ref={innerRef} className="wjfq-a">{item.answer}</div>
            </div>
        </div>
    );
}

export const puckComponentDef = {
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

export default function FaqPuck({ title, category, maxItems, singleOpen, jsonLd }) {
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
        <div className="wjfq-wrap">
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {title ? <h2 className="wjfq-title">{title}</h2> : null}
            {items === null ? (
                <div className="wjfq-empty">Cargando preguntas frecuentes…</div>
            ) : items.length === 0 ? (
                <div className="wjfq-empty">
                    No hay preguntas frecuentes para mostrar
                    {category ? ` en la categoría "${category}"` : ""} — agrégalas en Admin → FAQ.
                </div>
            ) : (
                <div className="wjfq-list">
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
