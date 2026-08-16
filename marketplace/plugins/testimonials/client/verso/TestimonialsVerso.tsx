// @ts-nocheck
"use client";

/**
 * Verso block "Testimonials" — DYNAMIC testimonials pulled from the plugin database (many entries,
 * moderation, optional public collection). The core static "Testimonial" block is a single
 * testimonial typed in the editor; this one lists every APPROVED testimonial as a carousel or a
 * responsive grid, and can optionally render the public submission form under the display (only
 * when the server setting allows it).
 *
 * Registered via manifest.frontend.versoComponents; the generated versoPluginRegistry composes
 * { ...versoComponentDef, render: default export }, so versoComponentDef must NOT carry a render.
 * Runs in the editor iframe AND on the public page — data arrives via a client-mount fetch against
 * the plugin's PUBLIC endpoint, guarded with res.ok (an inactive plugin 404s — the block degrades
 * to a quiet placeholder instead of crashing the page).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

const STYLES = `
.wjtm-wrap { width: 100%; max-width: 100%; }
.wjtm-card { background: var(--wjs-bg-surface, #fff); border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.75rem); padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,.06); display: flex; flex-direction: column; gap: .85rem; }
.wjtm-quote { width: 28px; height: 28px; color: var(--wjs-color-primary, #4f46e5); opacity: .5; flex: 0 0 auto; }
.wjtm-content { color: var(--wjs-color-text, #1f2937); font-size: 1rem; line-height: 1.65; margin: 0; white-space: pre-line; }
.wjtm-stars { display: inline-flex; gap: 2px; font-size: 1.05rem; line-height: 1; }
.wjtm-star { color: var(--wjs-border-subtle, #d1d5db); }
.wjtm-star-on { color: #f59e0b; }
.wjtm-author { display: flex; align-items: center; gap: .75rem; margin-top: auto; }
.wjtm-photo { width: 44px; height: 44px; border-radius: 50%; object-fit: cover; flex: 0 0 auto; background: var(--wjs-bg-muted, #f3f4f6); }
.wjtm-initial { width: 44px; height: 44px; border-radius: 50%; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; background: var(--wjs-color-primary, #4f46e5); color: #fff; font-weight: 700; font-size: 1.05rem; }
.wjtm-name { font-weight: 700; color: var(--wjs-color-text, #111827); font-size: .95rem; line-height: 1.2; }
.wjtm-role { color: var(--wjs-color-text-muted, #6b7280); font-size: .8rem; line-height: 1.3; }
.wjtm-empty { padding: 2rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.5rem); font-size: .9rem; }

/* Carousel: one card at a time */
.wjtm-carousel { position: relative; overflow: hidden; }
.wjtm-track { display: flex; transition: transform .45s cubic-bezier(.22,.9,.35,1); }
.wjtm-slide { flex: 0 0 100%; min-width: 0; padding: 0 3rem; box-sizing: border-box; }
.wjtm-slide .wjtm-card { max-width: 760px; margin: 0 auto; align-items: center; text-align: center; }
.wjtm-slide .wjtm-author { flex-direction: column; gap: .5rem; margin-top: .25rem; }
.wjtm-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 38px; height: 38px; border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: 50%; background: var(--wjs-bg-surface, #fff); color: var(--wjs-color-text, #374151); font-size: 1.1rem; cursor: pointer; z-index: 2; display: flex; align-items: center; justify-content: center; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
.wjtm-nav:hover { background: var(--wjs-bg-muted, #f3f4f6); }
.wjtm-prev { left: 2px; }
.wjtm-next { right: 2px; }
.wjtm-dots { display: flex; gap: 6px; justify-content: center; margin-top: .9rem; flex-wrap: wrap; }
.wjtm-dot { width: 9px; height: 9px; border-radius: 50%; border: none; padding: 0; background: var(--wjs-border-subtle, #d1d5db); cursor: pointer; }
.wjtm-dot.wjtm-active { background: var(--wjs-color-primary, #4f46e5); }

/* Grid: responsive 1 / 2 / 3 columns */
.wjtm-grid { display: grid; grid-template-columns: 1fr; gap: 1.25rem; }
@media (min-width: 640px) { .wjtm-grid { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 1024px) { .wjtm-grid { grid-template-columns: repeat(3, 1fr); } }

/* Public submission form */
.wjtm-form { max-width: 640px; margin: 2rem auto 0; background: var(--wjs-bg-surface, #fff); border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.75rem); padding: 1.5rem; display: flex; flex-direction: column; gap: .9rem; }
.wjtm-form-title { font-weight: 700; color: var(--wjs-color-text, #111827); font-size: 1.05rem; margin: 0; }
.wjtm-label { display: block; font-size: .78rem; font-weight: 600; color: var(--wjs-color-text-muted, #6b7280); margin-bottom: .3rem; }
.wjtm-input, .wjtm-textarea { width: 100%; box-sizing: border-box; padding: .6rem .8rem; border: 1px solid var(--wjs-border-subtle, #d1d5db); border-radius: .5rem; background: var(--wjs-bg-page, #fff); color: var(--wjs-color-text, #111827); font: inherit; font-size: .95rem; }
.wjtm-input:focus, .wjtm-textarea:focus { outline: 2px solid var(--wjs-color-primary, #4f46e5); outline-offset: 1px; }
.wjtm-textarea { min-height: 110px; resize: vertical; }
.wjtm-rating-picker { display: inline-flex; gap: 4px; }
.wjtm-rating-btn { border: none; background: none; padding: 2px; cursor: pointer; font-size: 1.5rem; line-height: 1; color: var(--wjs-border-subtle, #d1d5db); }
.wjtm-rating-btn.wjtm-star-on { color: #f59e0b; }
.wjtm-submit { align-self: flex-start; padding: .65rem 1.4rem; border: none; border-radius: .6rem; background: var(--wjs-color-primary, #4f46e5); color: #fff; font-weight: 700; font-size: .9rem; cursor: pointer; }
.wjtm-submit:disabled { opacity: .55; cursor: default; }
.wjtm-msg-ok { background: #ecfdf5; color: #047857; padding: .7rem 1rem; border-radius: .6rem; font-size: .9rem; }
.wjtm-msg-err { background: #fef2f2; color: #b91c1c; padding: .7rem 1rem; border-radius: .6rem; font-size: .9rem; }
.wjtm-hp { position: absolute; left: -9999px; top: -9999px; height: 1px; width: 1px; overflow: hidden; }

@media (max-width: 767.98px) { .wjtm-slide { padding: 0 2.4rem; } .wjtm-nav { width: 32px; height: 32px; } }
`;

// ── module-level components (never define a component inside a component) ──────────────────────

function TmStars({ rating }) {
    const r = Math.max(1, Math.min(5, Number(rating) || 5));
    return (
        <span className="wjtm-stars" aria-label={`${r} de 5 estrellas`} role="img">
            {[1, 2, 3, 4, 5].map((i) => (
                <span key={i} className={i <= r ? "wjtm-star wjtm-star-on" : "wjtm-star"} aria-hidden="true">★</span>
            ))}
        </span>
    );
}

function TmQuoteIcon() {
    return (
        <svg className="wjtm-quote" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M9.6 5C6 6.6 3.5 9.8 3.5 13.6c0 3 1.9 5.4 4.6 5.4 2.3 0 4-1.7 4-3.9 0-2.1-1.5-3.7-3.6-3.7-.4 0-.8.1-1 .1.4-2 2-3.9 4-4.9L9.6 5zm10 0c-3.6 1.6-6.1 4.8-6.1 8.6 0 3 1.9 5.4 4.6 5.4 2.3 0 4-1.7 4-3.9 0-2.1-1.5-3.7-3.6-3.7-.4 0-.8.1-1 .1.4-2 2-3.9 4-4.9L19.6 5z" />
        </svg>
    );
}

function TmAuthor({ item, showPhotos }) {
    const name = item.author_name || "";
    const initial = name.trim().charAt(0).toUpperCase() || "?";
    return (
        <div className="wjtm-author">
            {showPhotos && (
                item.author_photo
                    /* Plain <img>, deliberately NOT loading="lazy": carousel cards sit translated inside
                       an overflow:hidden track where the viewport-based lazy heuristic never fires. */
                    ? <img className="wjtm-photo" src={item.author_photo} alt={name} decoding="async" />
                    : <span className="wjtm-initial" aria-hidden="true">{initial}</span>
            )}
            <span>
                <span className="wjtm-name">{name}</span>
                {item.author_role ? <span className="wjtm-role" style={{ display: "block" }}>{item.author_role}</span> : null}
            </span>
        </div>
    );
}

function TmCard({ item, showRating, showPhotos }) {
    return (
        <div className="wjtm-card">
            <TmQuoteIcon />
            <p className="wjtm-content">{item.content}</p>
            {showRating && <TmStars rating={item.rating} />}
            <TmAuthor item={item} showPhotos={showPhotos} />
        </div>
    );
}

function TmCarousel({ items, showRating, showPhotos }) {
    const [current, setCurrent] = useState(0);
    const hoverRef = useRef(false);
    const total = items.length;

    useEffect(() => { setCurrent(0); }, [total]);

    // Auto-advance every 6 s, paused while hovered.
    useEffect(() => {
        if (total < 2) return;
        const t = setInterval(() => {
            if (!hoverRef.current) setCurrent((c) => (c + 1) % total);
        }, 6000);
        return () => clearInterval(t);
    }, [total]);

    const go = (i) => setCurrent(((i % total) + total) % total);

    return (
        <div>
            <div
                className="wjtm-carousel"
                onMouseEnter={() => { hoverRef.current = true; }}
                onMouseLeave={() => { hoverRef.current = false; }}
            >
                <div className="wjtm-track" style={{ transform: `translateX(-${current * 100}%)` }}>
                    {items.map((item) => (
                        <div key={item.id} className="wjtm-slide">
                            <TmCard item={item} showRating={showRating} showPhotos={showPhotos} />
                        </div>
                    ))}
                </div>
                {total > 1 && (
                    <>
                        <button type="button" className="wjtm-nav wjtm-prev" aria-label="Anterior" onClick={() => go(current - 1)}>‹</button>
                        <button type="button" className="wjtm-nav wjtm-next" aria-label="Siguiente" onClick={() => go(current + 1)}>›</button>
                    </>
                )}
            </div>
            {total > 1 && (
                <div className="wjtm-dots">
                    {items.map((item, i) => (
                        <button key={item.id} type="button" className={`wjtm-dot${i === current ? " wjtm-active" : ""}`} aria-label={`Testimonio ${i + 1}`} onClick={() => go(i)} />
                    ))}
                </div>
            )}
        </div>
    );
}

function TmGrid({ items, showRating, showPhotos }) {
    return (
        <div className="wjtm-grid">
            {items.map((item) => (
                <TmCard key={item.id} item={item} showRating={showRating} showPhotos={showPhotos} />
            ))}
        </div>
    );
}

function TmSubmitForm({ onSubmitted }) {
    const [name, setName] = useState("");
    const [role, setRole] = useState("");
    const [content, setContent] = useState("");
    const [rating, setRating] = useState(5);
    const [hp, setHp] = useState(""); // honeypot — humans never see or fill it
    const [busy, setBusy] = useState(false);
    const [ok, setOk] = useState("");
    const [error, setError] = useState("");
    const mountedAtRef = useRef(0);

    useEffect(() => { mountedAtRef.current = Date.now(); }, []);

    const submit = async (e) => {
        e.preventDefault();
        if (busy) return;
        setError("");
        if (!name.trim() || !content.trim()) {
            setError("El nombre y el testimonio son obligatorios.");
            return;
        }
        setBusy(true);
        try {
            const res = await fetch("/api/v1/plugin/testimonials/public/submit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    author_name: name.trim(),
                    author_role: role.trim(),
                    content: content.trim(),
                    rating,
                    hp,
                    elapsed: mountedAtRef.current ? Date.now() - mountedAtRef.current : 0,
                }),
            });
            const data = await res.json().catch(() => null);
            if (res.ok && data && data.success) {
                setOk("Gracias — tu testimonio será revisado.");
                if (onSubmitted) onSubmitted();
            } else {
                setError((data && data.error) || "No se pudo enviar el testimonio. Inténtalo de nuevo.");
            }
        } catch {
            setError("No se pudo enviar el testimonio. Inténtalo de nuevo.");
        } finally {
            setBusy(false);
        }
    };

    if (ok) {
        return <div className="wjtm-form"><div className="wjtm-msg-ok">{ok}</div></div>;
    }

    return (
        <form className="wjtm-form" onSubmit={submit}>
            <p className="wjtm-form-title">Deja tu testimonio</p>
            <div>
                <label className="wjtm-label">Nombre *</label>
                <input className="wjtm-input" type="text" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div>
                <label className="wjtm-label">Cargo / Empresa (opcional)</label>
                <input className="wjtm-input" type="text" value={role} maxLength={120} onChange={(e) => setRole(e.target.value)} />
            </div>
            <div>
                <label className="wjtm-label">Calificación</label>
                <span className="wjtm-rating-picker" role="radiogroup" aria-label="Calificación">
                    {[1, 2, 3, 4, 5].map((i) => (
                        <button
                            key={i}
                            type="button"
                            className={`wjtm-rating-btn${i <= rating ? " wjtm-star-on" : ""}`}
                            aria-label={`${i} de 5 estrellas`}
                            aria-pressed={i === rating}
                            onClick={() => setRating(i)}
                        >★</button>
                    ))}
                </span>
            </div>
            <div>
                <label className="wjtm-label">Testimonio *</label>
                <textarea className="wjtm-textarea" value={content} maxLength={2000} onChange={(e) => setContent(e.target.value)} required />
            </div>
            {/* Honeypot: hidden off-screen; bots that fill it get a fake success server-side. */}
            <div className="wjtm-hp" aria-hidden="true">
                <label>No llenar este campo</label>
                <input type="text" value={hp} tabIndex={-1} autoComplete="off" onChange={(e) => setHp(e.target.value)} />
            </div>
            {error && <div className="wjtm-msg-err">{error}</div>}
            <button type="submit" className="wjtm-submit" disabled={busy}>{busy ? "Enviando…" : "Enviar testimonio"}</button>
        </form>
    );
}

export const versoComponentDef = {
    category: "Testimonios",
    fields: {
        mode: {
            type: "radio",
            label: "Modo de visualización",
            options: [
                { label: "Carrusel", value: "carousel" },
                { label: "Cuadrícula", value: "grid" },
            ],
        },
        maxItems: { type: "number", label: "Máximo de testimonios" },
        showRating: {
            type: "radio",
            label: "Mostrar calificación",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        showPhotos: {
            type: "radio",
            label: "Mostrar fotos",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        showSubmitForm: {
            type: "radio",
            label: "Formulario de envío público",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        mode: "carousel",
        maxItems: 9,
        showRating: true,
        showPhotos: true,
        showSubmitForm: false,
        elementId: "",
    },
};

export default function TestimonialsVerso({ mode, maxItems, showRating, showPhotos, showSubmitForm, elementId }) {
    const [items, setItems] = useState(null);        // null = loading, [] = loaded-empty
    const [allowSubmit, setAllowSubmit] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);   // not strictly needed, but lets the form trigger a refresh

    const limit = useMemo(() => {
        const n = parseInt(maxItems, 10);
        return Math.min(50, Math.max(1, Number.isFinite(n) ? n : 9));
    }, [maxItems]);

    useEffect(() => {
        let alive = true;
        fetch(`/api/v1/plugin/testimonials/public/list?limit=${limit}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (!alive) return;
                setItems((data && data.items) || []);
                setAllowSubmit(!!(data && data.allowPublicSubmit));
            })
            .catch(() => { if (alive) setItems([]); });
        return () => { alive = false; };
    }, [limit, reloadKey]);

    const display = items === null ? (
        <div className="wjtm-empty">Cargando testimonios…</div>
    ) : items.length === 0 ? (
        <div className="wjtm-empty">No hay testimonios para mostrar todavía.</div>
    ) : mode === "grid" ? (
        <TmGrid items={items} showRating={showRating !== false} showPhotos={showPhotos !== false} />
    ) : (
        <TmCarousel items={items} showRating={showRating !== false} showPhotos={showPhotos !== false} />
    );

    return (
        <div id={elementId || undefined} className="wjtm-wrap">
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {display}
            {showSubmitForm === true && allowSubmit && items !== null && (
                <TmSubmitForm onSubmitted={() => setReloadKey((k) => k + 1)} />
            )}
        </div>
    );
}
