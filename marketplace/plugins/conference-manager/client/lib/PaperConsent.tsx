// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Consentimiento en papel» (2.34.0) — one panel for the admin's «Autorizaciones» tab and the coordinators' portal
 * (server/consent-paper.js): download a locality's printable sheet, upload the signed pages, tick who signed — one
 * signature covers the whole authorization, and health and image stay authorized unless the person marked the
 * sheet's «No autorizo …» box, which the coordinator ticks here too — and undo a wrong tick with a reason.
 *
 * The host screen hands in how to call the server (`request`), its own dialog (`Dialog`: the admin's Overlay or
 * the portal's Modal) and its toasts; everything else is here. Photos are compressed in the browser like a payment
 * receipt (lib/proofImage); a PDF goes as it is, up to the server's limit. Every message is in place (a field
 * error, a notice) or a toast — never a native dialog.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Select } from "./Select";
import { prepareProof, formatBytes } from "./proofImage";

/** GET with query parameters (the list, a sheet's page, a file), or POST { action, … }. */
type Req = (method: "get" | "post", params?: Record<string, any>) => Promise<any>;
type DialogProps = { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; testId?: string; closeLabel?: string };

const LANG_NAMES: Record<string, string> = { es: "Español", en: "English", pt: "Português" };
const btn = "inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50";
const btnDark = "inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-gray-900 text-white text-sm font-bold disabled:opacity-60";
const input = "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-blue-500 outline-none";
const lbl = "block text-xs font-bold text-gray-600 mb-1";
const errCls = "text-xs font-semibold text-rose-600 mt-1";

/** Save a text or data URL as a file (no new window: some embedded browsers block those). */
function saveAs(name: string, content: string, type = "text/html") {
    const a = document.createElement("a");
    const blob = content.startsWith("data:") ? null : new Blob([content], { type: `${type};charset=utf-8` });
    a.href = blob ? URL.createObjectURL(blob) : content;
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    if (blob) setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
/** Print a self-contained page through a hidden frame. */
function printHtml(html: string) {
    const f = document.createElement("iframe");
    f.setAttribute("aria-hidden", "true");
    Object.assign(f.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
    f.onload = () => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch { /* the download is still there */ } setTimeout(() => f.remove(), 60000); };
    f.srcdoc = html;
    document.body.appendChild(f);
}
const readDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error || new Error("read"));
    r.readAsDataURL(file);
});

/** An opt-out box of the checklist: the person marked «No autorizo …» on the sheet. */
function OptOut({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
    return (
        <label className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1 text-xs font-semibold cursor-pointer ${checked ? "border-rose-300 bg-rose-50 text-rose-800" : "border-gray-200 bg-white text-gray-600"}`}>
            <input type="checkbox" className="w-4 h-4 accent-rose-600" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            {label}
        </label>
    );
}

export function PaperConsent({ t, request, Dialog, addToast, canManage, locationPicker, dateLang = "es" }: {
    t: (k: string, v?: any) => string; request: Req; Dialog: React.ComponentType<DialogProps>; addToast: (m: string, tone?: string) => void;
    canManage: boolean; locationPicker?: React.ReactNode; dateLang?: string;
}) {
    const [data, setData] = useState<any>(null);
    const [err, setErr] = useState<string | null>(null);
    const [sheetLang, setSheetLang] = useState<string>("");
    const [blank, setBlank] = useState<string>("");
    const [paper, setPaper] = useState<string>("letter");
    const [busy, setBusy] = useState<string | null>(null);
    const [check, setCheck] = useState<any>(null);
    const [undo, setUndo] = useState<any>(null);
    const [view, setView] = useState<any>(null);

    const load = useCallback(async () => {
        try { const d = await request("get", {}); setData(d); setErr(null); }
        catch (e: any) { setData(null); setErr(e?.message || "Error"); }
    }, [request]);
    useEffect(() => { load(); }, [load]);

    const when = (iso: string) => { try { return new Intl.DateTimeFormat(dateLang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); } catch { return iso; } };
    const nameOf = (id: number) => (data?.people || []).find((p: any) => p.id === id)?.name || `#${id}`;
    const fileName = (code: string) => `consentimiento-${code}.html`;

    const download = async () => {
        const n = blank === "" ? undefined : Number(blank);
        if (n !== undefined && !(Number.isInteger(n) && n >= 0 && n <= (data?.limits?.max_blank || 40))) { setErr(t("paper.blank.bad", { max: data?.limits?.max_blank || 40 })); return; }
        setBusy("create"); setErr(null);
        try {
            const r = await request("post", { action: "create", blank: n, lang: sheetLang || data?.lang, paper });
            saveAs(fileName(r.sheet.code), r.html);
            addToast(t("paper.downloaded", { code: r.sheet.code }), "success");
            setView({ kind: "printed", code: r.sheet.code, html: r.html });
            load();
        } catch (e: any) { setErr(e?.message || "Error"); }
        finally { setBusy(null); }
    };
    const reprint = async (s: any, print = false) => {
        setBusy(`html-${s.id}`);
        try {
            const r = await request("get", { sheet_id: s.id });
            if (print) printHtml(r.html); else saveAs(fileName(r.code), r.html);
        } catch (e: any) { addToast(e?.message || "Error", "error"); }
        finally { setBusy(null); }
    };
    const upload = async (s: any, files: FileList | null) => {
        const list = Array.from(files || []);
        if (!list.length) return;
        setBusy(`up-${s.id}`);
        let done = 0;
        try {
            for (const file of list) {
                let url = "";
                if (file.type === "application/pdf") {
                    url = await readDataUrl(file);
                    if (url.length > (data?.limits?.max_file_chars || 3000000)) { addToast(`${file.name}: ${t("paper.file.big")}`, "error"); continue; }
                } else if (/^image\//.test(file.type)) {
                    const r = await prepareProof(file);
                    if (!r.ok) { addToast(`${file.name}: ${t(r.error === "not_image" ? "paper.file.bad" : "paper.file.unreadable")}`, "error"); continue; }
                    url = r.dataUrl;
                } else { addToast(`${file.name}: ${t("paper.file.bad")}`, "error"); continue; }
                try { await request("post", { action: "upload", sheet_id: s.id, data_url: url, name: file.name }); done++; }
                catch (e: any) { addToast(`${file.name}: ${e?.message || "Error"}`, "error"); }
            }
            if (done) addToast(t("paper.uploaded", { n: done }), "success");
            load();
        } finally { setBusy(null); }
    };
    const openFile = async (f: any) => {
        setBusy(`file-${f.id}`);
        try {
            const r = await request("get", { file_id: f.id });
            if (r.mime === "application/pdf") saveAs(r.name || `hoja-${f.id}.pdf`, r.data_url, r.mime);
            else setView({ kind: "file", file: r });
        } catch (e: any) { addToast(e?.message || "Error", "error"); }
        finally { setBusy(null); }
    };

    // The checklist: the sheet's rows first, then the locality's other people still without an authorization.
    const openCheck = (s: any) => {
        const rowOf = new Map((s.roster || []).map((r: any) => [r.inscription_id, r.row]));
        const people = (data.people || []).filter((p: any) => p.state !== "granted");
        people.sort((a: any, b: any) => (rowOf.get(a.id) ?? 1e9) - (rowOf.get(b.id) ?? 1e9) || a.name.localeCompare(b.name));
        setCheck({
            sheet: s, err: null,
            rows: people.map((p: any) => ({ id: p.id, name: p.name, row: rowOf.get(p.id) ?? null, typedRow: "", byAge: p.minor, on: false, noHealth: false, noImage: false, minor: p.minor === true, rep: "", repDoc: "", err: {} })),
        });
    };
    const setRow = (id: number, patch: any) => setCheck((c: any) => ({ ...c, err: null, rows: c.rows.map((r: any) => (r.id === id ? { ...r, ...patch, err: {} } : r)) }));
    const saveCheck = async () => {
        const chosen = check.rows.filter((r: any) => r.on);
        if (!chosen.length) { setCheck({ ...check, err: t("paper.none.checked") }); return; }
        let bad = false;
        const rows = check.rows.map((r: any) => {
            if (!r.on) return r;
            const e: any = {};
            if (r.minor && !r.rep.trim()) e.rep = t("paper.rep.missing");
            if (Object.keys(e).length) bad = true;
            return { ...r, err: e };
        });
        if (bad) { setCheck({ ...check, rows }); return; }
        setCheck({ ...check, busy: true });
        try {
            const r = await request("post", {
                action: "marks", sheet_id: check.sheet.id,
                marks: chosen.map((x: any) => ({
                    inscription_id: x.id, health: !x.noHealth, image: !x.noImage, minor: x.minor,
                    ...(x.minor ? { representative: { name: x.rep.trim(), document: x.repDoc.trim() } } : {}),
                    ...(x.row == null && x.typedRow ? { row: Number(x.typedRow) } : {}),
                })),
            });
            addToast(t("paper.saved", { n: r.marked.length }), "success");
            setCheck(null); load();
        } catch (e: any) {
            const body = e?.body || e?.data || {};
            if (body.inscription_id) {
                const field = body.field === "representative" ? "rep" : "choice";
                setCheck({ ...check, busy: false, rows: check.rows.map((r: any) => (r.id === body.inscription_id ? { ...r, err: { [field]: e.message } } : r)) });
            } else setCheck({ ...check, busy: false, err: e?.message || "Error" });
        }
    };
    const saveUndo = async () => {
        if (!undo.reason.trim()) { setUndo({ ...undo, err: t("paper.undo.reason.missing") }); return; }
        setUndo({ ...undo, busy: true });
        try {
            await request("post", { action: "unmark", inscription_id: undo.id, reason: undo.reason.trim() });
            addToast(t("paper.undone"), "success");
            setUndo(null); load();
        } catch (e: any) { setUndo({ ...undo, busy: false, err: e?.message || "Error" }); }
    };

    const pendingCount = useMemo(() => (data?.people || []).filter((p: any) => p.state !== "granted").length, [data]);
    const paperDone = (s: any) => (data?.people || []).filter((p: any) => p.method === "paper" && p.sheet_id === s.id);

    return (
        <section className="rounded-xl border border-gray-200 p-5 space-y-4 bg-white" data-consent-paper="">
            <div>
                <h2 className="text-lg font-bold text-gray-900"><i className="fa-solid fa-file-signature mr-2 text-gray-400" aria-hidden="true"></i>{t("paper.title")}</h2>
                <p className="text-xs text-gray-500 mt-1">{t("paper.hint")}</p>
            </div>
            {locationPicker}
            {err && <p className="text-sm font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2" role="alert">{err}</p>}
            {data && (
                <>
                    {canManage && (
                        <div className="flex flex-wrap items-end gap-3">
                            <div style={{ flex: "0 1 12rem" }}>
                                <label className={lbl} htmlFor="cp-lang">{t("paper.lang")}</label>
                                <Select id="cp-lang" className={input} value={sheetLang || data.lang} onChange={(e) => setSheetLang(e.target.value)}>
                                    {Object.entries(LANG_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                </Select>
                            </div>
                            <div style={{ flex: "0 1 10rem" }}>
                                <label className={lbl} htmlFor="cp-paper">{t("paper.size")}</label>
                                <Select id="cp-paper" className={input} value={paper} onChange={(e) => setPaper(e.target.value)}>
                                    <option value="letter">{t("paper.size.letter")}</option>
                                    <option value="a4">A4</option>
                                </Select>
                            </div>
                            <div style={{ flex: "0 1 12rem" }}>
                                <label className={lbl} htmlFor="cp-blank">{t("paper.blank")}</label>
                                <input id="cp-blank" type="number" min={0} max={data.limits.max_blank} inputMode="numeric" className={input} placeholder={String(data.limits.default_blank)} value={blank} onChange={(e) => { setBlank(e.target.value); setErr(null); }} />
                            </div>
                            <button type="button" className={btnDark} disabled={busy === "create"} onClick={download} data-paper-download="">
                                <i className="fa-solid fa-download" aria-hidden="true"></i>{busy === "create" ? "…" : t("paper.download")}
                            </button>
                        </div>
                    )}
                    {pendingCount === 0 && <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">{t("paper.all.signed")}</p>}
                    <div className="space-y-3">
                        <h3 className="text-sm font-bold text-gray-900">{t("paper.sheets")}</h3>
                        {data.sheets.length === 0 && <p className="text-sm text-gray-400">{t("paper.none")}</p>}
                        {data.sheets.map((s: any) => (
                            <div key={s.id} className="rounded-lg border border-gray-100 p-3 space-y-2" data-paper-sheet={s.code}>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="min-w-0">
                                        <div className="text-sm font-bold text-gray-900">{t("paper.sheet", { code: s.code })} <span className="ml-1 text-[11px] font-semibold text-gray-500">{LANG_NAMES[s.lang] || s.lang} · {s.paper === "a4" ? "A4" : t("paper.size.letter")} · v{s.policy_version}</span></div>
                                        <div className="text-[11px] text-gray-500">{t("paper.sheet.meta", { rows: s.rows, blank: s.blank, when: when(s.created_utc) })} · {t("paper.marked", { n: s.marked })}</div>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <button type="button" className={btn} disabled={busy === `html-${s.id}`} onClick={() => reprint(s, true)}><i className="fa-solid fa-print" aria-hidden="true"></i>{t("paper.print")}</button>
                                        <button type="button" className={btn} disabled={busy === `html-${s.id}`} onClick={() => reprint(s)}><i className="fa-solid fa-download" aria-hidden="true"></i>{t("paper.reprint")}</button>
                                        {canManage && (
                                            <label className={`${btn} cursor-pointer ${busy === `up-${s.id}` ? "opacity-50 pointer-events-none" : ""}`} data-paper-upload={s.code}>
                                                <i className="fa-solid fa-upload" aria-hidden="true"></i>{busy === `up-${s.id}` ? t("paper.uploading") : t("paper.upload")}
                                                <input type="file" className="sr-only" accept="image/*,application/pdf" multiple onChange={(e) => { upload(s, e.currentTarget.files); e.currentTarget.value = ""; }} />
                                            </label>
                                        )}
                                        {canManage && (
                                            <button type="button" className={btnDark} disabled={!s.files.length} title={s.files.length ? undefined : t("paper.files.none")} onClick={() => openCheck(s)} data-paper-check={s.code}>
                                                <i className="fa-solid fa-list-check" aria-hidden="true"></i>{t("paper.mark")}
                                            </button>
                                        )}
                                    </div>
                                </div>
                                {s.files.length === 0 ? <p className="text-[11px] text-amber-800">{t("paper.files.none")}</p> : (
                                    <ul className="flex flex-wrap gap-2" aria-label={t("paper.files")}>
                                        {s.files.map((f: any) => (
                                            <li key={f.id}>
                                                <button type="button" className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-2.5 py-1 text-[11px] text-gray-700 hover:bg-gray-50" onClick={() => openFile(f)} title={`SHA-256 ${f.sha256}`} data-paper-file={f.id}>
                                                    <i className={`fa-regular ${f.mime === "application/pdf" ? "fa-file-pdf" : "fa-file-image"}`} aria-hidden="true"></i>
                                                    <span className="max-w-[10rem] truncate">{f.name || `#${f.id}`}</span>
                                                    <span className="text-gray-400">{formatBytes(f.bytes)} · {f.sha256.slice(0, 8)}</span>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {paperDone(s).length > 0 && (
                                    <div className="text-[11px] text-gray-600">
                                        <span className="font-bold">{t("paper.done.title")}:</span>{" "}
                                        {paperDone(s).map((p: any, i: number) => (
                                            <span key={p.id} className="inline-flex items-center gap-1 mr-2">
                                                {i > 0 ? "· " : ""}{p.name}
                                                {canManage && <button type="button" className="text-rose-700 underline font-semibold" onClick={() => setUndo({ id: p.id, name: p.name, reason: "", err: null })} data-paper-undo={p.id}>{t("paper.undo")}</button>}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </>
            )}

            {view?.kind === "printed" && (
                <Dialog closeLabel={t("paper.close")} title={t("paper.sheet", { code: view.code })} onClose={() => setView(null)} testId="paper-printed"
                    footer={<div className="flex flex-wrap justify-end gap-2 w-full">
                        <button type="button" className={btn} onClick={() => saveAs(fileName(view.code), view.html)}><i className="fa-solid fa-download" aria-hidden="true"></i>{t("paper.reprint")}</button>
                        <button type="button" className={btnDark} onClick={() => printHtml(view.html)}><i className="fa-solid fa-print" aria-hidden="true"></i>{t("paper.print")}</button>
                    </div>}>
                    <p className="text-sm text-gray-700">{t("paper.downloaded", { code: view.code })}</p>
                    <p className="text-xs text-gray-500 mt-2">{t("paper.printed.hint")}</p>
                </Dialog>
            )}
            {view?.kind === "file" && (
                <Dialog closeLabel={t("paper.close")} title={view.file.name || t("paper.files")} onClose={() => setView(null)} testId="paper-file"
                    footer={<div className="flex justify-end w-full"><button type="button" className={btnDark} onClick={() => setView(null)}>{t("paper.close")}</button></div>}>
                    <img src={view.file.data_url} alt={view.file.name || ""} className="max-w-full h-auto rounded-lg border border-gray-100" />
                    <p className="text-[11px] text-gray-500 mt-2 break-all">SHA-256 {view.file.sha256}</p>
                </Dialog>
            )}

            {check && (
                <Dialog closeLabel={t("paper.close")} title={t("paper.check.title", { code: check.sheet.code })} onClose={() => setCheck(null)} testId="paper-check"
                    footer={<div className="flex flex-wrap justify-end gap-2 w-full">
                        <button type="button" className={btn} onClick={() => setCheck(null)}>{t("paper.cancel")}</button>
                        <button type="button" className={btnDark} disabled={check.busy} onClick={saveCheck} data-paper-save="">{t("paper.save", { n: check.rows.filter((r: any) => r.on).length })}</button>
                    </div>}>
                    <p className="text-xs text-gray-500">{t("paper.check.hint")}</p>
                    {check.err && <p className="text-sm font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2 mt-2" role="alert">{check.err}</p>}
                    {check.rows.length === 0 && <p className="text-sm text-gray-500 mt-3">{t("paper.all.signed")}</p>}
                    <ul className="divide-y divide-gray-100 mt-2">
                        {check.rows.map((r: any) => (
                            <li key={r.id} className="py-3 space-y-2" data-paper-person={r.id}>
                                <label className="flex items-center gap-3 cursor-pointer">
                                    <input type="checkbox" className="w-5 h-5 accent-emerald-600" checked={r.on} onChange={(e) => setRow(r.id, { on: e.target.checked })} />
                                    <span className="min-w-0">
                                        <span className="block text-sm font-semibold text-gray-900">{r.name}</span>
                                        <span className="block text-[11px] text-gray-500">{r.row != null ? t("paper.row", { n: r.row }) : t("paper.walkin")}</span>
                                    </span>
                                </label>
                                {r.on && (
                                    <div className="pl-8 space-y-2">
                                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                                            <OptOut label={t("paper.optout.health")} checked={r.noHealth} onChange={(v) => setRow(r.id, { noHealth: v })} />
                                            <OptOut label={t("paper.optout.image")} checked={r.noImage} onChange={(v) => setRow(r.id, { noImage: v })} />
                                            {r.row == null && (
                                                <span className="inline-flex items-center gap-2 text-xs font-bold text-gray-600">{t("paper.walkin.row")}
                                                    <input type="number" min={1} inputMode="numeric" className="w-16 border border-gray-200 rounded-lg px-2 py-1 text-xs" value={r.typedRow} onChange={(e) => setRow(r.id, { typedRow: e.target.value })} aria-label={t("paper.walkin.row")} />
                                                </span>
                                            )}
                                            {r.byAge == null && (
                                                <label className="inline-flex items-center gap-2 text-xs font-bold text-gray-600">
                                                    <input type="checkbox" className="w-4 h-4" checked={r.minor} onChange={(e) => setRow(r.id, { minor: e.target.checked })} />{t("paper.minor")}
                                                </label>
                                            )}
                                        </div>
                                        {r.err.choice && <p className={errCls} role="alert">{r.err.choice}</p>}
                                        {r.minor && (
                                            <div className="grid gap-2 sm:grid-cols-2">
                                                <div>
                                                    <label className={lbl} htmlFor={`cp-rep-${r.id}`}>{t("paper.rep.name")}</label>
                                                    <input id={`cp-rep-${r.id}`} className={`${input} ${r.err.rep ? "border-rose-300" : ""}`} maxLength={120} value={r.rep} onChange={(e) => setRow(r.id, { rep: e.target.value })} />
                                                    {r.err.rep && <p className={errCls} role="alert">{r.err.rep}</p>}
                                                </div>
                                                <div>
                                                    <label className={lbl} htmlFor={`cp-repdoc-${r.id}`}>{t("paper.rep.doc")}</label>
                                                    <input id={`cp-repdoc-${r.id}`} className={input} maxLength={60} value={r.repDoc} onChange={(e) => setRow(r.id, { repDoc: e.target.value })} />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                </Dialog>
            )}

            {undo && (
                <Dialog closeLabel={t("paper.close")} title={t("paper.undo.title", { name: undo.name || nameOf(undo.id) })} onClose={() => setUndo(null)} testId="paper-undo"
                    footer={<div className="flex flex-wrap justify-end gap-2 w-full">
                        <button type="button" className={btn} onClick={() => setUndo(null)}>{t("paper.cancel")}</button>
                        <button type="button" className="inline-flex items-center px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-bold disabled:opacity-60" disabled={undo.busy} onClick={saveUndo} data-paper-undo-confirm="">{t("paper.undo.confirm")}</button>
                    </div>}>
                    <p className="text-xs text-gray-500">{t("paper.undo.hint")}</p>
                    <label className={`${lbl} mt-3`} htmlFor="cp-undo-reason">{t("paper.undo.reason")}</label>
                    <textarea id="cp-undo-reason" rows={2} maxLength={500} className={`${input} ${undo.err ? "border-rose-300" : ""}`} placeholder={t("paper.undo.reason.ph")} value={undo.reason}
                        onChange={(e) => setUndo({ ...undo, reason: e.target.value, err: null })} />
                    {undo.err && <p className={errCls} role="alert">{undo.err}</p>}
                </Dialog>
            )}
        </section>
    );
}

export default PaperConsent;
