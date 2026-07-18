// @ts-nocheck
"use client";

/**
 * Admin page for the Job Board plugin (/admin/plugin/jobs).
 * Tabs: Vacantes (CRUD + publish toggle), Postulaciones (inbox with statuses, cover-letter modal,
 * CSV export) and Configuración. Salary inputs are decimals in the UI and INTEGER CENTS on the
 * wire/database. API calls go through the host's api helpers (session cookie).
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";

const BASE = "/plugin/job-board";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnGhostCls = "px-5 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";

const TYPE_LABELS = {
    "full-time": "Tiempo completo",
    "part-time": "Medio tiempo",
    "contract": "Contrato",
    "internship": "Prácticas",
    "temporary": "Temporal",
};
const PERIOD_LABELS = { hour: "Por hora", month: "Al mes", year: "Al año" };
const STATUS_LABELS = { new: "Nueva", reviewed: "Revisada", shortlisted: "Preseleccionada", rejected: "Rechazada" };
const STATUS_COLORS = {
    new: "bg-blue-50 text-blue-700",
    reviewed: "bg-gray-100 text-gray-600",
    shortlisted: "bg-green-50 text-green-700",
    rejected: "bg-red-50 text-red-600",
};

const centsToInput = (cents) => {
    const n = (Number(cents) || 0) / 100;
    return n > 0 ? String(n) : "";
};
const inputToCents = (v) => {
    const n = parseFloat(String(v).replace(",", "."));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};
const fmtDate = (iso) => {
    if (!iso) return "";
    const s = String(iso);
    const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? s : d.toLocaleString();
};

// ---- Vacante create/edit modal (module level — never define a component inside a component) ----
function JobModal({ initial, onClose, onSaved }) {
    const [form, setForm] = useState(() => ({
        title: initial?.title || "",
        company: initial?.company || "",
        location: initial?.location || "",
        type: initial?.type || "full-time",
        is_remote: !!initial?.is_remote,
        salaryMin: centsToInput(initial?.salary_min_cents),
        salaryMax: centsToInput(initial?.salary_max_cents),
        salary_period: initial?.salary_period || "month",
        description: initial?.description || "",
        requirements: initial?.requirements || "",
        apply_email: initial?.apply_email || "",
        is_published: initial ? !!initial.is_published : true,
        expires_at: initial?.expires_at || "",
    }));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const set = (k) => (e) => {
        const val = e.target.type === "checkbox" ? e.target.checked : e.target.value;
        setForm((f) => ({ ...f, [k]: val }));
    };

    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            const body = {
                title: form.title,
                company: form.company,
                location: form.location,
                type: form.type,
                is_remote: form.is_remote ? 1 : 0,
                salary_min_cents: inputToCents(form.salaryMin),
                salary_max_cents: inputToCents(form.salaryMax),
                salary_period: form.salary_period,
                description: form.description,
                requirements: form.requirements,
                apply_email: form.apply_email,
                is_published: form.is_published ? 1 : 0,
                expires_at: form.expires_at,
            };
            if (initial?.id) await apiPut(`${BASE}/jobs/${initial.id}`, body);
            else await apiPost(`${BASE}/jobs`, body);
            onSaved();
        } catch (err) {
            setError(err?.message || String(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
            <form
                onSubmit={save}
                onClick={(e) => e.stopPropagation()}
                className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 sm:p-8 space-y-4"
            >
                <h2 className="text-xl font-black text-gray-900 italic tracking-tighter">
                    {initial?.id ? "Editar vacante" : "Nueva vacante"}
                </h2>
                <div>
                    <label className={labelCls}>Título *</label>
                    <input type="text" value={form.title} onChange={set("title")} className={inputCls} required maxLength={200} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Empresa</label>
                        <input type="text" value={form.company} onChange={set("company")} className={inputCls} maxLength={200} />
                    </div>
                    <div>
                        <label className={labelCls}>Ubicación</label>
                        <input type="text" value={form.location} onChange={set("location")} className={inputCls} maxLength={200} />
                    </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
                    <div>
                        <label className={labelCls}>Tipo</label>
                        <select value={form.type} onChange={set("type")} className={inputCls}>
                            {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                    </div>
                    <label className="flex items-center gap-2 pb-3 text-sm font-bold text-gray-600 cursor-pointer select-none">
                        <input type="checkbox" checked={form.is_remote} onChange={set("is_remote")} />
                        Trabajo remoto
                    </label>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                        <label className={labelCls}>Salario mín.</label>
                        <input type="number" min="0" step="0.01" value={form.salaryMin} onChange={set("salaryMin")} className={inputCls} placeholder="0 = no mostrar" />
                    </div>
                    <div>
                        <label className={labelCls}>Salario máx.</label>
                        <input type="number" min="0" step="0.01" value={form.salaryMax} onChange={set("salaryMax")} className={inputCls} placeholder="0 = no mostrar" />
                    </div>
                    <div>
                        <label className={labelCls}>Periodo</label>
                        <select value={form.salary_period} onChange={set("salary_period")} className={inputCls}>
                            {Object.entries(PERIOD_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                    </div>
                </div>
                <div>
                    <label className={labelCls}>Descripción *</label>
                    <textarea value={form.description} onChange={set("description")} className={`${inputCls} min-h-[120px]`} required />
                </div>
                <div>
                    <label className={labelCls}>Requisitos</label>
                    <textarea value={form.requirements} onChange={set("requirements")} className={`${inputCls} min-h-[80px]`} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Email para postulaciones</label>
                        <input type="email" value={form.apply_email} onChange={set("apply_email")} className={inputCls} placeholder="(vacío = email de configuración)" maxLength={254} />
                    </div>
                    <div>
                        <label className={labelCls}>Expira</label>
                        <input type="date" value={form.expires_at} onChange={set("expires_at")} className={inputCls} />
                        <p className="text-[11px] text-gray-400 mt-1">Vacía = nunca expira.</p>
                    </div>
                </div>
                <label className="flex items-center gap-2 text-sm font-bold text-gray-600 cursor-pointer select-none">
                    <input type="checkbox" checked={form.is_published} onChange={set("is_published")} />
                    Publicada
                </label>
                {error && <div className="text-sm px-4 py-3 rounded-xl bg-red-50 text-red-600">{error}</div>}
                <div className="flex justify-end gap-3 pt-2">
                    <button type="button" onClick={onClose} className={btnGhostCls}>Cancelar</button>
                    <button type="submit" disabled={busy} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                </div>
            </form>
        </div>
    );
}

// ---- Cover letter modal ------------------------------------------------------------------------
function CoverLetterModal({ application, onClose }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
            <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-3xl shadow-2xl w-full max-w-xl max-h-[85vh] overflow-y-auto p-6 sm:p-8">
                <h2 className="text-lg font-black text-gray-900 italic tracking-tighter mb-1">Carta de presentación</h2>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">
                    {application.name} · {application.email}
                </p>
                <p className="text-sm text-gray-700 whitespace-pre-line leading-relaxed">
                    {application.cover_letter || "(sin carta de presentación)"}
                </p>
                <div className="flex justify-end mt-6">
                    <button type="button" onClick={onClose} className={btnGhostCls}>Cerrar</button>
                </div>
            </div>
        </div>
    );
}

// ---- Vacantes tab --------------------------------------------------------------------------------
function JobsTab({ jobs, onReload, onMessage }) {
    const [modalJob, setModalJob] = useState(undefined); // undefined = closed, null = new, object = edit

    const togglePublish = async (job) => {
        try {
            await apiPost(`${BASE}/jobs/${job.id}/publish`, { is_published: job.is_published ? 0 : 1 });
            onReload();
        } catch (err) {
            onMessage(`Error: ${err?.message || err}`);
        }
    };

    const remove = async (job) => {
        if (!window.confirm(`¿Eliminar la vacante "${job.title}" y todas sus postulaciones?`)) return;
        try {
            await apiDelete(`${BASE}/jobs/${job.id}`);
            onReload();
            onMessage("Vacante eliminada.");
        } catch (err) {
            onMessage(`Error: ${err?.message || err}`);
        }
    };

    const isExpired = (job) => !!(job.expires_at && job.expires_at < new Date().toISOString().slice(0, 10));

    return (
        <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
                <h2 className="font-bold text-gray-800">Vacantes ({jobs.length})</h2>
                <button type="button" onClick={() => setModalJob(null)} className={btnCls}>Nueva vacante</button>
            </div>
            {jobs.length === 0 ? (
                <p className="text-sm text-gray-400">Aún no hay vacantes — crea la primera.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                <th className="py-3 pr-4">Título</th>
                                <th className="py-3 pr-4">Tipo</th>
                                <th className="py-3 pr-4">Ubicación</th>
                                <th className="py-3 pr-4 text-right">Vistas</th>
                                <th className="py-3 pr-4 text-right">Postulaciones</th>
                                <th className="py-3 pr-4">Publicada</th>
                                <th className="py-3 pr-4">Expira</th>
                                <th className="py-3"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {jobs.map((job) => (
                                <tr key={job.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                                    <td className="py-3 pr-4">
                                        <span className="font-bold text-gray-800">{job.title}</span>
                                        {job.company ? <span className="text-gray-400"> · {job.company}</span> : null}
                                    </td>
                                    <td className="py-3 pr-4">
                                        <span className="inline-block px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[11px] font-bold">
                                            {TYPE_LABELS[job.type] || job.type}
                                        </span>
                                        {job.is_remote ? (
                                            <span className="inline-block ml-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 text-[11px] font-bold">Remoto</span>
                                        ) : null}
                                    </td>
                                    <td className="py-3 pr-4 text-gray-500">{job.location || "—"}</td>
                                    <td className="py-3 pr-4 text-right text-gray-500">{job.views || 0}</td>
                                    <td className="py-3 pr-4 text-right">
                                        <span className="font-bold text-gray-700">{job.app_count || 0}</span>
                                        {job.new_count > 0 && (
                                            <span className="ml-1 inline-block px-1.5 py-0.5 rounded-full bg-blue-600 text-white text-[10px] font-black">
                                                {job.new_count} nuevas
                                            </span>
                                        )}
                                    </td>
                                    <td className="py-3 pr-4">
                                        <button
                                            type="button"
                                            onClick={() => togglePublish(job)}
                                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${job.is_published ? "bg-green-500" : "bg-gray-300"}`}
                                            title={job.is_published ? "Publicada — clic para ocultar" : "Oculta — clic para publicar"}
                                        >
                                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${job.is_published ? "translate-x-6" : "translate-x-1"}`} />
                                        </button>
                                    </td>
                                    <td className="py-3 pr-4 text-gray-500">
                                        {job.expires_at ? (
                                            <span className={isExpired(job) ? "text-red-500 font-bold" : ""}>{job.expires_at}{isExpired(job) ? " (expirada)" : ""}</span>
                                        ) : "Nunca"}
                                    </td>
                                    <td className="py-3 text-right whitespace-nowrap">
                                        <button type="button" onClick={() => setModalJob(job)} className="text-blue-600 hover:text-blue-800 font-bold text-xs uppercase tracking-widest mr-3">Editar</button>
                                        <button type="button" onClick={() => remove(job)} className="text-red-500 hover:text-red-700 font-bold text-xs uppercase tracking-widest">Eliminar</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {modalJob !== undefined && (
                <JobModal
                    initial={modalJob}
                    onClose={() => setModalJob(undefined)}
                    onSaved={() => { setModalJob(undefined); onReload(); onMessage("Vacante guardada."); }}
                />
            )}
        </div>
    );
}

// ---- Postulaciones tab -----------------------------------------------------------------------------
function ApplicationsTab({ jobs, onMessage, onCountsChange }) {
    const [applications, setApplications] = useState([]);
    const [counts, setCounts] = useState({ new: 0, total: 0 });
    const [jobFilter, setJobFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [letterApp, setLetterApp] = useState(null);
    const [loading, setLoading] = useState(true);

    const load = async () => {
        setLoading(true);
        try {
            const p = new URLSearchParams();
            if (jobFilter) p.set("job_id", jobFilter);
            if (statusFilter) p.set("status", statusFilter);
            const data = await api(`${BASE}/applications?${p.toString()}`);
            setApplications(data.applications || []);
            setCounts(data.counts || { new: 0, total: 0 });
            if (onCountsChange) onCountsChange(data.counts || {});
        } catch (err) {
            onMessage(`Error: ${err?.message || err}`);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { load(); }, [jobFilter, statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

    const setStatus = async (app, status) => {
        try {
            await apiPost(`${BASE}/applications/${app.id}/status`, { status });
            load();
        } catch (err) {
            onMessage(`Error: ${err?.message || err}`);
        }
    };

    const remove = async (app) => {
        if (!window.confirm(`¿Eliminar la postulación de ${app.name}?`)) return;
        try {
            await apiDelete(`${BASE}/applications/${app.id}`);
            load();
            onMessage("Postulación eliminada.");
        } catch (err) {
            onMessage(`Error: ${err?.message || err}`);
        }
    };

    const exportCsv = async () => {
        try {
            const p = new URLSearchParams();
            if (jobFilter) p.set("job_id", jobFilter);
            if (statusFilter) p.set("status", statusFilter);
            // The isolate JSON-encodes string bodies, so the server returns { csv } and the
            // client builds the downloadable file itself.
            const data = await api(`${BASE}/applications/export?${p.toString()}`);
            const blob = new Blob([data.csv || ""], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = data.filename || "postulaciones.csv";
            a.click();
            URL.revokeObjectURL(url);
            onMessage(`Exportadas ${data.count || 0} postulaciones.`);
        } catch (err) {
            onMessage(`Error al exportar: ${err?.message || err}`);
        }
    };

    return (
        <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
                <h2 className="font-bold text-gray-800">
                    Postulaciones
                    {counts.new > 0 && (
                        <span className="ml-2 inline-block px-2 py-0.5 rounded-full bg-blue-600 text-white text-[11px] font-black align-middle">
                            {counts.new} nuevas
                        </span>
                    )}
                </h2>
                <div className="flex flex-wrap items-center gap-3">
                    <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)} className="px-3 py-2 bg-gray-50 border-2 border-gray-100 rounded-xl text-sm font-medium outline-none">
                        <option value="">Todas las vacantes</option>
                        {jobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}
                    </select>
                    <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-3 py-2 bg-gray-50 border-2 border-gray-100 rounded-xl text-sm font-medium outline-none">
                        <option value="">Todos los estados</option>
                        {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <button type="button" onClick={exportCsv} className={btnGhostCls}>Exportar CSV</button>
                </div>
            </div>
            {loading ? (
                <p className="text-sm text-gray-400">Cargando…</p>
            ) : applications.length === 0 ? (
                <p className="text-sm text-gray-400">No hay postulaciones con estos filtros.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                <th className="py-3 pr-4">Candidato</th>
                                <th className="py-3 pr-4">Vacante</th>
                                <th className="py-3 pr-4">CV</th>
                                <th className="py-3 pr-4">Carta</th>
                                <th className="py-3 pr-4">Estado</th>
                                <th className="py-3 pr-4">Fecha</th>
                                <th className="py-3"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {applications.map((app) => (
                                <tr key={app.id} className={`border-b border-gray-50 hover:bg-gray-50/50 ${app.status === "new" ? "bg-blue-50/30" : ""}`}>
                                    <td className="py-3 pr-4">
                                        <div className="font-bold text-gray-800">{app.name}</div>
                                        <div className="text-gray-400 text-xs">
                                            <a href={`mailto:${app.email}`} className="hover:text-blue-600">{app.email}</a>
                                            {app.phone ? ` · ${app.phone}` : ""}
                                        </div>
                                    </td>
                                    <td className="py-3 pr-4 text-gray-500">{app.job_title || `#${app.job_id}`}</td>
                                    <td className="py-3 pr-4">
                                        {app.cv_url ? (
                                            <a href={app.cv_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 font-bold text-xs uppercase tracking-widest">Ver CV</a>
                                        ) : <span className="text-gray-300">—</span>}
                                    </td>
                                    <td className="py-3 pr-4">
                                        {app.cover_letter ? (
                                            <button type="button" onClick={() => setLetterApp(app)} className="text-blue-600 hover:text-blue-800 font-bold text-xs uppercase tracking-widest">Leer</button>
                                        ) : <span className="text-gray-300">—</span>}
                                    </td>
                                    <td className="py-3 pr-4">
                                        <select
                                            value={app.status}
                                            onChange={(e) => setStatus(app, e.target.value)}
                                            className={`px-2 py-1 rounded-lg text-xs font-bold border-0 outline-none cursor-pointer ${STATUS_COLORS[app.status] || "bg-gray-100 text-gray-600"}`}
                                        >
                                            {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                        </select>
                                    </td>
                                    <td className="py-3 pr-4 text-gray-400 text-xs whitespace-nowrap">{fmtDate(app.created_at)}</td>
                                    <td className="py-3 text-right">
                                        <button type="button" onClick={() => remove(app)} className="text-red-500 hover:text-red-700 font-bold text-xs uppercase tracking-widest">Eliminar</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {letterApp && <CoverLetterModal application={letterApp} onClose={() => setLetterApp(null)} />}
        </div>
    );
}

// ---- Configuración tab -----------------------------------------------------------------------------
function ConfigTab({ onMessage }) {
    const [config, setConfig] = useState({ currencySymbol: "$", notifyEmail: "", showSalary: true });
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        api(`${BASE}/config`)
            .then((d) => { if (d && d.config) setConfig(d.config); })
            .catch(() => {});
    }, []);

    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
            const d = await apiPost(`${BASE}/config`, config);
            if (d && d.config) setConfig(d.config);
            onMessage("Configuración guardada.");
        } catch (err) {
            onMessage(`Error: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <form onSubmit={save} className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8 space-y-5 max-w-xl">
            <div>
                <label className={labelCls}>Símbolo de moneda</label>
                <input type="text" value={config.currencySymbol} onChange={(e) => setConfig((c) => ({ ...c, currencySymbol: e.target.value }))} className={inputCls} maxLength={5} />
                <p className="text-[11px] text-gray-400 mt-1">Se usa para mostrar los rangos salariales, p. ej. $ o €.</p>
            </div>
            <div>
                <label className={labelCls}>Email de notificación</label>
                <input type="email" value={config.notifyEmail} onChange={(e) => setConfig((c) => ({ ...c, notifyEmail: e.target.value }))} className={inputCls} placeholder="(vacío = sin notificaciones)" maxLength={254} />
                <p className="text-[11px] text-gray-400 mt-1">
                    Recibe un correo por cada postulación. Si la vacante tiene su propio email, ese tiene prioridad.
                </p>
            </div>
            <label className="flex items-center gap-2 text-sm font-bold text-gray-600 cursor-pointer select-none">
                <input type="checkbox" checked={!!config.showSalary} onChange={(e) => setConfig((c) => ({ ...c, showSalary: e.target.checked }))} />
                Mostrar salarios en el sitio público
            </label>
            <div className="flex justify-end">
                <button type="submit" disabled={busy} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
            </div>
        </form>
    );
}

// ---- Page ------------------------------------------------------------------------------------------
export default function JobBoardAdminPage() {
    const [tab, setTab] = useState("jobs");
    const [jobs, setJobs] = useState([]);
    const [newCount, setNewCount] = useState(0);
    const [message, setMessage] = useState("");

    const loadJobs = async () => {
        try {
            const data = await api(`${BASE}/jobs`);
            const list = data.jobs || [];
            setJobs(list);
            setNewCount(list.reduce((sum, j) => sum + (j.new_count || 0), 0));
        } catch {
            setJobs([]);
        }
    };

    useEffect(() => { loadJobs(); }, []);

    const flash = (msg) => {
        setMessage(msg);
        if (msg) setTimeout(() => setMessage(""), 5000);
    };

    const tabBtn = (id, label, badge) => (
        <button
            type="button"
            onClick={() => setTab(id)}
            className={`px-4 py-2.5 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${tab === id ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
        >
            {label}
            {badge > 0 && (
                <span className="ml-2 inline-block px-1.5 py-0.5 rounded-full bg-blue-600 text-white text-[10px] font-black">{badge}</span>
            )}
        </button>
    );

    return (
        <div className="max-w-6xl mx-auto p-4 sm:p-8">
            <div className="mb-6">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Bolsa de empleo</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    Vacantes · postulaciones · bloque JobBoard en el editor visual
                </p>
            </div>

            <div className="flex flex-wrap gap-2 mb-6">
                {tabBtn("jobs", "Vacantes", 0)}
                {tabBtn("applications", "Postulaciones", newCount)}
                {tabBtn("config", "Configuración", 0)}
            </div>

            {message && (
                <div className={`text-sm px-4 py-3 rounded-xl mb-4 ${/^Error/i.test(message) ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>
                    {message}
                </div>
            )}

            {tab === "jobs" && <JobsTab jobs={jobs} onReload={loadJobs} onMessage={flash} />}
            {tab === "applications" && (
                <ApplicationsTab
                    jobs={jobs}
                    onMessage={flash}
                    onCountsChange={(c) => setNewCount(c.new || 0)}
                />
            )}
            {tab === "config" && <ConfigTab onMessage={flash} />}
        </div>
    );
}
