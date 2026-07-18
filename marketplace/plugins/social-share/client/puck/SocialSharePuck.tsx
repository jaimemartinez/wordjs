// @ts-nocheck
"use client";

/**
 * Puck block "SocialShare" — share buttons for the current page.
 *
 * Registered via manifest.frontend.puckComponents; the generated puckPluginRegistry composes
 * { ...puckComponentDef, render: default export }, so puckComponentDef must NOT carry a render.
 *
 * Pure client-side: the page URL and title are read AT CLICK TIME (never at render — the block
 * also renders during SSR and inside the editor iframe, where window may not exist yet or the
 * URL would be the editor's, so everything window-dependent is guarded and deferred).
 */

import React, { useEffect, useRef, useState } from "react";

const STYLES = `
.wjss-wrap { display: flex; flex-wrap: wrap; align-items: center; gap: .65rem; }
.wjss-left { justify-content: flex-start; }
.wjss-center { justify-content: center; }
.wjss-right { justify-content: flex-end; }
.wjss-title { font-weight: 600; font-size: .95rem; color: var(--wjs-color-text, #111827); margin-right: .15rem; }
.wjss-item { display: flex; flex-direction: column; align-items: center; gap: .3rem; }
.wjss-btn { display: inline-flex; align-items: center; justify-content: center; border: none; padding: 0; color: #fff; cursor: pointer; line-height: 0; transition: transform .15s ease, filter .15s ease, background-color .2s ease; }
.wjss-btn:hover { transform: scale(1.12); filter: brightness(1.1); }
.wjss-btn:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
.wjss-sm { width: 32px; height: 32px; }
.wjss-sm svg { width: 16px; height: 16px; }
.wjss-md { width: 40px; height: 40px; }
.wjss-md svg { width: 20px; height: 20px; }
.wjss-lg { width: 48px; height: 48px; }
.wjss-lg svg { width: 24px; height: 24px; }
.wjss-circle { border-radius: 50%; }
.wjss-rounded { border-radius: 12px; }
.wjss-square { border-radius: 0; }
.wjss-label { font-size: 11px; line-height: 1.15; text-align: center; max-width: 76px; color: var(--wjs-color-text-muted, #6b7280); }
.wjss-empty { padding: 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.5rem); font-size: .85rem; }
`;

// Simple official-shape brand paths, 24x24 viewBox, drawn with fill=currentColor (white on brand bg).
const ICON_PATHS = {
    facebook: "M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.9h2.54V9.85c0-2.5 1.5-3.89 3.77-3.89 1.1 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.88h2.78l-.45 2.9h-2.33V22c4.78-.76 8.44-4.92 8.44-9.94z",
    x: "M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.21-6.82-5.97 6.82H1.67l7.73-8.84L1.25 2.25h6.83l4.71 6.23 5.45-6.23zm-1.16 17.52h1.83L7.08 4.13H5.12l11.96 15.64z",
    whatsapp: "M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.17.2-.35.22-.64.07-.3-.15-1.26-.46-2.39-1.47-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.49s1.07 2.89 1.22 3.09c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.62.71.23 1.36.2 1.87.12.57-.08 1.76-.72 2-1.41.25-.7.25-1.29.18-1.41-.07-.12-.27-.2-.57-.35zM12.05 21.79h-.01a9.87 9.87 0 0 1-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.88 9.9-9.88 2.64 0 5.13 1.03 7 2.9a9.82 9.82 0 0 1 2.89 7c0 5.45-4.44 9.88-9.9 9.88zm8.42-18.3A11.82 11.82 0 0 0 12.05 0C5.5 0 .16 5.33.16 11.89c0 2.1.55 4.14 1.59 5.95L.06 24l6.3-1.65a11.9 11.9 0 0 0 5.68 1.45h.01c6.55 0 11.89-5.33 11.89-11.89 0-3.18-1.24-6.16-3.47-8.42z",
    linkedin: "M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.32 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.79M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z",
    telegram: "M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z",
    email: "M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z",
    copyLink: "M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z",
};
const CHECK_PATH = "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z";

const NETWORKS = [
    { key: "facebook", name: "Facebook", color: "#1877f2" },
    { key: "x", name: "X (Twitter)", color: "#000000" },
    { key: "whatsapp", name: "WhatsApp", color: "#25d366" },
    { key: "linkedin", name: "LinkedIn", color: "#0a66c2" },
    { key: "telegram", name: "Telegram", color: "#229ed9" },
    { key: "email", name: "Email", color: "#6b7280" },
    { key: "copyLink", name: "Copiar enlace", color: "#374151" },
];

/** Share-intent URL per network. url/title are raw; encoding happens here. */
function buildShareUrl(key, url, title) {
    const u = encodeURIComponent(url);
    const t = encodeURIComponent(title);
    switch (key) {
        case "facebook": return "https://www.facebook.com/sharer/sharer.php?u=" + u;
        case "x": return "https://twitter.com/intent/tweet?url=" + u + "&text=" + t;
        case "whatsapp": return "https://wa.me/?text=" + encodeURIComponent(title + " " + url);
        case "linkedin": return "https://www.linkedin.com/sharing/share-offsite/?url=" + u;
        case "telegram": return "https://t.me/share/url?url=" + u + "&text=" + t;
        default: return "";
    }
}

/** Hidden-textarea copy fallback for insecure contexts / older browsers. */
function fallbackCopy(text) {
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-9999px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

/** Clipboard API when available (secure context only), else the textarea fallback. */
async function copyToClipboard(text) {
    if (typeof window !== "undefined" && window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            return fallbackCopy(text);
        }
    }
    return fallbackCopy(text);
}

// Module-level component (never define a component inside a component — remounting steals focus).
function ShareButton({ netKey, name, color, size, shape, showLabels, copied, onShare }) {
    const isCopy = netKey === "copyLink";
    const showCopied = isCopy && copied;
    const aria = isCopy
        ? (showCopied ? "Enlace copiado" : "Copiar enlace")
        : netKey === "email"
            ? "Compartir por email"
            : "Compartir en " + name;
    return (
        <span className="wjss-item">
            <button
                type="button"
                className={"wjss-btn wjss-" + size + " wjss-" + shape}
                style={{ backgroundColor: showCopied ? "#16a34a" : color }}
                aria-label={aria}
                title={aria}
                onClick={() => onShare(netKey)}
            >
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d={showCopied ? CHECK_PATH : ICON_PATHS[netKey]} />
                </svg>
            </button>
            {(showLabels || showCopied) && (
                <span className="wjss-label">{showCopied ? "¡Copiado!" : name}</span>
            )}
        </span>
    );
}

export const puckComponentDef = {
    category: "Social",
    fields: {
        title: { type: "text", label: "Título (ej. Compartir:)" },
        facebook: {
            type: "radio",
            label: "Facebook",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        x: {
            type: "radio",
            label: "X (Twitter)",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        whatsapp: {
            type: "radio",
            label: "WhatsApp",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        linkedin: {
            type: "radio",
            label: "LinkedIn",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        telegram: {
            type: "radio",
            label: "Telegram",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        email: {
            type: "radio",
            label: "Email",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        copyLink: {
            type: "radio",
            label: "Copiar enlace",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        size: {
            type: "radio",
            label: "Tamaño",
            options: [
                { label: "Pequeño", value: "sm" },
                { label: "Mediano", value: "md" },
                { label: "Grande", value: "lg" },
            ],
        },
        shape: {
            type: "radio",
            label: "Forma",
            options: [
                { label: "Círculo", value: "circle" },
                { label: "Redondeado", value: "rounded" },
                { label: "Cuadrado", value: "square" },
            ],
        },
        showLabels: {
            type: "radio",
            label: "Mostrar etiquetas",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        align: {
            type: "radio",
            label: "Alineación",
            options: [
                { label: "Izquierda", value: "left" },
                { label: "Centro", value: "center" },
                { label: "Derecha", value: "right" },
            ],
        },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        title: "Compartir:",
        facebook: true,
        x: true,
        whatsapp: true,
        linkedin: true,
        telegram: true,
        email: true,
        copyLink: true,
        size: "md",
        shape: "circle",
        showLabels: false,
        align: "left",
        elementId: "",
    },
};

export default function SocialSharePuck({
    title, facebook, x, whatsapp, linkedin, telegram, email, copyLink,
    size, shape, showLabels, align, elementId,
}) {
    const [copied, setCopied] = useState(false);
    const timerRef = useRef(null);

    // Clear the pending "¡Copiado!" reset if the block unmounts within the 2s window.
    useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

    // Tolerate both booleans (defaultProps) and stringified values from older saved data.
    const isOn = (v) => v !== false && v !== "false";
    const enabled = { facebook, x, whatsapp, linkedin, telegram, email, copyLink };
    const active = NETWORKS.filter((n) => isOn(enabled[n.key]));

    // Validate visual props against the allowed sets (saved data could hold anything).
    const sz = size === "sm" || size === "lg" ? size : "md";
    const shp = shape === "rounded" || shape === "square" ? shape : "circle";
    const alignCls = align === "center" ? "wjss-center" : align === "right" ? "wjss-right" : "wjss-left";
    // Labels default to off, so only an explicit "yes" turns them on.
    const labelsOn = showLabels === true || showLabels === "true";

    // URL + title are read AT CLICK TIME so the shared page is the one the visitor is on.
    const handleShare = (key) => {
        if (typeof window === "undefined") return;
        const url = window.location.href;
        const pageTitle = document.title || "";
        if (key === "email") {
            // mailto must navigate the current context — window.open pops a blank tab in many browsers.
            window.location.href = "mailto:?subject=" + encodeURIComponent(pageTitle) + "&body=" + encodeURIComponent(url);
            return;
        }
        if (key === "copyLink") {
            copyToClipboard(url).then((ok) => {
                if (!ok) return;
                setCopied(true);
                if (timerRef.current) clearTimeout(timerRef.current);
                timerRef.current = setTimeout(() => setCopied(false), 2000);
            });
            return;
        }
        const shareUrl = buildShareUrl(key, url, pageTitle);
        if (shareUrl) window.open(shareUrl, "_blank", "noopener,width=600,height=500");
    };

    return (
        <div id={elementId || undefined}>
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {active.length === 0 ? (
                <div className="wjss-empty">Selecciona al menos una red social para mostrar los botones de compartir.</div>
            ) : (
                <div className={"wjss-wrap " + alignCls}>
                    {title ? <span className="wjss-title">{title}</span> : null}
                    {active.map((n) => (
                        <ShareButton
                            key={n.key}
                            netKey={n.key}
                            name={n.name}
                            color={n.color}
                            size={sz}
                            shape={shp}
                            showLabels={labelsOn}
                            copied={copied}
                            onShare={handleShare}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
