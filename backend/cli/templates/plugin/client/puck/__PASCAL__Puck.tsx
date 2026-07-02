// @ts-nocheck
"use client";

// Puck block for __NAME__ — declared in manifest.frontend.puckComponents ({ "entry": ... }).
//
// EXPORT CONTRACT (detected by frontend/scripts/generate-puck-plugin-registry.js):
//   • single block    → `export const puckComponentDef = {...}` + a default-exported render
//                       component (this template). Registered as "__PASCAL__" in the editor.
//   • multiple blocks → export a const named puckComponents: { BlockName: { ...def, render }, ... }
//     CAUTION: detection is a literal text match on that const declaration — do not write the
//     declaration form in comments, or the registry will look for the wrong export.
// After activating the plugin, regenerate the registry so the block appears in the editor:
//   node frontend/scripts/generate-puck-plugin-registry.js
//
// Styling: an embedded <style> tag (no build step needed) using --wjs-* theme tokens with
// static fallbacks, so the block automatically follows the active theme.

const STYLES = `
.__SLUG__-block {
    background: var(--wjs-bg-surface, #ffffff);
    color: var(--wjs-color-text-main, #1f2937);
    border: var(--wjs-border-width, 1px) solid var(--wjs-border-subtle, #e5e7eb);
    border-radius: var(--wjs-radius-lg, 24px);
    box-shadow: var(--wjs-shadow, 0 4px 6px -1px rgba(0,0,0,0.1));
    padding: calc(var(--wjs-spacer, 1rem) * 2);
}
.__SLUG__-block h2 {
    color: var(--wjs-color-heading, #111827);
    font-family: var(--wjs-font-family-heading, inherit);
    font-weight: var(--wjs-heading-weight, 800);
    font-size: var(--wjs-h2, 1.8rem);
    margin: 0 0 0.5rem;
}
.__SLUG__-block p {
    color: var(--wjs-color-text-muted, #6b7280);
    font-size: var(--wjs-font-size-base, 1rem);
    line-height: var(--wjs-line-height-base, 1.6);
    margin: 0;
}
`;

interface __PASCAL__PuckProps {
    title?: string;
    body?: string;
    elementId?: string;
}

export const puckComponentDef = {
    category: "__NAME__",
    fields: {
        title: { type: "text" as const, label: "Title" },
        body: { type: "textarea" as const, label: "Body" },
        elementId: { type: "text" as const, label: "ID / anchor (optional)" }
    },
    defaultProps: {
        title: "__NAME__",
        body: "Edit this block in the visual editor.",
        elementId: ""
    }
};

export default function __PASCAL__Puck({ title = "", body = "", elementId = "" }: __PASCAL__PuckProps) {
    return (
        <section id={elementId || undefined} className="__SLUG__-block">
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            <h2>{title}</h2>
            <p>{body}</p>
        </section>
    );
}
