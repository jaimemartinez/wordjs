// @ts-nocheck
"use client";

/**
 * Puck block "Auctions" — grid of active auctions (or a single auction by slug) with a live
 * countdown, bid history and a public bid form (honeypot + min-elapsed anti-spam).
 *
 * Registered via manifest.frontend.puckComponents; puckComponentDef must NOT carry a render.
 * Runs in the editor iframe AND the public page: all data arrives via client-mount fetches against
 * the plugin's PUBLIC endpoints, guarded with res.ok (an inactive plugin 404s — the block degrades
 * to a quiet Spanish placeholder). Polls every 15s while the tab is visible.
 *
 * Money: the server speaks integer cents; this block formats (cents/100) with the shop's symbol.
 * Countdown: uses server-provided epoch ms (endsAtMs) + a clock offset from serverNowMs, so the
 * visitor's wrong local clock cannot break the timer.
 */

import React, { useEffect, useRef, useState } from "react";

const API = "/api/v1/plugin/auctions";
const LS_KEY = "wjau_bidder_v1"; // { profile: {name,email}, bids: { [auctionId]: {token, amountCents} } }

const STYLES = `
.wjau { --wjau-a: var(--wjau-accent, #b45309); color: var(--wjs-color-text, #1f2937); }
.wjau * { box-sizing: border-box; }
.wjau-grid { display: grid; gap: 1.25rem; }
.wjau-cols-1 { grid-template-columns: 1fr; }
.wjau-cols-2 { grid-template-columns: repeat(2, 1fr); }
.wjau-cols-3 { grid-template-columns: repeat(3, 1fr); }
@media (max-width: 767.98px) { .wjau-cols-2, .wjau-cols-3 { grid-template-columns: 1fr; } }
.wjau-card { border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.75rem); overflow: hidden; background: var(--wjs-bg-surface, #fff); display: flex; flex-direction: column; }
.wjau-img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block; background: #f3f4f6; }
.wjau-noimg { width: 100%; aspect-ratio: 4 / 3; display: flex; align-items: center; justify-content: center; background: #f3f4f6; color: #9ca3af; font-size: .85rem; }
.wjau-body { padding: 1rem; display: flex; flex-direction: column; gap: .4rem; flex: 1; }
.wjau-title { font-weight: 700; font-size: 1.05rem; line-height: 1.3; margin: 0; }
.wjau-price { font-size: 1.75rem; font-weight: 800; color: var(--wjau-a); line-height: 1.1; }
.wjau-meta { font-size: .8rem; color: var(--wjs-color-text-muted, #6b7280); }
.wjau-count { font-variant-numeric: tabular-nums; font-weight: 700; }
.wjau-ended-txt { color: #b91c1c; }
.wjau-btn { display: inline-block; margin-top: auto; padding: .65rem 1rem; background: var(--wjau-a); color: #fff; border: none; border-radius: .6rem; font-weight: 700; font-size: .9rem; cursor: pointer; text-align: center; }
.wjau-btn:hover { filter: brightness(.92); }
.wjau-btn[disabled] { opacity: .55; cursor: not-allowed; }
.wjau-btn-ghost { background: transparent; color: var(--wjau-a); border: 1px solid var(--wjau-a); }
.wjau-detail { border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.75rem); overflow: hidden; background: var(--wjs-bg-surface, #fff); }
.wjau-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; padding: 1.5rem; }
@media (max-width: 767.98px) { .wjau-detail-grid { grid-template-columns: 1fr; padding: 1rem; } }
.wjau-detail-img { width: 100%; border-radius: .6rem; object-fit: cover; max-height: 380px; background: #f3f4f6; }
.wjau-desc { font-size: .95rem; line-height: 1.6; white-space: pre-wrap; color: var(--wjs-color-text, #374151); }
.wjau-back { background: none; border: none; color: var(--wjau-a); font-weight: 700; cursor: pointer; padding: 1rem 1.5rem 0; font-size: .9rem; }
.wjau-form { display: flex; flex-direction: column; gap: .6rem; margin-top: .75rem; }
.wjau-input { width: 100%; padding: .6rem .8rem; border: 1px solid var(--wjs-border-subtle, #d1d5db); border-radius: .55rem; font-size: .95rem; background: #fff; color: #111827; }
.wjau-input:focus { outline: 2px solid var(--wjau-a); outline-offset: 1px; }
.wjau-hint { font-size: .8rem; color: var(--wjs-color-text-muted, #6b7280); }
.wjau-hp { position: absolute; left: -9999px; top: -9999px; height: 1px; width: 1px; opacity: 0; }
.wjau-banner { padding: .8rem 1rem; border-radius: .6rem; font-weight: 600; font-size: .95rem; margin-top: .75rem; }
.wjau-banner-win { background: #ecfdf5; color: #047857; }
.wjau-banner-out { background: #fffbeb; color: #b45309; }
.wjau-banner-err { background: #fef2f2; color: #b91c1c; }
.wjau-banner-end { background: #f3f4f6; color: #374151; }
.wjau-history { list-style: none; margin: .5rem 0 0; padding: 0; border-top: 1px solid var(--wjs-border-subtle, #e5e7eb); }
.wjau-history li { display: flex; justify-content: space-between; gap: 1rem; padding: .5rem 0; border-bottom: 1px solid var(--wjs-border-subtle, #f3f4f6); font-size: .9rem; }
.wjau-history .wjau-h-amount { font-weight: 700; font-variant-numeric: tabular-nums; }
.wjau-empty { padding: 2rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.5rem); font-size: .9rem; }
.wjau-badge { display: inline-block; font-size: .72rem; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; padding: .2rem .55rem; border-radius: .4rem; }
.wjau-badge-live { background: #ecfdf5; color: #047857; }
.wjau-badge-end { background: #f3f4f6; color: #6b7280; }
.wjau-section-t { font-weight: 800; font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--wjs-color-text-muted, #6b7280); margin: 1rem 0 0; }
`;

// ---- module-level helpers (never define components inside components) ------------------------------

function readLs() {
    if (typeof window === "undefined") return {};
    try { return JSON.parse(window.localStorage.getItem(LS_KEY) || "{}") || {}; } catch { return {}; }
}
function writeLs(next) {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* storage full/blocked */ }
}

function fmtMoney(cents, symbol) {
    const n = (Number(cents) || 0) / 100;
    const hasDec = Math.round(n * 100) % 100 !== 0;
    return (symbol || "$") + n.toLocaleString("es", { minimumFractionDigits: hasDec ? 2 : 0, maximumFractionDigits: 2 });
}

function splitRemaining(msLeft) {
    const s = Math.max(0, Math.floor(msLeft / 1000));
    return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60, done: s <= 0 };
}

/** Live d/h/m/s countdown; offsetMs corrects the visitor's clock against the server's. */
function Countdown({ endsAtMs, offsetMs, endedLabel }) {
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        const t = setInterval(() => setNowMs(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);
    if (!endsAtMs) return null;
    const r = splitRemaining(endsAtMs - (nowMs + (offsetMs || 0)));
    if (r.done) return <span className="wjau-count wjau-ended-txt">{endedLabel || "Finalizada"}</span>;
    return (
        <span className="wjau-count">
            {r.d > 0 ? `${r.d}d ` : ""}
            {String(r.h).padStart(2, "0")}h {String(r.m).padStart(2, "0")}m {String(r.s).padStart(2, "0")}s
        </span>
    );
}

function AuctionCard({ a, symbol, offsetMs, onOpen }) {
    return (
        <div className="wjau-card">
            {a.image_url ? (
                <img src={a.image_url} alt={a.title} className="wjau-img" decoding="async" />
            ) : (
                <div className="wjau-noimg">Sin imagen</div>
            )}
            <div className="wjau-body">
                <span className={`wjau-badge ${a.ended ? "wjau-badge-end" : "wjau-badge-live"}`}>
                    {a.ended ? "Finalizada" : "En curso"}
                </span>
                <h3 className="wjau-title">{a.title}</h3>
                <div className="wjau-price">{fmtMoney(a.currentPriceCents, symbol)}</div>
                <div className="wjau-meta">
                    {a.bidCount} puja{a.bidCount === 1 ? "" : "s"}
                    {!a.ended && (
                        <>
                            {" · Termina en "}
                            <Countdown endsAtMs={a.endsAtMs} offsetMs={offsetMs} />
                        </>
                    )}
                </div>
                <button type="button" className="wjau-btn" onClick={() => onOpen(a.slug)}>
                    {a.ended ? "Ver resultado" : "Pujar"}
                </button>
            </div>
        </div>
    );
}

/** Detail view: description + history + bid form. Fetches and polls its own data. */
function AuctionDetail({ slug, onBack }) {
    const [data, setData] = useState(null);   // null = loading, false = failed/not found
    const [offsetMs, setOffsetMs] = useState(0);
    const mountedAtRef = useRef(Date.now());
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [amount, setAmount] = useState("");
    const [hp, setHp] = useState("");
    const [busy, setBusy] = useState(false);
    const [banner, setBanner] = useState(null); // { kind: 'win'|'out'|'err', text }
    const myBidRef = useRef(null);              // { amountCents } — my last accepted bid on this auction

    // Prefill from previous participation on this browser.
    useEffect(() => {
        const st = readLs();
        if (st.profile) {
            if (st.profile.name) setName(st.profile.name);
            if (st.profile.email) setEmail(st.profile.email);
        }
    }, []);

    useEffect(() => {
        let alive = true;
        const load = async () => {
            try {
                const res = await fetch(`${API}/public/auction?slug=${encodeURIComponent(slug)}`);
                // On failure, only downgrade the initial "loading" state — a poll blip must not wipe
                // an already-rendered auction (functional update avoids the stale closure).
                if (!res.ok) { if (alive) setData((cur) => (cur === null ? false : cur)); return; }
                const body = await res.json();
                if (!alive || !body || !body.auction) return;
                setOffsetMs((body.serverNowMs || Date.now()) - Date.now());
                setData(body);
                // Passive outbid detection: someone topped my stored bid between polls.
                const mine = myBidRef.current;
                if (mine && body.auction.currentPriceCents > mine.amountCents) {
                    setBanner({ kind: "out", text: "Alguien pujó más alto… ¡puedes volver a intentarlo!" });
                    myBidRef.current = null;
                }
            } catch { if (alive) setData((cur) => (cur === null ? false : cur)); }
        };
        load();
        const t = setInterval(() => {
            if (typeof document === "undefined" || document.visibilityState === "visible") load();
        }, 15000);
        return () => { alive = false; clearInterval(t); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slug]);

    const submit = async (e) => {
        e.preventDefault();
        if (!data || !data.auction) return;
        setBanner(null);
        const cents = Math.round(parseFloat(String(amount).replace(",", ".")) * 100);
        if (!Number.isFinite(cents) || cents <= 0) {
            setBanner({ kind: "err", text: "Escribe un monto válido." });
            return;
        }
        setBusy(true);
        try {
            const res = await fetch(`${API}/public/bid`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    auction_id: data.auction.id,
                    bidder_name: name,
                    bidder_email: email,
                    amount_cents: cents,
                    hp,
                    elapsed: Date.now() - mountedAtRef.current,
                }),
            });
            const body = await res.json().catch(() => null);
            if (res.ok && body && body.success) {
                const st = readLs();
                st.profile = { name, email };
                st.bids = st.bids || {};
                st.bids[String(data.auction.id)] = { token: body.token, amountCents: cents };
                writeLs(st);
                if (body.isTop) {
                    myBidRef.current = { amountCents: cents };
                    setBanner({ kind: "win", text: `¡Vas ganando! Tu puja de ${fmtMoney(cents, data.currencySymbol)} es la más alta.` });
                } else {
                    myBidRef.current = null;
                    setBanner({ kind: "out", text: `Alguien pujó más alto… el precio actual es ${fmtMoney(body.currentPriceCents, data.currencySymbol)}.` });
                }
                setAmount("");
                // Refresh price/history/countdown right away (anti-snipe may have moved ends_at).
                try {
                    const r2 = await fetch(`${API}/public/auction?slug=${encodeURIComponent(slug)}`);
                    if (r2.ok) {
                        const b2 = await r2.json();
                        if (b2 && b2.auction) {
                            setOffsetMs((b2.serverNowMs || Date.now()) - Date.now());
                            setData(b2);
                        }
                    }
                } catch { /* keep current view */ }
            } else {
                setBanner({ kind: "err", text: (body && body.error) || "No se pudo registrar la puja. Inténtalo de nuevo." });
            }
        } catch {
            setBanner({ kind: "err", text: "Error de conexión. Inténtalo de nuevo." });
        } finally {
            setBusy(false);
        }
    };

    if (data === null) return <div className="wjau-empty">Cargando subasta…</div>;
    if (data === false) return <div className="wjau-empty">Subasta no disponible.</div>;

    const a = data.auction;
    const symbol = data.currencySymbol || "$";
    const notStarted = a.startsAtMs && Date.now() + offsetMs < a.startsAtMs;
    const canBid = !a.ended && a.status === "active" && !notStarted;

    return (
        <div className="wjau-detail">
            {onBack && <button type="button" className="wjau-back" onClick={onBack}>← Volver a las subastas</button>}
            <div className="wjau-detail-grid">
                <div>
                    {a.image_url ? (
                        <img src={a.image_url} alt={a.title} className="wjau-detail-img" decoding="async" />
                    ) : (
                        <div className="wjau-noimg" style={{ borderRadius: ".6rem" }}>Sin imagen</div>
                    )}
                    {a.description ? <p className="wjau-desc" style={{ marginTop: "1rem" }}>{a.description}</p> : null}
                </div>
                <div>
                    <span className={`wjau-badge ${a.ended ? "wjau-badge-end" : "wjau-badge-live"}`}>
                        {a.status === "cancelled" ? "Cancelada" : a.ended ? "Finalizada" : "En curso"}
                    </span>
                    <h3 className="wjau-title" style={{ fontSize: "1.4rem", margin: ".5rem 0 0" }}>{a.title}</h3>
                    <div className="wjau-price" style={{ fontSize: "2.2rem", marginTop: ".4rem" }}>{fmtMoney(a.currentPriceCents, symbol)}</div>
                    <div className="wjau-meta" style={{ marginTop: ".25rem" }}>
                        {a.bidCount} puja{a.bidCount === 1 ? "" : "s"}
                        {!a.ended && (
                            <>
                                {" · Termina en "}
                                <Countdown endsAtMs={a.endsAtMs} offsetMs={offsetMs} />
                            </>
                        )}
                    </div>

                    {a.status === "cancelled" ? (
                        <div className="wjau-banner wjau-banner-end">Esta subasta fue cancelada.</div>
                    ) : a.ended ? (
                        <div className="wjau-banner wjau-banner-end">
                            Subasta finalizada
                            {data.winner
                                ? <> — Ganador: <strong>{data.winner.name}</strong> con <strong>{fmtMoney(data.winner.amountCents, symbol)}</strong></>
                                : " — sin pujas."}
                        </div>
                    ) : notStarted ? (
                        <div className="wjau-banner wjau-banner-end">La subasta aún no comienza.</div>
                    ) : null}

                    {canBid && (
                        <form className="wjau-form" onSubmit={submit}>
                            <p className="wjau-section-t" style={{ margin: 0 }}>Haz tu puja</p>
                            <input className="wjau-input" type="text" placeholder="Tu nombre" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
                            <input className="wjau-input" type="email" placeholder="Tu correo electrónico" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={200} />
                            <input
                                className="wjau-input"
                                type="number"
                                step="0.01"
                                min="0"
                                placeholder={`Monto (≥ ${fmtMoney(a.minNextBidCents, symbol)})`}
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                required
                            />
                            <p className="wjau-hint">Puja mínima: {fmtMoney(a.minNextBidCents, symbol)} (precio actual + incremento de {fmtMoney(a.min_increment_cents, symbol)}).</p>
                            {/* Honeypot: hidden from humans; bots that fill it are rejected server-side. */}
                            <input className="wjau-hp" type="text" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} aria-hidden="true" />
                            <button type="submit" className="wjau-btn" disabled={busy}>{busy ? "Enviando…" : "Pujar"}</button>
                        </form>
                    )}

                    {banner && (
                        <div className={`wjau-banner ${banner.kind === "win" ? "wjau-banner-win" : banner.kind === "out" ? "wjau-banner-out" : "wjau-banner-err"}`}>
                            {banner.text}
                        </div>
                    )}

                    {data.bids && data.bids.length > 0 && (
                        <>
                            <p className="wjau-section-t">Historial de pujas</p>
                            <ul className="wjau-history">
                                {data.bids.map((b, i) => (
                                    <li key={`${b.amount_cents}-${i}`}>
                                        <span>{i === 0 ? "🏆 " : ""}{b.name}</span>
                                        <span className="wjau-h-amount">{fmtMoney(b.amount_cents, symbol)}</span>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

export const puckComponentDef = {
    category: "Comercio",
    fields: {
        auctionSlug: { type: "text", label: "Slug de subasta (vacío = cuadrícula de activas)" },
        columns: {
            type: "radio",
            label: "Columnas",
            options: [
                { label: "1", value: 1 },
                { label: "2", value: 2 },
                { label: "3", value: 3 },
            ],
        },
        accentColor: { type: "text", label: "Color de acento (ej. #b45309)" },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        auctionSlug: "",
        columns: 3,
        accentColor: "#b45309",
        elementId: "",
    },
};

export default function AuctionsPuck({ auctionSlug, columns, accentColor, elementId }) {
    const fixedSlug = String(auctionSlug || "").trim();
    const [openSlug, setOpenSlug] = useState("");
    const [list, setList] = useState(null); // null = loading, [] = loaded-empty
    const [symbol, setSymbol] = useState("$");
    const [offsetMs, setOffsetMs] = useState(0);

    useEffect(() => {
        if (fixedSlug) return; // single-auction mode never needs the list
        let alive = true;
        const load = async () => {
            try {
                const res = await fetch(`${API}/public/auctions?limit=24`);
                if (!res.ok) { if (alive) setList([]); return; }
                const body = await res.json();
                if (!alive || !body) return;
                setList(body.auctions || []);
                setSymbol(body.currencySymbol || "$");
                setOffsetMs((body.serverNowMs || Date.now()) - Date.now());
            } catch { if (alive) setList([]); }
        };
        load();
        const t = setInterval(() => {
            if (typeof document === "undefined" || document.visibilityState === "visible") load();
        }, 15000);
        return () => { alive = false; clearInterval(t); };
    }, [fixedSlug]);

    const colClass = Number(columns) === 1 ? "wjau-cols-1" : Number(columns) === 2 ? "wjau-cols-2" : "wjau-cols-3";

    return (
        <div id={elementId || undefined} className="wjau" style={{ "--wjau-accent": accentColor || "#b45309" }}>
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {fixedSlug ? (
                <AuctionDetail slug={fixedSlug} onBack={null} />
            ) : openSlug ? (
                <AuctionDetail slug={openSlug} onBack={() => setOpenSlug("")} />
            ) : list === null ? (
                <div className="wjau-empty">Cargando subastas…</div>
            ) : list.length === 0 ? (
                <div className="wjau-empty">No hay subastas disponibles por el momento.</div>
            ) : (
                <div className={`wjau-grid ${colClass}`}>
                    {list.map((a) => (
                        <AuctionCard key={a.id} a={a} symbol={symbol} offsetMs={offsetMs} onOpen={(slug) => setOpenSlug(slug)} />
                    ))}
                </div>
            )}
        </div>
    );
}
