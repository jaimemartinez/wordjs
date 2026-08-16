// @ts-nocheck
"use client";

/**
 * Verso block "EventsCalendar" — upcoming-events list OR monthly calendar grid.
 *
 * Registered via manifest.frontend.versoComponents; the generated versoPluginRegistry composes
 * { ...versoComponentDef, render: default export }, so versoComponentDef must NOT carry a render.
 * Runs in the editor iframe AND on the public page, so data arrives via a client-mount fetch
 * against the plugin's PUBLIC endpoint, guarded with res.ok (an inactive plugin 404s — the block
 * degrades to a quiet placeholder instead of crashing the page).
 */

import React, { useEffect, useMemo, useState } from "react";

const STYLES = `
.wjec-wrap { width: 100%; max-width: 100%; font-family: var(--wjs-font-family-base, inherit); color: var(--wjs-color-text, #111827); }
.wjec-empty { padding: 1.5rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.5rem); font-size: .9rem; }

/* ---- list mode ---- */
.wjec-list { display: flex; flex-direction: column; gap: .75rem; }
.wjec-card { display: flex; gap: 1rem; align-items: flex-start; padding: 1rem; background: var(--wjs-bg-surface, #fff); border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.75rem); }
.wjec-badge { flex: 0 0 auto; width: 3.4rem; padding: .45rem 0 .4rem; text-align: center; border-radius: .65rem; color: #fff; line-height: 1.05; }
.wjec-badge-day { display: block; font-size: 1.45rem; font-weight: 800; }
.wjec-badge-month { display: block; font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; opacity: .9; }
.wjec-body { min-width: 0; flex: 1 1 auto; }
.wjec-title { margin: 0 0 .2rem; font-size: 1.02rem; font-weight: 700; line-height: 1.3; }
.wjec-meta { display: flex; flex-wrap: wrap; gap: .35rem 1rem; font-size: .82rem; color: var(--wjs-color-text-muted, #6b7280); }
.wjec-meta-item { display: inline-flex; align-items: center; gap: .3rem; }
.wjec-pin { flex: 0 0 auto; }
.wjec-desc { margin: .45rem 0 0; font-size: .85rem; color: var(--wjs-color-text-muted, #6b7280); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.wjec-more { display: inline-block; margin-top: .45rem; font-size: .8rem; font-weight: 700; color: var(--wjs-color-primary, #3b82f6); text-decoration: none; }
.wjec-more:hover { text-decoration: underline; }

/* ---- calendar mode ---- */
.wjec-cal { background: var(--wjs-bg-surface, #fff); border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.75rem); padding: 1rem; }
.wjec-cal-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-bottom: .75rem; }
.wjec-cal-month { font-size: 1.05rem; font-weight: 800; text-transform: capitalize; }
.wjec-cal-nav { display: flex; gap: .35rem; }
.wjec-cal-btn { width: 2rem; height: 2rem; border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: .55rem; background: transparent; color: inherit; font-size: 1.05rem; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.wjec-cal-btn:hover { background: var(--wjs-bg-muted, #f3f4f6); }
.wjec-cal-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 3px; }
.wjec-cal-dow { text-align: center; font-size: .68rem; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; color: var(--wjs-color-text-muted, #6b7280); padding: .3rem 0; }
.wjec-cal-day { position: relative; min-height: 3.1rem; padding: .3rem .35rem; border: none; border-radius: .5rem; background: transparent; color: inherit; font: inherit; text-align: left; display: flex; flex-direction: column; gap: .2rem; }
.wjec-cal-day.wjec-out { visibility: hidden; }
button.wjec-cal-day { cursor: pointer; background: var(--wjs-bg-muted, #f3f4f6); }
button.wjec-cal-day:hover { background: var(--wjs-border-subtle, #e5e7eb); }
.wjec-cal-num { font-size: .8rem; font-weight: 600; line-height: 1; }
.wjec-cal-day.wjec-today .wjec-cal-num { display: inline-flex; align-items: center; justify-content: center; width: 1.35rem; height: 1.35rem; border-radius: 50%; background: var(--wjs-color-primary, #3b82f6); color: #fff; }
.wjec-cal-day.wjec-selected { outline: 2px solid var(--wjs-color-primary, #3b82f6); outline-offset: -2px; }
.wjec-dots { display: flex; flex-wrap: wrap; gap: 3px; }
.wjec-dot { width: 6px; height: 6px; border-radius: 50%; }
.wjec-dot-more { font-size: .6rem; line-height: .6rem; color: var(--wjs-color-text-muted, #6b7280); }
.wjec-day-panel { margin-top: 1rem; border-top: 1px solid var(--wjs-border-subtle, #e5e7eb); padding-top: 1rem; }
.wjec-day-title { margin: 0 0 .6rem; font-size: .85rem; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: var(--wjs-color-text-muted, #6b7280); }
.wjec-loading { font-size: .8rem; color: var(--wjs-color-text-muted, #6b7280); padding: .5rem 0; }

@media (max-width: 640px) {
  .wjec-card { padding: .75rem; gap: .75rem; }
  .wjec-badge { width: 2.9rem; }
  .wjec-badge-day { font-size: 1.2rem; }
  .wjec-title { font-size: .95rem; }
  .wjec-cal { padding: .6rem; }
  .wjec-cal-day { min-height: 2.4rem; padding: .2rem .25rem; }
  .wjec-cal-num { font-size: .7rem; }
  .wjec-cal-dow { font-size: .6rem; }
  .wjec-dot { width: 5px; height: 5px; }
}
`;

const MONTHS_LONG = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DOW = ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"];

const pad2 = (n) => (n < 10 ? "0" + n : String(n));

/**
 * Parse the stored local-naive ISO ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm') as LOCAL time.
 * new Date('YYYY-MM-DD') would parse as UTC midnight and shift a day in negative-offset
 * timezones, so the Date is constructed from parts instead.
 */
function parseIso(s) {
    const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
}

const fmtTime = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function fmtEventTime(ev) {
    if (ev.all_day) return "Todo el día";
    const start = parseIso(ev.starts_at);
    if (!start) return "";
    const end = ev.ends_at ? parseIso(ev.ends_at) : null;
    if (!end) return fmtTime(start);
    return fmtTime(start) + " – " + fmtTime(end);
}

// Small inline location pin (no external assets — CSP only allows own/inline scripts+styles).
function WjecPin() {
    return (
        <svg className="wjec-pin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0Z" />
            <circle cx="12" cy="10" r="3" />
        </svg>
    );
}

// Module-level (never define a component inside a component — remounting steals focus).
function WjecEventCard({ ev, showDescription }) {
    const start = parseIso(ev.starts_at);
    return (
        <div className="wjec-card">
            <div className="wjec-badge" style={{ backgroundColor: /^#[0-9a-fA-F]{6}$/.test(ev.color || "") ? ev.color : "#3b82f6" }}>
                <span className="wjec-badge-day">{start ? start.getDate() : "?"}</span>
                <span className="wjec-badge-month">{start ? MONTHS_SHORT[start.getMonth()] : ""}</span>
            </div>
            <div className="wjec-body">
                <h3 className="wjec-title">{ev.title}</h3>
                <div className="wjec-meta">
                    <span className="wjec-meta-item">{fmtEventTime(ev)}</span>
                    {ev.location && (
                        <span className="wjec-meta-item"><WjecPin />{ev.location}</span>
                    )}
                </div>
                {showDescription && ev.description && <p className="wjec-desc">{ev.description}</p>}
                {ev.url && (
                    <a className="wjec-more" href={ev.url} target="_blank" rel="noopener noreferrer">Más info →</a>
                )}
            </div>
        </div>
    );
}

function WjecList({ maxEvents, showDescription }) {
    const [events, setEvents] = useState(null); // null = loading, [] = loaded-empty / unavailable

    const limit = Math.max(1, Math.min(200, Number(maxEvents) || 6));

    useEffect(() => {
        let alive = true;
        fetch(`/api/v1/plugin/events-calendar/public/events?limit=${limit}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => { if (alive) setEvents((data && data.events) || []); })
            .catch(() => { if (alive) setEvents([]); });
        return () => { alive = false; };
    }, [limit]);

    if (events === null) return <div className="wjec-empty">Cargando eventos…</div>;
    if (events.length === 0) return <div className="wjec-empty">No hay eventos próximos.</div>;
    return (
        <div className="wjec-list">
            {events.map((ev) => <WjecEventCard key={ev.id} ev={ev} showDescription={showDescription} />)}
        </div>
    );
}

function WjecCalendar({ showDescription }) {
    const today = useMemo(() => new Date(), []);
    const [year, setYear] = useState(today.getFullYear());
    const [month, setMonth] = useState(today.getMonth()); // 0-11
    const [events, setEvents] = useState(null);            // null = loading
    const [unavailable, setUnavailable] = useState(false); // plugin inactive (404)
    const [selectedDay, setSelectedDay] = useState(null);  // 'YYYY-MM-DD'

    const daysInMonth = new Date(year, month + 1, 0).getDate();

    useEffect(() => {
        let alive = true;
        setEvents(null);
        setSelectedDay(null);
        const from = `${year}-${pad2(month + 1)}-01`;
        const to = `${year}-${pad2(month + 1)}-${pad2(daysInMonth)}`;
        fetch(`/api/v1/plugin/events-calendar/public/events?from=${from}&to=${to}&limit=200`)
            .then((res) => {
                if (res.status === 404) { if (alive) setUnavailable(true); return null; }
                return res.ok ? res.json() : null;
            })
            .then((data) => { if (alive) setEvents((data && data.events) || []); })
            .catch(() => { if (alive) setEvents([]); });
        return () => { alive = false; };
    }, [year, month, daysInMonth]);

    // Group the month's events by local day key 'YYYY-MM-DD'.
    const byDay = useMemo(() => {
        const map = {};
        for (const ev of events || []) {
            const key = String(ev.starts_at || "").slice(0, 10);
            if (!map[key]) map[key] = [];
            map[key].push(ev);
        }
        return map;
    }, [events]);

    if (unavailable) return <div className="wjec-empty">El calendario de eventos no está disponible.</div>;

    const move = (delta) => {
        const d = new Date(year, month + delta, 1);
        setYear(d.getFullYear());
        setMonth(d.getMonth());
    };

    // Monday-first offset: getDay() is 0=Sunday..6=Saturday.
    const startOffset = (new Date(year, month, 1).getDay() + 6) % 7;
    const todayKey = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;

    const cells = [];
    for (let i = 0; i < startOffset; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);

    const selectedEvents = selectedDay ? byDay[selectedDay] || [] : [];
    const selectedDate = selectedDay ? parseIso(selectedDay) : null;

    return (
        <div className="wjec-cal">
            <div className="wjec-cal-head">
                <span className="wjec-cal-month">{MONTHS_LONG[month]} {year}</span>
                <span className="wjec-cal-nav">
                    <button type="button" className="wjec-cal-btn" aria-label="Mes anterior" onClick={() => move(-1)}>‹</button>
                    <button type="button" className="wjec-cal-btn" aria-label="Mes siguiente" onClick={() => move(1)}>›</button>
                </span>
            </div>
            <div className="wjec-cal-grid">
                {DOW.map((d) => <div key={d} className="wjec-cal-dow">{d}</div>)}
                {cells.map((d, i) => {
                    if (d === null) return <div key={`x${i}`} className="wjec-cal-day wjec-out" aria-hidden="true" />;
                    const key = `${year}-${pad2(month + 1)}-${pad2(d)}`;
                    const dayEvents = byDay[key] || [];
                    const classes = [
                        "wjec-cal-day",
                        key === todayKey ? "wjec-today" : "",
                        key === selectedDay ? "wjec-selected" : "",
                    ].filter(Boolean).join(" ");
                    const inner = (
                        <>
                            <span className="wjec-cal-num">{d}</span>
                            {dayEvents.length > 0 && (
                                <span className="wjec-dots">
                                    {dayEvents.slice(0, 4).map((ev) => (
                                        <span key={ev.id} className="wjec-dot" style={{ backgroundColor: /^#[0-9a-fA-F]{6}$/.test(ev.color || "") ? ev.color : "#3b82f6" }} />
                                    ))}
                                    {dayEvents.length > 4 && <span className="wjec-dot-more">+{dayEvents.length - 4}</span>}
                                </span>
                            )}
                        </>
                    );
                    return dayEvents.length > 0 ? (
                        <button
                            key={key}
                            type="button"
                            className={classes}
                            aria-label={`${d} de ${MONTHS_LONG[month]} — ${dayEvents.length} evento${dayEvents.length === 1 ? "" : "s"}`}
                            onClick={() => setSelectedDay(selectedDay === key ? null : key)}
                        >
                            {inner}
                        </button>
                    ) : (
                        <div key={key} className={classes}>{inner}</div>
                    );
                })}
            </div>
            {events === null && <div className="wjec-loading">Cargando eventos…</div>}
            {selectedDay && selectedEvents.length > 0 && (
                <div className="wjec-day-panel">
                    <h4 className="wjec-day-title">
                        Eventos del {selectedDate ? `${selectedDate.getDate()} de ${MONTHS_LONG[selectedDate.getMonth()]}` : selectedDay}
                    </h4>
                    <div className="wjec-list">
                        {selectedEvents.map((ev) => <WjecEventCard key={ev.id} ev={ev} showDescription={showDescription} />)}
                    </div>
                </div>
            )}
        </div>
    );
}

export const versoComponentDef = {
    category: "Eventos",
    fields: {
        mode: {
            type: "radio",
            label: "Modo",
            options: [
                { label: "Lista próximos", value: "list" },
                { label: "Calendario mensual", value: "calendar" },
            ],
        },
        maxEvents: { type: "number", label: "Cantidad de eventos (lista)" },
        showDescription: {
            type: "radio",
            label: "Mostrar descripción",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        mode: "list",
        maxEvents: 6,
        showDescription: true,
        elementId: "",
    },
};

export default function EventsCalendarVerso({ mode, maxEvents, showDescription, elementId }) {
    return (
        <div id={elementId || undefined} className="wjec-wrap">
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {mode === "calendar" ? (
                <WjecCalendar showDescription={showDescription} />
            ) : (
                <WjecList maxEvents={maxEvents} showDescription={showDescription} />
            )}
        </div>
    );
}
