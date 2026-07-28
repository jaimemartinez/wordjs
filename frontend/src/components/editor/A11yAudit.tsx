"use client";

/**
 * Accessibility audit for the Puck canvas (Webflow-audit parity), dependency-free.
 *
 * `runA11yAudit(doc)` walks the CANVAS document (pass `iframe.contentDocument`) and returns a
 * flat issue list; each issue is mapped back to its block by climbing to the closest
 * `data-puck-component` ancestor (the attribute the fork's DraggableComponent stamps on every
 * block root inside the iframe). `A11yPanel` renders the list in the editor chrome (M3 --ed-*
 * tokens) and reports clicks so the integrator can select the offending block via
 * `window.puckDispatch({ type: "setUi", ui: { itemSelector } })`.
 *
 * SSR-safe: no `window`/`document` at module scope; the audit only touches the doc it is given.
 */

import React from "react";
import MSym from "./MSym";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/puckI18n";

export type A11yIssue = {
    severity: "error" | "warning";
    rule: string;
    message: string;
    blockId?: string;
    snippet: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────────────

/** Editor-owned elements inside the canvas doc (guides/overlays) — never audited. */
const EDITOR_OVERLAY_SELECTOR =
    // NOT [data-puck-dnd] as an ANCESTOR match: every block ROOT carries it (dnd-kit handle), so a
    // closest() on it silently limited the whole audit to theme chrome. The root itself IS editor
    // scaffolding though (role="button" + aria from dnd-kit → phantom "unnamed button" findings),
    // so isEditorEl also skips the element when IT carries the attribute — content stays audited.
    "#wjs-spacing-overlay, #wjs-guides, [data-puck-overlay], [data-puck-overlay-portal]";

function isEditorEl(el: Element): boolean {
    try {
        return el.hasAttribute("data-puck-dnd") || !!el.closest(EDITOR_OVERLAY_SELECTOR);
    } catch {
        return false;
    }
}

function blockIdOf(el: Element): string | undefined {
    return el.closest("[data-puck-component]")?.getAttribute("data-puck-component") || undefined;
}

/** Compact, single-line description of the element (opening tag + a slice of its text). */
function snippetOf(el: Element): string {
    const tag = el.tagName.toLowerCase();
    let s = "<" + tag;
    const attrs = el.attributes;
    for (let i = 0; i < attrs.length && i < 4; i++) {
        let v = attrs[i].value;
        if (v.length > 24) v = v.slice(0, 24) + "…";
        s += ` ${attrs[i].name}="${v}"`;
    }
    s += ">";
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text) s += text.length > 40 ? text.slice(0, 40) + "…" : text;
    return s.length > 120 ? s.slice(0, 120) + "…" : s;
}

/** Minimal accessible-name computation (aria-label → aria-labelledby → text → img alt → title). */
function accessibleName(el: Element, doc: Document): string {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
        const txt = labelledby
            .split(/\s+/)
            .map((id) => doc.getElementById(id)?.textContent || "")
            .join(" ")
            .trim();
        if (txt) return txt;
    }
    const text = (el.textContent || "").trim();
    if (text) return text;
    const alt = el.querySelector("img[alt]")?.getAttribute("alt")?.trim();
    if (alt) return alt;
    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    return "";
}

function hasAssociatedLabel(input: Element, doc: Document): boolean {
    const aria = input.getAttribute("aria-label");
    if (aria && aria.trim()) return true;
    const labelledby = input.getAttribute("aria-labelledby");
    if (labelledby && labelledby.split(/\s+/).some((id) => (doc.getElementById(id)?.textContent || "").trim())) {
        return true;
    }
    if (input.closest("label")) return true;
    const id = input.getAttribute("id");
    if (id) {
        try {
            if (doc.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`)) return true;
        } catch {
            /* invalid id for a selector — fall through */
        }
    }
    const title = input.getAttribute("title");
    return !!(title && title.trim());
}

// ── WCAG contrast helpers ──
type RGBA = [number, number, number, number];

function parseColor(v: string): RGBA | null {
    if (!v) return null;
    if (v === "transparent") return [0, 0, 0, 0];
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return null; // exotic color space (color(srgb …), oklch…) — skip rather than guess
    const parts = m[1].split(",").map((p) => parseFloat(p));
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
    const a = parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3] : 1;
    return [parts[0], parts[1], parts[2], a];
}

/** Composite `fg` over `bg` (standard source-over). */
function blend(fg: RGBA, bg: [number, number, number]): [number, number, number] {
    const a = Math.max(0, Math.min(1, fg[3]));
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
}

/**
 * Effective background under `el`: climb ancestors until an OPAQUE background-color is found,
 * compositing any semi-transparent layers met on the way; documents without one bottom out on
 * white (the canvas default).
 */
function effectiveBackground(el: Element, win: Window): [number, number, number] {
    const layers: RGBA[] = [];
    let node: Element | null = el;
    while (node) {
        const c = parseColor(win.getComputedStyle(node).backgroundColor);
        if (c && c[3] > 0) {
            if (c[3] >= 1) {
                let base: [number, number, number] = [c[0], c[1], c[2]];
                for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base);
                return base;
            }
            layers.push(c);
        }
        node = node.parentElement;
    }
    let base: [number, number, number] = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base);
    return base;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
    const lin = (c: number): number => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
    const l1 = relativeLuminance(a);
    const l2 = relativeLuminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function hasDirectText(el: Element): boolean {
    for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3 /* TEXT_NODE */ && (n.textContent || "").trim()) return true;
    }
    return false;
}

const CONTRAST_SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE", "META", "LINK"]);

/** Run every rule over the canvas document. Returns [] for a missing/empty doc. */
export function runA11yAudit(doc: Document): A11yIssue[] {
    const issues: A11yIssue[] = [];
    if (!doc || !doc.body) return issues;
    const win = doc.defaultView;

    const push = (severity: A11yIssue["severity"], rule: string, message: string, el: Element): void => {
        issues.push({ severity, rule, message, blockId: blockIdOf(el), snippet: snippetOf(el) });
    };

    // 1) Images without alt (alt="" = decorative → ok).
    doc.body.querySelectorAll("img").forEach((img) => {
        if (isEditorEl(img) || img.getAttribute("aria-hidden") === "true") return;
        if (img.getAttribute("role") === "presentation") return;
        if (img.getAttribute("alt") === null) {
            push("error", "img-alt", "La imagen no tiene texto alternativo (alt)", img);
        }
    });

    // 2) Heading hierarchy: level jumps (h2 → h4) + more than one h1.
    let prevLevel: number | null = null;
    let h1Count = 0;
    doc.body.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
        if (isEditorEl(h)) return;
        const level = Number(h.tagName[1]);
        if (level === 1) {
            h1Count++;
            if (h1Count > 1) push("warning", "multiple-h1", "Hay más de un h1 en la página", h);
        }
        if (prevLevel !== null && level > prevLevel + 1) {
            push("warning", "heading-order", "Salto en la jerarquía de encabezados", h);
        }
        prevLevel = level;
    });

    // 3) Links/buttons without an accessible name.
    doc.body.querySelectorAll("a[href], button, [role='button']").forEach((el) => {
        if (isEditorEl(el) || el.getAttribute("aria-hidden") === "true") return;
        if (!accessibleName(el, doc)) {
            push("error", "accessible-name", "Enlace o botón sin texto accesible", el);
        }
    });

    // 4) Form inputs without an associated label.
    doc.body
        .querySelectorAll(
            "input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]), select, textarea"
        )
        .forEach((el) => {
            if (isEditorEl(el) || el.getAttribute("aria-hidden") === "true") return;
            if (!hasAssociatedLabel(el, doc)) {
                push("error", "input-label", "Campo de formulario sin etiqueta asociada", el);
            }
        });

    // 5) Text contrast (WCAG AA: 4.5:1; large text — ≥24px, or ≥18.66px bold — 3:1).
    if (win) {
        doc.body.querySelectorAll("*").forEach((el) => {
            if (CONTRAST_SKIP_TAGS.has(el.tagName) || isEditorEl(el) || !hasDirectText(el)) return;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 1 || rect.height <= 1) return; // hidden / sr-only clipped
            const cs = win.getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none") return;
            const fg = parseColor(cs.color);
            if (!fg || fg[3] === 0) return;
            const bg = effectiveBackground(el, win);
            const text = fg[3] < 1 ? blend(fg, bg) : ([fg[0], fg[1], fg[2]] as [number, number, number]);
            const size = parseFloat(cs.fontSize) || 16;
            const weight = parseFloat(cs.fontWeight) || 400;
            const isLarge = size >= 24 || (size >= 18.66 && weight >= 700);
            const threshold = isLarge ? 3 : 4.5;
            if (contrastRatio(text, bg) < threshold) {
                push("warning", "contrast", "Contraste de texto insuficiente", el);
            }
        });
    }

    // 6) Iframes without a title.
    doc.body.querySelectorAll("iframe").forEach((el) => {
        if (isEditorEl(el)) return;
        const title = el.getAttribute("title") || el.getAttribute("aria-label");
        if (!title || !title.trim()) push("warning", "iframe-title", "El iframe no tiene título", el);
    });

    // 7) Positive tabindex.
    doc.body.querySelectorAll("[tabindex]").forEach((el) => {
        if (isEditorEl(el)) return;
        const v = parseInt(el.getAttribute("tabindex") || "", 10);
        if (Number.isFinite(v) && v > 0) push("warning", "tabindex-positive", "Evita tabindex mayor que 0", el);
    });

    return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel
// ─────────────────────────────────────────────────────────────────────────────

/** Group headers per rule (Spanish base strings — translated through trStr like the rest). */
const RULE_LABEL: Record<string, string> = {
    "img-alt": "Imágenes sin alt",
    "heading-order": "Jerarquía de encabezados",
    "multiple-h1": "Varios h1",
    "accessible-name": "Sin nombre accesible",
    "input-label": "Campos sin etiqueta",
    contrast: "Contraste insuficiente",
    "iframe-title": "Iframes sin título",
    "tabindex-positive": "Tabindex positivo",
};

// Severity glyphs: the Material Symbols font is a NAMED-ICON SUBSET — "warning"/"error" are NOT
// in it. Errors use "close" inside a red circle; warnings use "info" tinted amber.
function SeverityIcon({ severity }: { severity: A11yIssue["severity"] }) {
    if (severity === "error") {
        return (
            <span className="w-4 h-4 shrink-0 rounded-full bg-[var(--ed-error)] text-white flex items-center justify-center">
                <MSym name="close" size={12} />
            </span>
        );
    }
    return <MSym name="info" size={16} className="shrink-0 text-amber-600" />;
}

/**
 * Audit results list, M3-styled with the editor's --ed-* tokens. Groups issues by rule
 * (error groups first), rows click through to `onSelect(blockId)` so the integrator can select
 * the block in the canvas; `onRefresh` re-runs the audit.
 */
export function A11yPanel({
    issues,
    onSelect,
    onRefresh,
    running,
}: {
    issues: A11yIssue[];
    onSelect: (blockId?: string) => void;
    onRefresh: () => void;
    running: boolean;
}) {
    const { language } = useI18n();

    const errorCount = issues.filter((i) => i.severity === "error").length;
    const warningCount = issues.length - errorCount;

    // Group by rule, keeping insertion order within a group; error groups sort first, then by size.
    const groups = new Map<string, A11yIssue[]>();
    for (const issue of issues) {
        const list = groups.get(issue.rule);
        if (list) list.push(issue);
        else groups.set(issue.rule, [issue]);
    }
    const ordered = Array.from(groups.entries()).sort((a, b) => {
        const sevA = a[1][0].severity === "error" ? 0 : 1;
        const sevB = b[1][0].severity === "error" ? 0 : 1;
        return sevA !== sevB ? sevA - sevB : b[1].length - a[1].length;
    });

    return (
        <div className="flex flex-col gap-2 p-2">
            {/* Summary + refresh */}
            <div className="flex items-center gap-2 px-1">
                <span className="text-[11px] font-semibold text-[var(--ed-on-surface)] flex-1 truncate">
                    {trStr("Accesibilidad", language)}
                </span>
                {!running && issues.length > 0 && (
                    <span className="flex items-center gap-2 text-[11px] text-[var(--ed-on-surface-variant)] select-none">
                        <span className="flex items-center gap-1">
                            <SeverityIcon severity="error" />
                            {errorCount}
                        </span>
                        <span className="flex items-center gap-1">
                            <SeverityIcon severity="warning" />
                            {warningCount}
                        </span>
                    </span>
                )}
                <button
                    type="button"
                    title={trStr("Volver a analizar", language)}
                    disabled={running}
                    onClick={onRefresh}
                    className={`p-1.5 rounded-md flex items-center justify-center transition-colors ${
                        running
                            ? "text-[var(--ed-outline-variant)] cursor-not-allowed"
                            : "text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)]"
                    }`}
                >
                    <MSym name="refresh" size={18} className={running ? "animate-spin" : ""} />
                </button>
            </div>

            {running ? (
                <div className="flex flex-col items-center justify-center gap-2 py-8 text-[var(--ed-on-surface-variant)] select-none">
                    <MSym name="refresh" size={24} className="animate-spin" />
                    <p className="text-[11px]">{trStr("Analizando la página…", language)}</p>
                </div>
            ) : issues.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-8 select-none">
                    <MSym name="check_circle" size={32} fill className="text-[var(--ed-success)]" />
                    <p className="text-[12px] font-medium text-[var(--ed-on-surface)]">
                        {trStr("Sin problemas detectados", language)}
                    </p>
                </div>
            ) : (
                ordered.map(([rule, list]) => (
                    <section
                        key={rule}
                        className="border border-[var(--ed-outline-variant)] rounded-lg overflow-hidden bg-[var(--ed-surface-container-lowest)]"
                    >
                        <header className="px-2.5 py-2 flex items-center gap-2 bg-[var(--ed-surface-container-low)] border-b border-[var(--ed-outline-variant)]">
                            <SeverityIcon severity={list[0].severity} />
                            <h4 className="flex-1 min-w-0 text-[11px] font-semibold text-[var(--ed-on-surface)] truncate">
                                {trStr(RULE_LABEL[rule] || rule, language)}
                            </h4>
                            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--ed-surface-container-high)] text-[var(--ed-on-surface-variant)]">
                                {list.length}
                            </span>
                        </header>
                        <ul>
                            {list.map((issue, i) => (
                                <li key={i} className={i > 0 ? "border-t border-[var(--ed-outline-variant)]" : ""}>
                                    <button
                                        type="button"
                                        onClick={() => onSelect(issue.blockId)}
                                        title={trStr("Seleccionar el bloque", language)}
                                        className="w-full text-left px-2.5 py-1.5 flex flex-col gap-0.5 hover:bg-[var(--ed-surface-container)] transition-colors"
                                    >
                                        <span className="text-[11px] text-[var(--ed-on-surface)]">
                                            {trStr(issue.message, language)}
                                        </span>
                                        <span
                                            className="text-[10px] text-[var(--ed-on-surface-variant)] truncate"
                                            style={{ fontFamily: "var(--puck-font-family-monospaced)" }}
                                        >
                                            {issue.snippet}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                ))
            )}
        </div>
    );
}
