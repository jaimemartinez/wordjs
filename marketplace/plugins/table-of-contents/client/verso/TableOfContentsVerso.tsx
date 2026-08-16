// @ts-nocheck
"use client";

/**
 * Verso block "TableOfContents" — automatic page index (Easy Table of Contents /
 * LuckyWP TOC parity).
 *
 * Registered via manifest.frontend.versoComponents; the generated versoPluginRegistry
 * composes { ...versoComponentDef, render: default export }, so versoComponentDef must
 * NOT carry a render key.
 *
 * The block runs in the editor iframe AND on the public page. On mount (after a small
 * delay so sibling blocks finish rendering) it scans document h2/h3 headings — excluding
 * the TOC itself and any header/footer/nav chrome — assigns missing ids (slugified text,
 * "-n" deduped), builds a nested h2→h3 structure and renders anchored links with smooth
 * scroll + history.replaceState. A scroll-spy IntersectionObserver (threshold 0,
 * rootMargin bottom -70%) highlights the section currently in view.
 *
 * With fewer than 2 matching headings it renders NOTHING on the public page; in the
 * editor it shows a subtle hint so the author knows why the block looks empty.
 */

import React, { useEffect, useRef, useState } from "react";

const STYLES = `
.wjtoc-box { background: var(--wjs-bg-surface, #f9fafb); border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.5rem); padding: 1.1rem 1.25rem; max-width: 100%; font-size: .95rem; }
.wjtoc-title { font-weight: 700; margin: 0 0 .6rem; color: var(--wjs-color-text, #111827); }
.wjtoc-list, .wjtoc-sublist { list-style: none; margin: 0; padding: 0; }
.wjtoc-sublist { margin: .1rem 0 .2rem 1.1rem; }
.wjtoc-item { margin: 0; }
.wjtoc-link { display: inline-block; padding: .18rem 0; color: var(--wjs-color-text-muted, #4b5563); text-decoration: none; line-height: 1.45; transition: color .15s ease; }
.wjtoc-link:hover { color: var(--wjs-color-primary, #2563eb); text-decoration: underline; }
.wjtoc-link.wjtoc-active { color: var(--wjs-color-primary, #2563eb); font-weight: 600; }
.wjtoc-numbered .wjtoc-list { counter-reset: wjtoc-c1; }
.wjtoc-numbered .wjtoc-list > .wjtoc-item { counter-increment: wjtoc-c1; }
.wjtoc-numbered .wjtoc-list > .wjtoc-item > .wjtoc-link::before { content: counter(wjtoc-c1) ". "; font-weight: 600; }
.wjtoc-numbered .wjtoc-sublist { counter-reset: wjtoc-c2; }
.wjtoc-numbered .wjtoc-sublist > .wjtoc-item { counter-increment: wjtoc-c2; }
.wjtoc-numbered .wjtoc-sublist > .wjtoc-item > .wjtoc-link::before { content: counter(wjtoc-c1) "." counter(wjtoc-c2) " "; }
@media (min-width: 768px) { .wjtoc-sticky { position: sticky; top: 90px; align-self: flex-start; } }
.wjtoc-hint { padding: 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.5rem); font-size: .85rem; }
/* Anchored headings must not land hidden behind a sticky site header. */
h2[id], h3[id] { scroll-margin-top: 90px; }
`;

/** Slugify a heading's text into an anchor id (diacritics stripped, spaces → dashes). */
function slugify(text) {
    const s = String(text || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-");
    return s || "seccion";
}

/**
 * Collect the page's content headings, excluding the TOC itself (this block or any
 * other TOC on the page), and site chrome (header / footer / nav).
 */
function collectHeadings(rootEl, depth) {
    const selector = depth === "h2" ? "h2" : "h2, h3";
    const all = Array.from(document.querySelectorAll(selector));
    return all.filter((el) => {
        if (rootEl && rootEl.contains(el)) return false;
        if (el.closest("header, footer, nav, .wjtoc-box")) return false;
        const text = String(el.textContent || "").replace(/\s+/g, " ").trim();
        return text.length > 0;
    });
}

/** Assign ids to headings lacking one, deduping with a "-n" suffix. */
function assignHeadingIds(els) {
    const used = new Set();
    els.forEach((el) => { if (el.id) used.add(el.id); });
    els.forEach((el) => {
        if (el.id) return;
        const base = slugify(el.textContent);
        let id = base;
        let n = 2;
        while (used.has(id) || document.getElementById(id)) {
            id = base + "-" + n;
            n += 1;
        }
        el.id = id;
        used.add(id);
    });
}

/** Nest h3s under their preceding h2; an h3 with no h2 before it becomes top-level. */
function buildTree(els) {
    const tree = [];
    let lastH2 = null;
    els.forEach((el) => {
        const text = String(el.textContent || "").replace(/\s+/g, " ").trim();
        const node = { id: el.id, text, children: [] };
        if (el.tagName === "H2") {
            lastH2 = node;
            tree.push(node);
        } else if (lastH2) {
            lastH2.children.push(node);
        } else {
            tree.push(node);
        }
    });
    return tree;
}

/** Cheap structural equality so re-scans do not churn state (and effects) needlessly. */
function sameTree(a, b) {
    if (!a || !b) return false;
    return JSON.stringify(a) === JSON.stringify(b);
}

function flatCount(items) {
    if (!items) return 0;
    return items.reduce((acc, it) => acc + 1 + it.children.length, 0);
}

function flatIds(items) {
    const ids = [];
    (items || []).forEach((it) => {
        ids.push(it.id);
        it.children.forEach((c) => ids.push(c.id));
    });
    return ids;
}

export const versoComponentDef = {
    category: "Contenido",
    fields: {
        title: { type: "text", label: "Título del índice" },
        depth: {
            type: "radio",
            label: "Profundidad",
            options: [
                { label: "Solo H2", value: "h2" },
                { label: "H2 + H3", value: "h3" },
            ],
        },
        numbered: {
            type: "radio",
            label: "Numerado",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        sticky: {
            type: "radio",
            label: "Fijo al hacer scroll",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
    },
    defaultProps: {
        title: "Tabla de contenidos",
        depth: "h3",
        numbered: false,
        sticky: false,
    },
};

// `puck` is the EDITOR-SUPPLIED render prop ({ isEditing, metadata, dragRef, renderDropZone }). Its
// name is part of the published block contract — every third-party bundle out there destructures it —
// so Verso keeps supplying it under that name and this block keeps reading it.
export default function TableOfContentsVerso({ title, depth, numbered, sticky, puck }) {
    const rootRef = useRef(null);
    const [items, setItems] = useState(null); // null = not scanned yet
    const [activeId, setActiveId] = useState("");
    const isEditing = !!(puck && puck.isEditing);

    // Scan the page's headings. Two passes: a short delay for the normal render, and a
    // late one for sibling blocks that mount their content asynchronously (fetch-based
    // blocks). Re-runs when fields change so the editor preview stays in sync.
    useEffect(() => {
        if (typeof window === "undefined") return undefined;
        let alive = true;
        const scan = () => {
            if (!alive) return;
            const els = collectHeadings(rootRef.current, depth);
            assignHeadingIds(els);
            const tree = buildTree(els);
            setItems((prev) => (sameTree(prev, tree) ? prev : tree));
        };
        const t1 = setTimeout(scan, 250);
        const t2 = setTimeout(scan, 1200);
        return () => { alive = false; clearTimeout(t1); clearTimeout(t2); };
    }, [depth, title, numbered, sticky]);

    // Scroll-spy: a heading crossing into the top 30% band of the viewport becomes the
    // active section. threshold MUST be 0 (higher thresholds never fire for tall elements)
    // and the -70% bottom rootMargin shrinks the intersection box to that top band.
    useEffect(() => {
        if (typeof window === "undefined" || !items || items.length === 0) return undefined;
        const els = flatIds(items)
            .map((id) => document.getElementById(id))
            .filter(Boolean);
        if (els.length === 0) return undefined;
        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) setActiveId(entry.target.id);
                });
            },
            { threshold: 0, rootMargin: "0px 0px -70% 0px" }
        );
        els.forEach((el) => observer.observe(el));
        return () => observer.disconnect();
    }, [items]);

    const onLinkClick = (id) => (e) => {
        e.preventDefault();
        const el = document.getElementById(id);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        // replaceState can throw inside the editor's srcdoc iframe — the scroll already
        // happened, the hash is just a nicety.
        try { history.replaceState(null, "", "#" + id); } catch (err) { /* noop */ }
        setActiveId(id);
    };

    // Fewer than 2 headings: nothing on the public page; a subtle hint in the editor so
    // the author understands why the block renders empty.
    if (!items || flatCount(items) < 2) {
        if (isEditing) {
            return (
                <div ref={rootRef}>
                    <style dangerouslySetInnerHTML={{ __html: STYLES }} />
                    <div className="wjtoc-hint">El índice se genera de los H2/H3 de la página</div>
                </div>
            );
        }
        return null;
    }

    const boxClass = "wjtoc-box"
        + (sticky ? " wjtoc-sticky" : "")
        + (numbered ? " wjtoc-numbered" : "");

    return (
        <nav ref={rootRef} className={boxClass} aria-label={title || "Tabla de contenidos"}>
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {title ? <div className="wjtoc-title">{title}</div> : null}
            <ol className="wjtoc-list">
                {items.map((item) => (
                    <li key={item.id} className="wjtoc-item">
                        <a
                            className={"wjtoc-link" + (activeId === item.id ? " wjtoc-active" : "")}
                            href={"#" + item.id}
                            onClick={onLinkClick(item.id)}
                        >
                            {item.text}
                        </a>
                        {item.children.length > 0 && (
                            <ol className="wjtoc-sublist">
                                {item.children.map((child) => (
                                    <li key={child.id} className="wjtoc-item">
                                        <a
                                            className={"wjtoc-link" + (activeId === child.id ? " wjtoc-active" : "")}
                                            href={"#" + child.id}
                                            onClick={onLinkClick(child.id)}
                                        >
                                            {child.text}
                                        </a>
                                    </li>
                                ))}
                            </ol>
                        )}
                    </li>
                ))}
            </ol>
        </nav>
    );
}
