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
import { PageViewer } from "./PageViewer";

/** GET with query parameters (the list, a sheet's page, a file), or POST { action, … }. */
type Req = (method: "get" | "post", params?: Record<string, any>) => Promise<any>;
/** `wide`: the checklist, with the sheet next to the list on a wide screen. */
type DialogProps = { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; testId?: string; closeLabel?: string; wide?: boolean };

const LANG_NAMES: Record<string, string> = { es: "Español", en: "English", pt: "Português" };
const btn = "inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50";
const btnDark = "inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-gray-900 text-white text-sm font-bold disabled:opacity-60";
const input = "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-blue-500 outline-none";
const lbl = "block text-xs font-bold text-gray-600 mb-1";
const errCls = "text-xs font-semibold text-rose-600 mt-1";

/**
 * Save a file given as base64 (2.36.3: the sheet's PDF) under its name: a computer and an Android phone save it, an
 * iPhone offers to open or keep it. No new window.
 */
export function saveFile(name: string, mime: string, b64: string) {
    const bin = atob(String(b64 || ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement("a");
    a.href = url; a.download = name; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}
/** The core portal's file route for a ticket (the PDF with its real type: a phone opens it in its own viewer). */
export const sheetFileUrl = (d: string) => `/portal/conference/file?d=${encodeURIComponent(d)}`;
/**
 * Open the sheet's PDF to print it (2.36.3, instead of the browser's print call, which a phone ignores from a frame): the new
 * tab is opened inside the tap, before the ticket is asked for, then sent to the PDF — the phone's viewer prints
 * and shares it, a computer's prints it.
 */
export async function openSheetPdf(ticket: () => Promise<string>) {
    const w = typeof window !== "undefined" ? window.open("", "_blank") : null;
    try {
        const url = sheetFileUrl(await ticket());
        if (w && !w.closed) { try { w.opener = null; } catch { /* ignore */ } w.location.href = url; return; }
        const a = document.createElement("a");
        a.href = url; a.target = "_blank"; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
    } catch (e) {
        if (w && !w.closed) w.close();
        throw e;
    }
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

/** A box of the sheet view, drawn like the printed one (a square that is ticked or not). */
function Box({ on, tone }: { on: boolean; tone: "ok" | "no" }) {
    const ticked = tone === "ok" ? "border-emerald-600 bg-emerald-600 text-white" : "border-rose-600 bg-rose-600 text-white";
    return (
        <span aria-hidden="true" className={`inline-flex w-5 h-5 shrink-0 items-center justify-center rounded border-2 text-[11px] ${on ? ticked : "border-gray-300 bg-white text-transparent"}`}>
            <i className={`fa-solid ${tone === "ok" ? "fa-check" : "fa-xmark"}`}></i>
        </span>
    );
}

/**
 * The sheet itself (2.36.2), so whoever ticks can follow the paper line by line: its rows in the printed order — the
 * pre-filled names, then the blank rows — with the same «No autorizo» columns. Tapping a row ticks that the person
 * signed (the same state as the list); tapping an opt-out box ticks it too, since only a signer marks one. Rows
 * already settled stay in place, greyed, so the numbering always matches the paper.
 */
export function SheetView({ t, sheet, rows, people, setRow, renderDetail }: { t: (k: string, v?: any) => string; sheet: any; rows: any[]; people: any[]; setRow: (id: number, patch: any) => void; renderDetail?: (r: any) => React.ReactNode }) {
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    const person = new Map(people.map((p: any) => [p.id, p]));
    const printed = (sheet.roster || []).map((l: any) => ({ row: l.row, id: l.inscription_id, name: l.name || person.get(l.inscription_id)?.name || `#${l.inscription_id}` }));
    const blanks = Array.from({ length: Number(sheet.blank) || 0 }, (_, i) => ({ row: printed.length + i + 1, id: null, name: "" }));
    const cell = "px-2 py-2 border-b border-gray-100 align-middle";
    const tap = "w-full flex items-center justify-center min-h-[2.25rem] rounded hover:bg-gray-50";
    return (
        <table className="w-full text-xs border-collapse" data-paper-sheet-view={sheet.code}>
            <thead>
                <tr className="text-[10px] uppercase tracking-wide text-gray-500 bg-gray-50">
                    <th scope="col" className="px-2 py-1.5 text-left w-8">#</th>
                    <th scope="col" className="px-2 py-1.5 text-left">{t("paper.col.name")}</th>
                    <th scope="col" className="px-1 py-1.5 w-14">{t("paper.col.signed")}</th>
                    <th scope="col" className="px-1 py-1.5 w-14">{t("paper.col.health")}</th>
                    <th scope="col" className="px-1 py-1.5 w-14">{t("paper.col.image")}</th>
                </tr>
            </thead>
            <tbody>
                {[...printed, ...blanks].map((l: any) => {
                    // A blank row shows the walk-in ticked on it (the row typed in the list).
                    const r = l.id != null ? byId.get(l.id) : rows.find((x: any) => x.row == null && x.on && Number(x.typedRow) === l.row);
                    const settled = l.id != null && !r;
                    const status = settled ? (person.get(l.id) ? t("paper.row.granted") : t("paper.row.gone")) : null;
                    const detail = r && l.id != null && renderDetail ? renderDetail(r) : null;
                    return (
                        <React.Fragment key={l.row}>
                        <tr className={`${r?.on ? "bg-emerald-50/60" : ""} ${settled ? "text-gray-400" : "text-gray-900"}`} data-paper-sheet-row={l.row}>
                            <td className={`${cell} font-bold tabular-nums`}>{l.row}</td>
                            <td className={cell}>
                                {r && l.id != null ? (
                                    <button type="button" className="w-full text-left font-semibold min-h-[2.25rem]" aria-pressed={r.on} onClick={() => setRow(r.id, { on: !r.on })}>{l.name}</button>
                                ) : (
                                    <span className={l.name || r ? "font-semibold" : "italic text-gray-400"}>{l.name || r?.name || t("paper.row.blank")}</span>
                                )}
                                {status && <span className="block text-[10px] font-semibold">{status}</span>}
                            </td>
                            {r && l.id != null ? (
                                <>
                                    <td className={cell}><button type="button" className={tap} aria-pressed={r.on} aria-label={`${l.row} · ${t("paper.col.signed")}`} onClick={() => setRow(r.id, { on: !r.on })}><Box on={r.on} tone="ok" /></button></td>
                                    <td className={cell}><button type="button" className={tap} aria-pressed={r.on && r.noHealth} aria-label={`${l.row} · ${t("paper.optout.health")}`} onClick={() => setRow(r.id, r.on && r.noHealth ? { noHealth: false } : { on: true, noHealth: true })}><Box on={r.on && r.noHealth} tone="no" /></button></td>
                                    <td className={cell}><button type="button" className={tap} aria-pressed={r.on && r.noImage} aria-label={`${l.row} · ${t("paper.optout.image")}`} onClick={() => setRow(r.id, r.on && r.noImage ? { noImage: false } : { on: true, noImage: true })}><Box on={r.on && r.noImage} tone="no" /></button></td>
                                </>
                            ) : (
                                <>
                                    <td className={`${cell} text-center`}>{r ? <Box on tone="ok" /> : null}</td>
                                    <td className={`${cell} text-center`}>{r ? <Box on={r.noHealth} tone="no" /> : null}</td>
                                    <td className={`${cell} text-center`}>{r ? <Box on={r.noImage} tone="no" /> : null}</td>
                                </>
                            )}
                        </tr>
                        {detail && <tr className="bg-emerald-50/60" data-paper-sheet-detail={l.row}><td></td><td colSpan={4} className="px-2 pb-3 border-b border-gray-100">{detail}</td></tr>}
                        </React.Fragment>
                    );
                })}
            </tbody>
        </table>
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
    const [del, setDel] = useState<any>(null);

    const load = useCallback(async () => {
        try { const d = await request("get", {}); setData(d); setErr(null); }
        catch (e: any) { setData(null); setErr(e?.message || "Error"); }
    }, [request]);
    useEffect(() => { load(); }, [load]);

    const when = (iso: string) => { try { return new Intl.DateTimeFormat(dateLang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); } catch { return iso; } };
    const nameOf = (id: number) => (data?.people || []).find((p: any) => p.id === id)?.name || `#${id}`;

    const download = async () => {
        const n = blank === "" ? undefined : Number(blank);
        if (n !== undefined && !(Number.isInteger(n) && n >= 0 && n <= (data?.limits?.max_blank || 40))) { setErr(t("paper.blank.bad", { max: data?.limits?.max_blank || 40 })); return; }
        setBusy("create"); setErr(null);
        try {
            const r = await request("post", { action: "create", blank: n, lang: sheetLang || data?.lang, paper });
            // The new sheet, ready: its PDF is saved or opened from the dialog (a tap of its own, so a phone allows it).
            addToast(t("paper.downloaded", { code: r.sheet.code }), "success");
            setView({ kind: "printed", code: r.sheet.code, sheet: r.sheet });
            load();
        } catch (e: any) { setErr(e?.message || "Error"); }
        finally { setBusy(null); }
    };
    // The sheet as a real PDF (2.36.3): «Descargar PDF» saves it; «Imprimir» opens it (print, share).
    const reprint = async (s: any, print = false) => {
        setBusy(`html-${s.id}`);
        try {
            if (print) await openSheetPdf(async () => (await request("get", { sheet_id: s.id, format: "ticket" })).d);
            else { const r = await request("get", { sheet_id: s.id, format: "pdf" }); saveFile(r.filename, r.mime, r.b64); }
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
    // A file opens in the viewer, in place: a photo, or a scanned PDF page by page (2.36.3: never a download).
    const loadFile = useCallback((f: any) => request("get", { file_id: f.id }), [request]);
    const openFile = (f: any) => setView({ kind: "file", file: f });

    // The checklist: the sheet's rows first, then the locality's other people still without an authorization.
    const openCheck = (s: any) => {
        const rowOf = new Map((s.roster || []).map((r: any) => [r.inscription_id, r.row]));
        const people = (data.people || []).filter((p: any) => p.state !== "granted");
        people.sort((a: any, b: any) => (rowOf.get(a.id) ?? 1e9) - (rowOf.get(b.id) ?? 1e9) || a.name.localeCompare(b.name));
        setCheck({
            sheet: s, err: null, viewerH: 40,
            rows: people.map((p: any) => ({ id: p.id, name: p.name, row: rowOf.get(p.id) ?? null, typedRow: "", byAge: p.minor, on: false, noHealth: false, noImage: false, minor: p.minor === true, rep: "", repDoc: "", err: {} })),
        });
    };
    const setRow = (id: number, patch: any) => setCheck((c: any) => ({ ...c, err: null, rows: c.rows.map((r: any) => (r.id === id ? { ...r, ...patch, err: {} } : r)) }));
    // On a phone the viewer sits on top, its height dragged with the bar under it (20–70 % of the screen).
    const dragH = (e: React.PointerEvent) => {
        const y0 = e.clientY, h0 = check.viewerH, vh = window.innerHeight || 800;
        const el = e.currentTarget as any;
        el.setPointerCapture?.(e.pointerId);
        const onMove = (ev: PointerEvent) => setCheck((c: any) => (c ? { ...c, viewerH: Math.round(Math.min(70, Math.max(20, h0 + ((ev.clientY - y0) / vh) * 100))) } : c));
        const onUp = () => { el.removeEventListener("pointermove", onMove); el.removeEventListener("pointerup", onUp); el.removeEventListener("pointercancel", onUp); };
        el.addEventListener("pointermove", onMove); el.addEventListener("pointerup", onUp); el.addEventListener("pointercancel", onUp);
    };
    const nudgeH = (d: number) => setCheck((c: any) => ({ ...c, viewerH: Math.min(70, Math.max(20, c.viewerH + d)) }));
    const removeSheet = async () => {
        setDel({ ...del, busy: true, err: null });
        try {
            await request("post", { action: "delete", sheet_id: del.sheet.id });
            addToast(t("paper.deleted", { code: del.sheet.code }), "success");
            setDel(null); load();
        } catch (e: any) { setDel({ ...del, busy: false, err: e?.message || "Error" }); }
    };
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

    const walkins = check ? check.rows.filter((r: any) => r.row == null) : [];
    const detailOf = (r: any) => {
        if (!r.on || (r.byAge != null && !r.minor && !r.err.choice)) return null;
        return (
            <div className="space-y-2 pt-1">
                {r.byAge == null && (
                    <label className="inline-flex items-center gap-2 text-xs font-bold text-gray-600">
                        <input type="checkbox" className="w-4 h-4" checked={r.minor} onChange={(e) => setRow(r.id, { minor: e.target.checked })} />{t("paper.minor")}
                    </label>
                )}
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
        );
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
                                <i className="fa-solid fa-print" aria-hidden="true"></i>{busy === "create" ? "…" : t("paper.download")}
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
                                        <button type="button" className={btn} disabled={busy === `html-${s.id}`} onClick={() => reprint(s, true)} data-paper-print={s.code}><i className="fa-solid fa-print" aria-hidden="true"></i>{t("paper.print")}</button>
                                        <button type="button" className={btn} disabled={busy === `html-${s.id}`} onClick={() => reprint(s)} data-paper-pdf={s.code}><i className="fa-solid fa-download" aria-hidden="true"></i>{t("paper.reprint")}</button>
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
                                        {canManage && s.deletable && (
                                            <button type="button" className={`${btn} text-rose-700 hover:bg-rose-50`} onClick={() => setDel({ sheet: s, busy: false, err: null })} data-paper-delete={s.code}>
                                                <i className="fa-regular fa-trash-can" aria-hidden="true"></i>{t("paper.delete")}
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
                        <button type="button" className={btn} disabled={busy === `html-${view.sheet.id}`} onClick={() => reprint(view.sheet)} data-paper-pdf-save=""><i className="fa-solid fa-download" aria-hidden="true"></i>{t("paper.reprint")}</button>
                        <button type="button" className={btnDark} disabled={busy === `html-${view.sheet.id}`} onClick={() => reprint(view.sheet, true)} data-paper-pdf-open=""><i className="fa-solid fa-print" aria-hidden="true"></i>{t("paper.print")}</button>
                    </div>}>
                    <p className="text-sm text-gray-700">{t("paper.downloaded", { code: view.code })}</p>
                    <p className="text-xs text-gray-500 mt-2">{t("paper.printed.hint")}</p>
                </Dialog>
            )}
            {view?.kind === "file" && (
                <Dialog wide closeLabel={t("paper.close")} title={view.file.name || t("paper.files")} onClose={() => setView(null)} testId="paper-file"
                    footer={<div className="flex justify-end w-full"><button type="button" className={btnDark} onClick={() => setView(null)}>{t("paper.close")}</button></div>}>
                    <div className="h-[60vh]"><PageViewer t={t} files={[view.file]} load={loadFile} /></div>
                    <p className="text-[11px] text-gray-500 mt-2 break-all">SHA-256 {view.file.sha256}</p>
                </Dialog>
            )}

            {check && (
                <Dialog wide closeLabel={t("paper.close")} title={t("paper.check.title", { code: check.sheet.code })} onClose={() => setCheck(null)} testId="paper-check"
                    footer={<div className="flex flex-wrap justify-end gap-2 w-full">
                        <button type="button" className={btn} onClick={() => setCheck(null)}>{t("paper.cancel")}</button>
                        <button type="button" className={btnDark} disabled={check.busy} onClick={saveCheck} data-paper-save="">{t("paper.save", { n: check.rows.filter((r: any) => r.on).length })}</button>
                    </div>}>
                    <p className="text-xs text-gray-500">{t("paper.check.hint")}</p>
                    {check.err && <p className="text-sm font-semibold text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2 mt-2" role="alert">{check.err}</p>}
                    {check.rows.length === 0 && <p className="text-sm text-gray-500 mt-3">{t("paper.all.signed")}</p>}
                    {/* 2.36.3: everything on one screen — the uploaded page (viewer) and the sheet's rows with their ticks. Side by
                        side on a wide screen; on a phone the viewer stays on top (its height dragged) and the rows scroll under it. */}
                    <div className="mt-3 lg:grid lg:grid-cols-2 lg:gap-5 lg:items-start">
                        <div className="sticky top-0 z-10 bg-white pb-1 lg:pb-0" data-paper-viewer-pane="">
                            <div className="h-[var(--pv-h)] lg:h-[62vh]" style={{ ["--pv-h" as any]: `${check.viewerH}dvh` }}>
                                <PageViewer t={t} files={check.sheet.files || []} load={loadFile} />
                            </div>
                            <div className="lg:hidden flex justify-center pt-1">
                                <button type="button" role="separator" aria-orientation="horizontal" aria-valuemin={20} aria-valuemax={70} aria-valuenow={check.viewerH} aria-label={t("paper.viewer.resize")}
                                    className="w-full flex justify-center py-1.5 cursor-row-resize" style={{ touchAction: "none" }} onPointerDown={dragH}
                                    onKeyDown={(e) => { if (e.key === "ArrowUp") { e.preventDefault(); nudgeH(-5); } if (e.key === "ArrowDown") { e.preventDefault(); nudgeH(5); } }} data-paper-viewer-resize="">
                                    <span className="block w-12 h-1.5 rounded-full bg-gray-300" aria-hidden="true"></span>
                                </button>
                            </div>
                        </div>
                        <div className="min-w-0 mt-2 lg:mt-0" data-paper-rows="">
                            <p className="text-[11px] text-gray-500 mb-2">{t("paper.view.hint")}</p>
                            <SheetView t={t} sheet={check.sheet} rows={check.rows} people={data.people || []} setRow={setRow} renderDetail={detailOf} />
                            {walkins.length > 0 && (
                                <div className="mt-4" data-paper-walkins="">
                                    <h4 className="text-xs font-bold uppercase tracking-wide text-gray-500">{t("paper.walkins.title")}</h4>
                                    <ul className="divide-y divide-gray-100">
                        {walkins.map((r: any) => (
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
                                </div>
                            )}
                        </div>
                    </div>
                </Dialog>
            )}

            {del && (
                <Dialog closeLabel={t("paper.close")} title={t("paper.delete.title", { code: del.sheet.code })} onClose={() => setDel(null)} testId="paper-delete"
                    footer={<div className="flex flex-wrap justify-end gap-2 w-full">
                        <button type="button" className={btn} onClick={() => setDel(null)}>{t("paper.cancel")}</button>
                        <button type="button" className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-bold disabled:opacity-60" disabled={del.busy} onClick={removeSheet} data-paper-delete-confirm="">
                            <i className="fa-regular fa-trash-can" aria-hidden="true"></i>{t("paper.delete.confirm")}
                        </button>
                    </div>}>
                    <p className="text-sm text-gray-700">{t("paper.delete.hint")}</p>
                    <p className="text-[11px] text-gray-500 mt-2">{t("paper.sheet.meta", { rows: del.sheet.rows, blank: del.sheet.blank, when: when(del.sheet.created_utc) })}</p>
                    {del.err && <p className={`${errCls} mt-2`} role="alert">{del.err}</p>}
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
