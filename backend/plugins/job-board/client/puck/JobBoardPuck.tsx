// @ts-nocheck
"use client";

/**
 * Puck block "JobBoard" — public job listings with filters, a detail view and an application form.
 *
 * Registered via manifest.frontend.puckComponents; the generated registry composes
 * { ...puckComponentDef, render: default export }, so puckComponentDef must NOT carry a render.
 * Runs in the editor iframe AND the public page: data arrives via client-mount fetches against the
 * plugin's PUBLIC endpoints, guarded with res.ok (an inactive plugin 404s — the block degrades to
 * a quiet Spanish placeholder instead of crashing the page).
 *
 * Anti-spam wiring for the application form: a honeypot input (hp) hidden off-screen plus the
 * elapsed milliseconds since the form was shown — the server rejects sub-3s submissions.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

const API = "/api/v1/plugin/job-board";

const TYPE_LABELS = {
    "full-time": "Tiempo completo",
    "part-time": "Medio tiempo",
    "contract": "Contrato",
    "internship": "Prácticas",
    "temporary": "Temporal",
};

const PERIOD_LABELS = { hour: "por hora", month: "al mes", year: "al año" };

const STYLES = `
.wjjb-board { font-family: var(--wjs-font-family-base, inherit); color: var(--wjs-color-text, #111827); }
.wjjb-filters { display: flex; flex-wrap: wrap; gap: .6rem; margin-bottom: 1.1rem; align-items: center; }
.wjjb-search { flex: 1 1 220px; padding: .6rem .9rem; border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: .6rem; font-size: .95rem; background: var(--wjs-bg-surface, #fff); color: inherit; }
.wjjb-select { padding: .6rem .7rem; border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: .6rem; font-size: .9rem; background: var(--wjs-bg-surface, #fff); color: inherit; }
.wjjb-remote-toggle { display: inline-flex; align-items: center; gap: .4rem; font-size: .9rem; cursor: pointer; user-select: none; }
.wjjb-list { display: flex; flex-direction: column; gap: .8rem; }
.wjjb-card { border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: .8rem; padding: 1rem 1.2rem; background: var(--wjs-bg-surface, #fff); cursor: pointer; transition: border-color .15s, box-shadow .15s; text-align: left; width: 100%; }
.wjjb-card:hover { border-color: var(--wjjb-accent); box-shadow: 0 2px 10px rgba(0,0,0,.06); }
.wjjb-card-top { display: flex; flex-wrap: wrap; gap: .5rem .8rem; align-items: baseline; justify-content: space-between; }
.wjjb-title { font-size: 1.05rem; font-weight: 700; margin: 0; }
.wjjb-company { font-size: .9rem; color: var(--wjs-color-text-muted, #6b7280); margin-top: .15rem; }
.wjjb-meta { display: flex; flex-wrap: wrap; gap: .45rem; margin-top: .6rem; align-items: center; }
.wjjb-chip { display: inline-block; padding: .18rem .6rem; border-radius: 999px; font-size: .75rem; font-weight: 600; background: color-mix(in srgb, var(--wjjb-accent) 12%, transparent); color: var(--wjjb-accent); }
.wjjb-chip-remote { background: #ecfdf5; color: #047857; }
.wjjb-loc { font-size: .85rem; color: var(--wjs-color-text-muted, #6b7280); }
.wjjb-salary { font-size: .85rem; font-weight: 600; }
.wjjb-ago { font-size: .78rem; color: var(--wjs-color-text-muted, #9ca3af); white-space: nowrap; }
.wjjb-empty { padding: 2rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: .8rem; font-size: .9rem; }
.wjjb-detail { border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: .8rem; padding: 1.3rem 1.4rem; background: var(--wjs-bg-surface, #fff); }
.wjjb-back { background: none; border: none; color: var(--wjjb-accent); font-size: .9rem; cursor: pointer; padding: 0; margin-bottom: .8rem; font-weight: 600; }
.wjjb-section-h { font-size: .95rem; font-weight: 700; margin: 1.2rem 0 .4rem; }
.wjjb-pre { white-space: pre-line; font-size: .95rem; line-height: 1.6; margin: 0; }
.wjjb-apply-btn { display: inline-block; margin-top: 1.2rem; padding: .7rem 1.4rem; border: none; border-radius: .6rem; background: var(--wjjb-accent); color: #fff; font-weight: 700; font-size: .95rem; cursor: pointer; }
.wjjb-apply-btn:hover { filter: brightness(1.1); }
.wjjb-form { margin-top: 1.2rem; display: flex; flex-direction: column; gap: .7rem; max-width: 480px; }
.wjjb-form label { font-size: .8rem; font-weight: 600; color: var(--wjs-color-text-muted, #6b7280); display: block; margin-bottom: .2rem; }
.wjjb-input, .wjjb-textarea { width: 100%; padding: .6rem .8rem; border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: .6rem; font-size: .95rem; background: var(--wjs-bg-surface, #fff); color: inherit; font-family: inherit; }
.wjjb-textarea { min-height: 110px; resize: vertical; }
.wjjb-hp { position: absolute; left: -9999px; top: -9999px; height: 1px; width: 1px; overflow: hidden; }
.wjjb-err { background: #fef2f2; color: #b91c1c; padding: .6rem .9rem; border-radius: .6rem; font-size: .88rem; }
.wjjb-ok { background: #ecfdf5; color: #047857; padding: 1rem 1.2rem; border-radius: .8rem; font-size: .95rem; font-weight: 600; }
@media (max-width: 640px) { .wjjb-detail { padding: 1rem; } .wjjb-card { padding: .85rem 1rem; } }
`;

function fmtMoney(cents, symbol) {
    const n = (Number(cents) || 0) / 100;
    const s = n % 1 === 0
        ? n.toLocaleString("es")
        : n.toLocaleString("es", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${symbol}${s}`;
}

function salaryText(job, symbol) {
    const min = Number(job.salary_min_cents) || 0;
    const max = Number(job.salary_max_cents) || 0;
    if (!min && !max) return "";
    const period = PERIOD_LABELS[job.salary_period] || "al mes";
    if (min && max) return `${fmtMoney(min, symbol)} – ${fmtMoney(max, symbol)} ${period}`;
    if (min) return `Desde ${fmtMoney(min, symbol)} ${period}`;
    return `Hasta ${fmtMoney(max, symbol)} ${period}`;
}

function postedAgo(createdAt) {
    if (!createdAt) return "";
    const iso = String(createdAt);
    const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
    if (isNaN(d.getTime())) return "";
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return "hoy";
    if (days === 1) return "ayer";
    if (days < 30) return `hace ${days} días`;
    const months = Math.floor(days / 30);
    return months === 1 ? "hace 1 mes" : `hace ${months} meses`;
}

// Module-level components only — defining one inside another remounts it and steals input focus.

function JobCard({ job, symbol, showSalary, onOpen }) {
    const salary = showSalary ? salaryText(job, symbol) : "";
    return (
        <button type="button" className="wjjb-card" onClick={() => onOpen(job)}>
            <div className="wjjb-card-top">
                <div>
                    <h3 className="wjjb-title">{job.title}</h3>
                    {job.company ? <div className="wjjb-company">{job.company}</div> : null}
                </div>
                <span className="wjjb-ago">{postedAgo(job.created_at)}</span>
            </div>
            <div className="wjjb-meta">
                <span className="wjjb-chip">{TYPE_LABELS[job.type] || job.type}</span>
                {job.is_remote ? <span className="wjjb-chip wjjb-chip-remote">Remoto</span> : null}
                {job.location ? <span className="wjjb-loc">{job.location}</span> : null}
                {salary ? <span className="wjjb-salary">{salary}</span> : null}
            </div>
        </button>
    );
}

function ApplyForm({ job, onDone }) {
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [phone, setPhone] = useState("");
    const [coverLetter, setCoverLetter] = useState("");
    const [cvUrl, setCvUrl] = useState("");
    const [hp, setHp] = useState(""); // honeypot — humans never see or fill this
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const shownAtRef = useRef(Date.now());

    useEffect(() => { shownAtRef.current = Date.now(); }, []);

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            const res = await fetch(`${API}/public/apply`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    job_id: job.id,
                    name,
                    email,
                    phone,
                    cover_letter: coverLetter,
                    cv_url: cvUrl,
                    hp,
                    elapsed: Date.now() - shownAtRef.current,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(data.error || "No se pudo enviar la postulación. Intenta de nuevo.");
                return;
            }
            onDone();
        } catch {
            setError("No se pudo enviar la postulación. Revisa tu conexión e intenta de nuevo.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <form className="wjjb-form" onSubmit={submit}>
            <div>
                <label>Nombre completo *</label>
                <input className="wjjb-input" type="text" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
            </div>
            <div>
                <label>Email *</label>
                <input className="wjjb-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} />
            </div>
            <div>
                <label>Teléfono</label>
                <input className="wjjb-input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={50} />
            </div>
            <div>
                <label>Enlace a tu CV (LinkedIn, Drive…)</label>
                <input className="wjjb-input" type="url" value={cvUrl} onChange={(e) => setCvUrl(e.target.value)} placeholder="https://…" maxLength={500} />
            </div>
            <div>
                <label>Carta de presentación</label>
                <textarea className="wjjb-textarea" value={coverLetter} onChange={(e) => setCoverLetter(e.target.value)} maxLength={5000} placeholder="Cuéntanos por qué eres la persona indicada…" />
            </div>
            {/* Honeypot: off-screen, tabIndex -1, autocomplete off — bots fill it, humans cannot. */}
            <div className="wjjb-hp" aria-hidden="true">
                <label>No llenar este campo</label>
                <input type="text" value={hp} onChange={(e) => setHp(e.target.value)} tabIndex={-1} autoComplete="off" />
            </div>
            {error ? <div className="wjjb-err">{error}</div> : null}
            <button type="submit" className="wjjb-apply-btn" disabled={busy} style={{ marginTop: ".2rem" }}>
                {busy ? "Enviando…" : "Enviar postulación"}
            </button>
        </form>
    );
}

function JobDetail({ slug, symbol, showSalary, onBack }) {
    const [job, setJob] = useState(null);
    const [failed, setFailed] = useState(false);
    const [applying, setApplying] = useState(false);
    const [sent, setSent] = useState(false);

    useEffect(() => {
        let alive = true;
        setJob(null);
        setFailed(false);
        setApplying(false);
        setSent(false);
        fetch(`${API}/public/job?slug=${encodeURIComponent(slug)}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (!alive) return;
                if (data && data.job) setJob(data.job);
                else setFailed(true);
            })
            .catch(() => { if (alive) setFailed(true); });
        return () => { alive = false; };
    }, [slug]);

    if (failed) {
        return (
            <div className="wjjb-detail">
                <button type="button" className="wjjb-back" onClick={onBack}>← Volver a las vacantes</button>
                <div className="wjjb-empty">Esta vacante ya no está disponible.</div>
            </div>
        );
    }
    if (!job) return <div className="wjjb-empty">Cargando vacante…</div>;

    const salary = showSalary ? salaryText(job, symbol) : "";

    return (
        <div className="wjjb-detail">
            <button type="button" className="wjjb-back" onClick={onBack}>← Volver a las vacantes</button>
            <h2 className="wjjb-title" style={{ fontSize: "1.35rem" }}>{job.title}</h2>
            {job.company ? <div className="wjjb-company">{job.company}</div> : null}
            <div className="wjjb-meta">
                <span className="wjjb-chip">{TYPE_LABELS[job.type] || job.type}</span>
                {job.is_remote ? <span className="wjjb-chip wjjb-chip-remote">Remoto</span> : null}
                {job.location ? <span className="wjjb-loc">{job.location}</span> : null}
                {salary ? <span className="wjjb-salary">{salary}</span> : null}
                <span className="wjjb-ago">{postedAgo(job.created_at)}</span>
            </div>

            <h3 className="wjjb-section-h">Descripción</h3>
            <p className="wjjb-pre">{job.description}</p>

            {job.requirements ? (
                <>
                    <h3 className="wjjb-section-h">Requisitos</h3>
                    <p className="wjjb-pre">{job.requirements}</p>
                </>
            ) : null}

            {sent ? (
                <div className="wjjb-ok" style={{ marginTop: "1.2rem" }}>Postulación enviada. ¡Éxitos!</div>
            ) : applying ? (
                <ApplyForm job={job} onDone={() => setSent(true)} />
            ) : (
                <button type="button" className="wjjb-apply-btn" onClick={() => setApplying(true)}>Postularme</button>
            )}
        </div>
    );
}

export const puckComponentDef = {
    category: "Empleos",
    fields: {
        showFilters: {
            type: "radio",
            label: "Mostrar filtros",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        maxJobs: { type: "number", label: "Máximo de vacantes" },
        accentColor: { type: "text", label: "Color de acento (hex)" },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        showFilters: true,
        maxJobs: 12,
        accentColor: "#2563eb",
        elementId: "",
    },
};

export default function JobBoardPuck({ showFilters, maxJobs, accentColor, elementId }) {
    const [jobs, setJobs] = useState(null); // null = loading, [] = loaded-empty
    const [symbol, setSymbol] = useState("$");
    const [showSalary, setShowSalary] = useState(true);
    const [search, setSearch] = useState("");
    const [typeFilter, setTypeFilter] = useState("");
    const [remoteOnly, setRemoteOnly] = useState(false);
    const [openSlug, setOpenSlug] = useState("");

    const limit = Math.max(1, Math.min(200, Number(maxJobs) || 12));

    const query = useMemo(() => {
        const p = new URLSearchParams();
        p.set("limit", String(limit));
        if (search.trim()) p.set("search", search.trim());
        if (typeFilter) p.set("type", typeFilter);
        if (remoteOnly) p.set("remote", "1");
        return p.toString();
    }, [limit, search, typeFilter, remoteOnly]);

    useEffect(() => {
        let alive = true;
        // Small debounce so typing in the search box doesn't fire a request per keystroke.
        const t = setTimeout(() => {
            fetch(`${API}/public/jobs?${query}`)
                .then((res) => (res.ok ? res.json() : null))
                .then((data) => {
                    if (!alive) return;
                    setJobs((data && data.jobs) || []);
                    if (data && data.currencySymbol) setSymbol(data.currencySymbol);
                    if (data) setShowSalary(data.showSalary !== false);
                })
                .catch(() => { if (alive) setJobs([]); });
        }, 250);
        return () => { alive = false; clearTimeout(t); };
    }, [query]);

    const accent = /^#[0-9a-fA-F]{3,8}$/.test(String(accentColor || "")) ? accentColor : "#2563eb";

    return (
        <div id={elementId || undefined} className="wjjb-board" style={{ "--wjjb-accent": accent }}>
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {openSlug ? (
                <JobDetail slug={openSlug} symbol={symbol} showSalary={showSalary} onBack={() => setOpenSlug("")} />
            ) : (
                <>
                    {showFilters ? (
                        <div className="wjjb-filters">
                            <input
                                type="search"
                                className="wjjb-search"
                                placeholder="Buscar por título, empresa o lugar…"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                            <select className="wjjb-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                                <option value="">Todos los tipos</option>
                                <option value="full-time">Tiempo completo</option>
                                <option value="part-time">Medio tiempo</option>
                                <option value="contract">Contrato</option>
                                <option value="internship">Prácticas</option>
                                <option value="temporary">Temporal</option>
                            </select>
                            <label className="wjjb-remote-toggle">
                                <input type="checkbox" checked={remoteOnly} onChange={(e) => setRemoteOnly(e.target.checked)} />
                                Solo remoto
                            </label>
                        </div>
                    ) : null}
                    {jobs === null ? (
                        <div className="wjjb-empty">Cargando vacantes…</div>
                    ) : jobs.length === 0 ? (
                        <div className="wjjb-empty">
                            {search.trim() || typeFilter || remoteOnly
                                ? "No hay vacantes que coincidan con los filtros."
                                : "No hay vacantes publicadas por el momento."}
                        </div>
                    ) : (
                        <div className="wjjb-list">
                            {jobs.map((job) => (
                                <JobCard key={job.id} job={job} symbol={symbol} showSalary={showSalary} onOpen={(j) => setOpenSlug(j.slug)} />
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
