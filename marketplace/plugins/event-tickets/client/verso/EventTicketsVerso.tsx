// @ts-nocheck
"use client";

/**
 * Verso block "EventTickets" — public ticket purchase card for one event.
 *
 * Registered via manifest.frontend.versoComponents; the generated registry composes
 * { ...versoComponentDef, render: default export }, so versoComponentDef must NOT carry a render.
 * Runs in the editor iframe AND on the public page: data arrives via a client-mount fetch against
 * the plugin's PUBLIC endpoints, guarded with res.ok (an inactive plugin 404s — the block degrades
 * to a quiet Spanish placeholder instead of crashing the page).
 *
 * Checkout NEVER sends prices: only ticket-type ids + quantities. The server recomputes totals.
 * On mount it also handles ?tickets=<token> (order status link from the pending-payment flow).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

const STYLES = `
.wjet-card { max-width: 640px; margin: 0 auto; border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 12px); background: var(--wjs-bg-surface, #fff); overflow: hidden; font-family: var(--wjs-font-family-base, inherit); }
.wjet-head { padding: 1.5rem 1.5rem 1rem; border-bottom: 1px solid var(--wjs-border-subtle, #e5e7eb); }
.wjet-title { margin: 0 0 .35rem; font-size: 1.4rem; font-weight: 800; color: var(--wjs-color-text, #111827); }
.wjet-meta { margin: 0; font-size: .85rem; color: var(--wjs-color-text-muted, #6b7280); }
.wjet-desc { margin: .6rem 0 0; font-size: .9rem; color: var(--wjs-color-text-muted, #6b7280); }
.wjet-body { padding: 1rem 1.5rem 1.5rem; }
.wjet-row { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .8rem 0; border-bottom: 1px dashed var(--wjs-border-subtle, #e5e7eb); flex-wrap: wrap; }
.wjet-row:last-of-type { border-bottom: none; }
.wjet-tname { font-weight: 700; color: var(--wjs-color-text, #111827); }
.wjet-tprice { font-size: .9rem; color: var(--wjs-color-text-muted, #6b7280); }
.wjet-chip { display: inline-block; font-size: .7rem; font-weight: 700; padding: .15rem .55rem; border-radius: 999px; background: color-mix(in srgb, var(--wjet-accent) 12%, transparent); color: var(--wjet-accent); margin-left: .4rem; vertical-align: middle; }
.wjet-chip-off { background: #f3f4f6; color: #9ca3af; }
.wjet-stepper { display: inline-flex; align-items: center; gap: .5rem; }
.wjet-stepper button { width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--wjs-border-subtle, #d1d5db); background: var(--wjs-bg-surface, #fff); color: var(--wjs-color-text, #111827); font-size: 1.05rem; font-weight: 700; cursor: pointer; line-height: 1; }
.wjet-stepper button:disabled { opacity: .35; cursor: default; }
.wjet-stepper span { min-width: 24px; text-align: center; font-weight: 800; font-variant-numeric: tabular-nums; }
.wjet-total { display: flex; justify-content: space-between; align-items: baseline; margin: 1rem 0; padding-top: 1rem; border-top: 2px solid var(--wjs-color-text, #111827); font-weight: 800; font-size: 1.05rem; color: var(--wjs-color-text, #111827); }
.wjet-form { display: grid; gap: .7rem; margin-top: .5rem; }
.wjet-form input { width: 100%; padding: .7rem .9rem; border: 1px solid var(--wjs-border-subtle, #d1d5db); border-radius: 10px; font-size: .95rem; background: var(--wjs-bg-surface, #fff); color: var(--wjs-color-text, #111827); box-sizing: border-box; }
.wjet-form input:focus { outline: 2px solid var(--wjet-accent); outline-offset: 1px; border-color: transparent; }
.wjet-hp { position: absolute; left: -9999px; top: -9999px; height: 1px; width: 1px; opacity: 0; }
.wjet-btn { width: 100%; padding: .85rem 1rem; border: none; border-radius: 10px; background: var(--wjet-accent); color: #fff; font-size: 1rem; font-weight: 800; cursor: pointer; transition: filter .15s; }
.wjet-btn:hover { filter: brightness(1.08); }
.wjet-btn:disabled { opacity: .5; cursor: default; }
.wjet-error { margin-top: .7rem; padding: .7rem .9rem; border-radius: 10px; background: #fef2f2; color: #b91c1c; font-size: .88rem; }
.wjet-ok { margin-top: .7rem; padding: 1rem; border-radius: 12px; background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; }
.wjet-pend { margin-top: .7rem; padding: 1rem; border-radius: 12px; background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
.wjet-codes { display: flex; flex-direction: column; gap: .5rem; margin: .8rem 0; }
.wjet-code { font-family: ui-monospace, monospace; font-size: 1.5rem; font-weight: 800; letter-spacing: .25em; text-align: center; padding: .6rem .4rem; border-radius: 10px; background: #fff; border: 2px dashed #86efac; color: #14532d; }
.wjet-code small { display: block; letter-spacing: normal; font-size: .7rem; font-weight: 600; color: #16a34a; margin-top: .15rem; }
.wjet-token { font-family: ui-monospace, monospace; word-break: break-all; background: #fff; border: 1px dashed #fcd34d; border-radius: 8px; padding: .5rem .7rem; font-size: .85rem; margin-top: .5rem; }
.wjet-empty { max-width: 640px; margin: 0 auto; padding: 2rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 12px); font-size: .9rem; }
.wjet-note { font-size: .8rem; color: var(--wjs-color-text-muted, #6b7280); margin-top: .6rem; }
@media (max-width: 480px) { .wjet-head, .wjet-body { padding-left: 1rem; padding-right: 1rem; } .wjet-code { font-size: 1.15rem; } }
`;

const CART_KEY = "wjet_cart_v1";

// Module-level cart helpers (localStorage can throw in sandboxed iframes — always guarded).
function readCart() {
    try {
        if (typeof window === "undefined") return null;
        return JSON.parse(window.localStorage.getItem(CART_KEY) || "null");
    } catch {
        return null;
    }
}
function writeCart(cart) {
    try {
        if (typeof window !== "undefined") window.localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch { /* private mode / iframe — non-fatal */ }
}
function clearCart() {
    try {
        if (typeof window !== "undefined") window.localStorage.removeItem(CART_KEY);
    } catch { /* ignore */ }
}

function fmtMoney(cents, symbol) {
    const n = Number(cents) || 0;
    return (symbol || "$") + (n % 100 === 0 ? String(n / 100) : (n / 100).toFixed(2));
}
function fmtDate(v) {
    if (!v) return "";
    const d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString("es", { dateStyle: "full", timeStyle: "short" });
}

// Module-level (never define a component inside a component — remounting steals input focus).
function TicketCodes({ tickets }) {
    return (
        <div className="wjet-codes">
            {(tickets || []).map((t, i) => (
                <div key={i} className="wjet-code">
                    {t.code}
                    {t.type_name ? <small>{t.type_name}</small> : null}
                </div>
            ))}
        </div>
    );
}

export const versoComponentDef = {
    category: "Comercio",
    fields: {
        eventId: { type: "number", label: "ID del evento (0 = próximo publicado)" },
        accentColor: { type: "text", label: "Color de acento (hex)" },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        eventId: 0,
        accentColor: "#4f46e5",
        elementId: "",
    },
};

export default function EventTicketsVerso({ eventId, accentColor, elementId }) {
    const [data, setData] = useState(null);      // null = loading, {events,...} = loaded, false = failed
    const [qty, setQty] = useState({});          // ticket_type_id -> n
    const [buyer, setBuyer] = useState({ name: "", email: "" });
    const [hp, setHp] = useState("");            // honeypot — humans never see or fill it
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState(null);  // order response after submit
    const [lookup, setLookup] = useState(null);  // order status from ?tickets=<token>
    const mountedAtRef = useRef(Date.now());

    // Load published upcoming events (public endpoint; also works in the editor iframe).
    useEffect(() => {
        let alive = true;
        fetch("/api/v1/plugin/event-tickets/public/events")
            .then((res) => (res.ok ? res.json() : null))
            .then((d) => { if (alive) setData(d || false); })
            .catch(() => { if (alive) setData(false); });
        return () => { alive = false; };
    }, []);

    // Handle a return visit with ?tickets=<token> (pending order the buyer is checking on).
    useEffect(() => {
        if (typeof window === "undefined") return;
        let alive = true;
        try {
            const token = new URLSearchParams(window.location.search).get("tickets");
            if (!token) return;
            fetch(`/api/v1/plugin/event-tickets/public/order?token=${encodeURIComponent(token)}`)
                .then((res) => (res.ok ? res.json() : null))
                .then((d) => { if (alive && d) setLookup(d); })
                .catch(() => { });
        } catch { /* ignore */ }
        return () => { alive = false; };
    }, []);

    const event = useMemo(() => {
        if (!data || !Array.isArray(data.events) || !data.events.length) return null;
        const wanted = Number(eventId) || 0;
        if (wanted > 0) return data.events.find((e) => e.id === wanted) || null;
        return data.events[0]; // 0 = next upcoming published (list is sorted ascending)
    }, [data, eventId]);

    // Restore a saved cart for this event.
    useEffect(() => {
        if (!event) return;
        const saved = readCart();
        if (saved && saved.eventId === event.id) {
            if (saved.qty && typeof saved.qty === "object") setQty(saved.qty);
            if (saved.buyer && typeof saved.buyer === "object") setBuyer({ name: saved.buyer.name || "", email: saved.buyer.email || "" });
        }
    }, [event && event.id]);

    // Persist selections so a refresh doesn't wipe them.
    useEffect(() => {
        if (!event) return;
        writeCart({ eventId: event.id, qty, buyer });
    }, [event && event.id, qty, buyer]);

    const symbol = (data && data.currencySymbol) || "$";
    const totalCents = useMemo(() => {
        if (!event) return 0;
        return event.ticket_types.reduce((sum, t) => sum + (Number(qty[t.id]) || 0) * (Number(t.price_cents) || 0), 0);
    }, [event, qty]);
    const totalSeats = useMemo(() => Object.values(qty).reduce((a, b) => a + (Number(b) || 0), 0), [qty]);

    const step = (t, delta) => {
        setQty((prev) => {
            const cap = Math.min(10, Math.max(0, Number(t.remaining) || 0));
            const next = Math.max(0, Math.min(cap, (Number(prev[t.id]) || 0) + delta));
            return { ...prev, [t.id]: next };
        });
    };

    const submit = async (e) => {
        e.preventDefault();
        if (!event || submitting) return;
        setError("");
        const items = event.ticket_types
            .filter((t) => (Number(qty[t.id]) || 0) > 0)
            .map((t) => ({ ticket_type_id: t.id, qty: Number(qty[t.id]) }));
        if (!items.length) { setError("Selecciona al menos una entrada."); return; }
        if (!buyer.name.trim()) { setError("Escribe tu nombre."); return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer.email.trim())) { setError("Escribe un correo válido."); return; }
        setSubmitting(true);
        try {
            const res = await fetch("/api/v1/plugin/event-tickets/public/order", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    event_id: event.id,
                    items,
                    buyer_name: buyer.name.trim(),
                    buyer_email: buyer.email.trim(),
                    hp,
                    elapsed: Date.now() - mountedAtRef.current,
                }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(body.error || "No se pudo procesar el pedido, inténtalo de nuevo.");
                return;
            }
            setResult(body);
            clearCart();
        } catch {
            setError("Error de conexión — inténtalo de nuevo.");
        } finally {
            setSubmitting(false);
        }
    };

    const accent = accentColor || "#4f46e5";
    const wrapStyle = { "--wjet-accent": accent };

    // ── render states ────────────────────────────────────────────────────────────────────────────
    let content;
    if (lookup) {
        content = (
            <div className="wjet-card">
                <div className="wjet-head">
                    <h3 className="wjet-title">{lookup.event_title || "Tu pedido"}</h3>
                    <p className="wjet-meta">{fmtDate(lookup.event_starts_at)}{lookup.event_venue ? ` · ${lookup.event_venue}` : ""}</p>
                </div>
                <div className="wjet-body">
                    {lookup.status === "paid" ? (
                        <div className="wjet-ok">
                            <strong>Pago confirmado.</strong> Estas son tus entradas, {lookup.buyer_name}:
                            <TicketCodes tickets={lookup.tickets} />
                            <p className="wjet-note">También las enviamos a tu correo. Presenta el código en la entrada.</p>
                        </div>
                    ) : lookup.status === "pending" ? (
                        <div className="wjet-pend">
                            <strong>Pedido pendiente de pago</strong> — total {fmtMoney(lookup.total_cents, lookup.currencySymbol || symbol)}.
                            {lookup.manualInstructions ? <p style={{ margin: ".5rem 0 0" }}>{lookup.manualInstructions}</p> : null}
                            <p className="wjet-note">Cuando confirmemos tu pago recibirás los códigos por correo.</p>
                        </div>
                    ) : (
                        <div className="wjet-error">Este pedido fue cancelado.</div>
                    )}
                    <button type="button" className="wjet-btn" style={{ marginTop: "1rem" }} onClick={() => setLookup(null)}>Comprar más entradas</button>
                </div>
            </div>
        );
    } else if (result) {
        content = (
            <div className="wjet-card">
                <div className="wjet-body">
                    {result.status === "paid" ? (
                        <div className="wjet-ok">
                            <strong>¡Listo! Tus entradas están confirmadas.</strong>
                            <TicketCodes tickets={result.tickets} />
                            <p className="wjet-note">Revisa tu correo — también te enviamos los códigos. Guárdalos para el check-in.</p>
                        </div>
                    ) : (
                        <div className="wjet-pend">
                            <strong>Pedido recibido</strong> — total {fmtMoney(result.total_cents, symbol)}.
                            {result.manualInstructions ? <p style={{ margin: ".5rem 0 0" }}>{result.manualInstructions}</p> : <p style={{ margin: ".5rem 0 0" }}>El organizador confirmará tu pago manualmente.</p>}
                            <p className="wjet-note">Guarda tu referencia de pedido — con ella puedes consultar el estado en esta misma página (?tickets=…):</p>
                            <div className="wjet-token">{result.token}</div>
                            <p className="wjet-note">Cuando el pago quede confirmado recibirás los códigos de entrada por correo.</p>
                        </div>
                    )}
                </div>
            </div>
        );
    } else if (data === null) {
        content = <div className="wjet-empty">Cargando entradas…</div>;
    } else if (!event) {
        content = <div className="wjet-empty">No hay eventos próximos con entradas disponibles — crea uno en Admin → Entradas.</div>;
    } else {
        content = (
            <div className="wjet-card">
                <div className="wjet-head">
                    <h3 className="wjet-title">{event.title}</h3>
                    <p className="wjet-meta">{fmtDate(event.starts_at)}{event.venue ? ` · ${event.venue}` : ""}</p>
                    {event.description ? <p className="wjet-desc">{event.description}</p> : null}
                </div>
                <div className="wjet-body">
                    {event.ticket_types.length === 0 ? (
                        <p className="wjet-meta">Aún no hay tipos de entrada a la venta para este evento.</p>
                    ) : (
                        <>
                            {event.ticket_types.map((t) => {
                                const closed = !t.sales_open || t.remaining <= 0;
                                return (
                                    <div className="wjet-row" key={t.id}>
                                        <div>
                                            <span className="wjet-tname">{t.name}</span>
                                            {closed
                                                ? <span className="wjet-chip wjet-chip-off">{t.remaining <= 0 ? "Agotado" : "Venta cerrada"}</span>
                                                : <span className="wjet-chip">Quedan {t.remaining}</span>}
                                            <div className="wjet-tprice">{Number(t.price_cents) > 0 ? fmtMoney(t.price_cents, symbol) : "Gratis"}</div>
                                        </div>
                                        <div className="wjet-stepper">
                                            <button type="button" aria-label={`Quitar ${t.name}`} disabled={closed || !(Number(qty[t.id]) > 0)} onClick={() => step(t, -1)}>−</button>
                                            <span>{Number(qty[t.id]) || 0}</span>
                                            <button type="button" aria-label={`Agregar ${t.name}`} disabled={closed || (Number(qty[t.id]) || 0) >= Math.min(10, t.remaining)} onClick={() => step(t, 1)}>+</button>
                                        </div>
                                    </div>
                                );
                            })}

                            <div className="wjet-total">
                                <span>Total ({totalSeats} entrada{totalSeats === 1 ? "" : "s"})</span>
                                <span>{totalCents > 0 ? fmtMoney(totalCents, symbol) : "Gratis"}</span>
                            </div>

                            <form className="wjet-form" onSubmit={submit}>
                                <input
                                    type="text"
                                    placeholder="Tu nombre"
                                    value={buyer.name}
                                    onChange={(e) => setBuyer({ ...buyer, name: e.target.value })}
                                    autoComplete="name"
                                />
                                <input
                                    type="email"
                                    placeholder="Tu correo (recibirás los códigos aquí)"
                                    value={buyer.email}
                                    onChange={(e) => setBuyer({ ...buyer, email: e.target.value })}
                                    autoComplete="email"
                                />
                                {/* Honeypot: hidden from humans; bots that fill it get rejected. */}
                                <input
                                    className="wjet-hp"
                                    type="text"
                                    tabIndex={-1}
                                    autoComplete="off"
                                    aria-hidden="true"
                                    value={hp}
                                    onChange={(e) => setHp(e.target.value)}
                                />
                                <button type="submit" className="wjet-btn" disabled={submitting || totalSeats === 0}>
                                    {submitting ? "Procesando…" : totalCents > 0 ? `Reservar — ${fmtMoney(totalCents, symbol)}` : "Obtener entradas gratis"}
                                </button>
                            </form>
                            {error && <div className="wjet-error">{error}</div>}
                        </>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div id={elementId || undefined} style={wrapStyle}>
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {content}
        </div>
    );
}
