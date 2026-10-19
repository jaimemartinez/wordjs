// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Escarapelas» (2.19.0) — the conference's badge: its design (orientation, title, colours, background image,
 * logo, legibility panel, the fields and their labels), its policy (on / off, coordinators may share, expiry
 * date) and the bulk tools (links and PDFs per location). One design per conference (owner decision D5).
 *
 * The preview is the server's display list for the design being edited (POST /badges/preview, debounced) over
 * a plate composited here; saving stores the design, the source images and the two plates (lib/badges.ts).
 * «Escarapelas › ver» sees everything and uses the bulk tools (with «Inscripciones › ver»); «› administrar»
 * edits. Two views: «Personas» (each person's badge — view, copy, WhatsApp — and everyone's at once) and
 * «Diseño». The per-person overlay (BadgeActions) is also in the person sheet.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { conferenceApi } from "../lib/conference";
import { buildXlsx, downloadXlsx } from "../lib/xlsx";
import { exportFilename } from "../lib/exports";
import { personDisplayName, personLocationId, rawLocationId } from "../lib/lodgingView";
import {
    badgesApi, composePlate, composePlateCanvas, zoneAverage, contrast, copyLater, loadImage, needsPlate, openBadgeFileFrom, publicBase, readFile, scaledSource,
    badgeUrl, waNumber, whatsappUrl, PRINT_PX_PER_MM, screenPxPerMm,
} from "../lib/badges";
import { usePerms, ReadOnlyNotice } from "./perms";
import { useTx } from "./MealScanner";
import { BadgeSvg } from "./BadgeSvg";
import { BadgeActions, phoneOfRow } from "./BadgeActions";

const card = 'bg-white rounded-3xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-4';
const label = 'block text-[10px] font-black uppercase tracking-widest text-gray-500 mb-1.5';
const input = 'w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/40 focus:bg-white focus:border-blue-500 outline-none text-sm text-gray-900 font-medium';
const btn = 'min-h-[44px] px-4 rounded-2xl font-black text-[11px] uppercase tracking-widest inline-flex items-center justify-center gap-2 disabled:opacity-50';
const ghost = `${btn} bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-400`;
const primary = `${btn} bg-gray-900 text-white hover:bg-blue-600`;
const seg = (on: boolean) => `flex-1 min-h-[40px] px-3 rounded-xl text-[11px] font-black uppercase tracking-widest border-2 ${on ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-100 text-gray-500 hover:border-gray-300'}`;

const COLOR_KEYS: [keyof any, string, string][] = [
    ['background', 'badges.color.background', 'Fondo'],
    ['text', 'badges.color.text', 'Texto'],
    ['label', 'badges.color.label', 'Etiquetas'],
    ['accent', 'badges.color.accent', 'Acento'],
];

export default function BadgesPage({ conferenceId, conference }: { conferenceId: number; conference?: any }) {
    const tx = useTx();
    const perms = usePerms();
    const { addToast } = useToast();
    const canManage = perms.can('badges', 'manage');
    const canLinks = perms.can('badges') && perms.can('inscriptions');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [cfg, setCfg] = useState<any>(null);
    const [design, setDesign] = useState<any>(null);
    const [policy, setPolicy] = useState<any>(null);
    const [available, setAvailable] = useState<any[]>([]);
    // «Mi inscripción» (2.23.0): the form fields, the document fields in use and the QR's link.
    const [selfInfo, setSelfInfo] = useState<any>(null);
    const [zones, setZones] = useState<any>(null);
    const [maxRows, setMaxRows] = useState<any>({ horizontal: 3, vertical: 6 });
    const [bgSrc, setBgSrc] = useState<string | null>(null);
    const [logoSrc, setLogoSrc] = useState<string | null>(null);
    const [bgImg, setBgImg] = useState<HTMLImageElement | null>(null);
    const [logoImg, setLogoImg] = useState<HTMLImageElement | null>(null);
    const [imagesDirty, setImagesDirty] = useState({ bg: false, logo: false });
    const [preview, setPreview] = useState<any>(null);
    const [previewPlate, setPreviewPlate] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    // Nothing is editable while a save runs: an edit made then would be overwritten by the saved design.
    const locked = !canManage || saving;
    const seqRef = useRef(0);
    // «Personas» once there is a saved design (and the person may see the links), else «Diseño».
    const [tab, setTab] = useState<'people' | 'design'>('design');
    const tabChosen = useRef(false);

    const load = async () => {
        setLoading(true); setError('');
        try {
            const r = await badgesApi.getConfig(conferenceId);
            if (!tabChosen.current) { tabChosen.current = true; setTab(r.config.configured && canLinks ? 'people' : 'design'); }
            setCfg(r.config); setDesign(r.config.design); setPolicy(r.config.policy);
            setAvailable(r.available_fields || []); setZones(r.zones); setSelfInfo(r.self_page || null);
            if (r.max_rows) setMaxRows(r.max_rows);
            const kinds = new Set((r.assets || []).map(a => a.kind));
            const [bg, logo] = await Promise.all([
                kinds.has('background_src') ? badgesApi.getAsset(conferenceId, 'background_src').catch(() => null) : null,
                kinds.has('logo_src') ? badgesApi.getAsset(conferenceId, 'logo_src').catch(() => null) : null,
            ]);
            setBgSrc(bg ? bg.data_url : null); setLogoSrc(logo ? logo.data_url : null);
            setImagesDirty({ bg: false, logo: false }); setDirty(false);
        } catch (e: any) { setError(e?.message || 'Error'); }
        finally { setLoading(false); }
    };
    useEffect(() => { load(); }, [conferenceId]);
    useEffect(() => { let alive = true; if (!bgSrc) { setBgImg(null); return; } loadImage(bgSrc).then(i => { if (alive) setBgImg(i); }).catch(() => setBgImg(null)); return () => { alive = false; }; }, [bgSrc]);
    useEffect(() => { let alive = true; if (!logoSrc) { setLogoImg(null); return; } loadImage(logoSrc).then(i => { if (alive) setLogoImg(i); }).catch(() => setLogoImg(null)); return () => { alive = false; }; }, [logoSrc]);

    const layoutZones = design && zones ? zones[design.layout] : null;
    // The server's display list for the design being edited (debounced); the plate is composited here.
    useEffect(() => {
        if (!design) return undefined;
        const seq = ++seqRef.current;
        const t = setTimeout(() => {
            badgesApi.preview(conferenceId, { ...design }).then(r => { if (seq === seqRef.current) setPreview(r.badge); }).catch(() => { /* keep the last one */ });
        }, 250);
        return () => clearTimeout(t);
    }, [design, conferenceId, logoImg]);
    const shownLayout = preview ? preview.layout : null;
    useEffect(() => {
        if (!design || !zones || !shownLayout || !zones[shownLayout]) return;
        if (!needsPlate(design, !!bgImg, !!logoImg)) { setPreviewPlate(null); return; }
        try { setPreviewPlate(composePlate({ ...design, layout: shownLayout }, zones[shownLayout], 8, bgImg, logoImg, 0.85).url); } catch { setPreviewPlate(null); }
    }, [design, zones, shownLayout, bgImg, logoImg]);

    const patch = (d: any) => { setDesign((cur: any) => ({ ...cur, ...d })); setDirty(true); };
    const patchColors = (c: any) => { setDesign((cur: any) => ({ ...cur, colors: { ...cur.colors, ...c } })); setDirty(true); };
    const patchPolicy = (p: any) => { setPolicy((cur: any) => ({ ...cur, ...p })); setDirty(true); };
    const labelOf = (key: string) => (available.find(f => f.key === key) || {}).label || key;

    const pickImage = async (kind: 'bg' | 'logo', file: File | null) => {
        if (!file) return;
        try {
            const raw = await readFile(file);
            const scaled = kind === 'bg' ? await scaledSource(raw, 1800, 'image/jpeg') : await scaledSource(raw, 600, 'image/png');
            if (kind === 'bg') setBgSrc(scaled.url); else setLogoSrc(scaled.url);
            // The server's preview reserves the logo's room only once the logo is saved; flag it now.
            setImagesDirty(d => ({ ...d, [kind]: true })); setDirty(true);
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
    };
    const dropImage = (kind: 'bg' | 'logo') => {
        if (kind === 'bg') setBgSrc(null); else setLogoSrc(null);
        setImagesDirty(d => ({ ...d, [kind]: true })); setDirty(true);
    };

    const save = async () => {
        if (!canManage || saving || !design || !layoutZones) return;
        setSaving(true);
        try {
            const putImg = async (kind: string, url: string | null) => {
                if (!url) { await badgesApi.deleteAsset(conferenceId, kind); return; }
                const img = await loadImage(url);
                await badgesApi.putAsset(conferenceId, kind, url, img.naturalWidth, img.naturalHeight);
            };
            if (imagesDirty.bg) await putImg('background_src', bgSrc);
            if (imagesDirty.logo) await putImg('logo_src', logoSrc);
            // The plates: what the PDF and the credential page draw under the text.
            if (needsPlate(design, !!bgImg, !!logoImg)) {
                const z = zones[design.layout];
                const print = composePlate(design, z, PRINT_PX_PER_MM, bgImg, logoImg, 0.9);
                const screen = composePlate(design, z, screenPxPerMm(z), bgImg, logoImg, 0.86);
                await badgesApi.putAsset(conferenceId, 'plate_print', print.url, print.w, print.h);
                await badgesApi.putAsset(conferenceId, 'plate_screen', screen.url, screen.w, screen.h);
            } else {
                await badgesApi.deleteAsset(conferenceId, 'plate_print');
                await badgesApi.deleteAsset(conferenceId, 'plate_screen');
            }
            // The design last: only once its images are in place does it become the conference's badge.
            const r = await badgesApi.saveConfig(conferenceId, design, policy);
            setCfg(r.config); setDesign(r.config.design); setPolicy(r.config.policy);
            setImagesDirty({ bg: false, logo: false }); setDirty(false);
            addToast(tx('badges.saved', 'Escarapela guardada'), 'success');
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setSaving(false); }
    };

    // Text contrast against what is really under it: the composed plate (colour, image, panel) averaged in the
    // title, name and fields zones — the title sits outside the panel, so it is judged on its own background.
    const lowContrast = useMemo(() => {
        if (!design || !layoutZones) return false;
        try {
            const px = 3;
            const c = composePlateCanvas(design, layoutZones, px, bgImg, logoImg);
            return [layoutZones.header, layoutZones.name, layoutZones.lines].some((z) => contrast(design.colors.text, zoneAverage(c, px, z)) < 4.5);
        } catch { return false; }
    }, [design, layoutZones, bgImg, logoImg]);

    if (loading) return <div className="py-16 text-center text-gray-400 text-xs font-black uppercase tracking-widest" data-badges-loading=""><i className="fa-solid fa-spinner animate-spin mr-2"></i>{tx('badges.loading', 'Cargando escarapelas…')}</div>;
    if (error) return <div className="py-10 text-center"><p className="text-rose-600 font-bold text-sm mb-3">{error}</p><button type="button" className={ghost} onClick={load}>{tx('retry', 'Reintentar')}</button></div>;

    const chosen = new Set(design.fields.map(f => f.key));
    const addable = available.filter(f => !chosen.has(f.key));
    const moveField = (i: number, d: number) => {
        const next = design.fields.slice();
        const j = i + d;
        if (j < 0 || j >= next.length) return;
        [next[i], next[j]] = [next[j], next[i]];
        patch({ fields: next });
    };
    const setField = (i: number, f: any) => patch({ fields: design.fields.map((x, k) => (k === i ? { ...x, ...f } : x)) });

    return (
        <div className="space-y-6" data-badges-page="">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h2 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">{tx('badges.title', 'Escarapelas')}</h2>
                    <p className="text-[11px] text-gray-500 font-medium mt-1 max-w-xl">{tx('badges.subtitle', 'La credencial de cada inscrito: una página con su código de barras (la que lee el escáner de comidas) y un PDF para imprimir en tamaño carnet.')}</p>
                </div>
                {canManage && (
                    <button type="button" className={primary} onClick={save} disabled={saving || (cfg.configured && !dirty)} data-badges-save="">
                        <i className={`fa-solid ${saving ? 'fa-spinner animate-spin' : 'fa-floppy-disk'}`}></i>{tx('badges.save', 'Guardar diseño')}
                    </button>
                )}
            </div>
            <ReadOnlyNotice section="badges" />
            {!cfg.configured && <p className="text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3" data-badges-unsaved="">{tx('badges.unconfigured', 'Aún no hay un diseño guardado: los encargados no verán las escarapelas hasta que lo guardes.')}</p>}

            {canLinks && (
                <div className="flex gap-2 max-w-md" role="tablist" aria-label={tx('badges.title', 'Escarapelas')} data-badges-tabs="">
                    <button type="button" role="tab" aria-selected={tab === 'people'} className={seg(tab === 'people')} onClick={() => setTab('people')} data-badges-tab="people">
                        <i className="fa-solid fa-users mr-1.5"></i>{tx('badges.tab.people', 'Personas')}
                    </button>
                    <button type="button" role="tab" aria-selected={tab === 'design'} className={seg(tab === 'design')} onClick={() => setTab('design')} data-badges-tab="design">
                        <i className="fa-solid fa-palette mr-1.5"></i>{tx('badges.tab.design', 'Diseño')}
                    </button>
                </div>
            )}

            {canLinks && tab === 'people' && (
                <PeopleView conferenceId={conferenceId} conference={conference} cfg={cfg} canManage={canManage} tx={tx} addToast={addToast} onDesign={() => setTab('design')} />
            )}

            {/* Hidden, not unmounted, behind «Personas»: an unsaved edit stays. An inline style, because a layered `hidden` loses to core's `grid`. */}
            <div className="grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-6 items-start" style={canLinks && tab === 'people' ? { display: 'none' } : undefined} data-badges-designer="">
                {/* The preview: first on a phone, sticky beside the form on a wide screen. */}
                <div className="xl:order-2 xl:sticky xl:top-0 space-y-3" data-badges-preview="">
                    <div className={card}>
                        <div className="flex items-center justify-between gap-2">
                            <h3 className="text-[11px] font-black uppercase tracking-widest text-gray-500">{tx('badges.preview', 'Vista previa')}</h3>
                            <span className="text-[10px] font-bold text-gray-400">{design.layout === 'vertical' ? '54 × 85,6 mm' : '85,6 × 54 mm'}</span>
                        </div>
                        <div className={`mx-auto ${design.layout === 'vertical' ? 'max-w-[260px]' : 'max-w-[460px]'} rounded-2xl overflow-hidden shadow-lg ring-1 ring-black/5`}>
                            {preview ? <BadgeSvg badge={preview} plate={previewPlate} title={tx('badges.preview', 'Vista previa')} /> : <div className="aspect-[1.585] bg-gray-100 animate-pulse" />}
                        </div>
                        <p className="text-[10px] text-gray-400 text-center">{tx('badges.preview.sample', 'Con una persona de muestra. El código de barras es el que lee el escáner de comidas.')}</p>
                        {lowContrast && <p className="text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2" data-badges-contrast=""><i className="fa-solid fa-circle-half-stroke mr-1.5"></i>{tx('badges.contrast', 'El texto se lee poco sobre este fondo: cambia el color del texto o usa un panel.')}</p>}
                    </div>
                </div>

                <div className="xl:order-1 space-y-6">
                    {/* Policy */}
                    <div className={card} data-badges-policy="">
                        <h3 className="text-[11px] font-black uppercase tracking-widest text-gray-500">{tx('badges.policy', 'Uso')}</h3>
                        <Toggle on={policy.enabled} disabled={locked} onChange={(v) => patchPolicy({ enabled: v })}
                            title={tx('badges.enabled', 'Escarapelas activas')} hint={tx('badges.enabled.hint', 'Apagadas, ningún enlace muestra la escarapela.')} />
                        <Toggle on={policy.portal_enabled} disabled={locked} onChange={(v) => patchPolicy({ portal_enabled: v })}
                            title={tx('badges.portal', 'Los encargados pueden compartirlas')} hint={tx('badges.portal.hint', 'Desde su portal, solo las de su localidad.')} />
                        <div>
                            <label className={label} htmlFor="badge-expires">{tx('badges.expires', 'Los enlaces vencen el')}</label>
                            <div className="flex flex-wrap items-center gap-2">
                                <input id="badge-expires" type="date" className={`${input} max-w-[220px]`} value={policy.expires_on || ''} disabled={locked}
                                    onChange={(e) => patchPolicy({ expires_on: e.target.value || null })} />
                                {canManage && policy.expires_on && <button type="button" className={ghost} onClick={() => patchPolicy({ expires_on: null })}>{tx('badges.expires.none', 'Sin vencimiento')}</button>}
                            </div>
                            <p className="text-[10px] text-gray-400 mt-1">{policy.expires_on ? tx('badges.expires.hint', 'Funcionan hasta ese día, inclusive.') : tx('badges.expires.never', 'Sin fecha: funcionan mientras la inscripción esté activa.')}</p>
                        </div>
                        <div>
                            <label className={label} htmlFor="badge-cc">{tx('badges.cc', 'Código de país para WhatsApp')}</label>
                            <input id="badge-cc" className={`${input} max-w-[120px]`} inputMode="numeric" maxLength={4} value={policy.country_code || ''} disabled={locked}
                                onChange={(e) => patchPolicy({ country_code: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
                            <p className="text-[10px] text-gray-400 mt-1">{tx('badges.cc.hint', 'Se antepone a los celulares de 10 dígitos al enviar por WhatsApp (57 = Colombia).')}</p>
                        </div>
                    </div>

                    {/* «Mi inscripción» (2.23.0): the page the badge's QR opens */}
                    {selfInfo && (() => {
                        const sp = policy.self_page || { enabled: true, type_field: null, number_field: null };
                        const patchSelf = (p: any) => patchPolicy({ self_page: { ...sp, ...p } });
                        const nameOf = (n: string | null) => (n ? (selfInfo.fields.find((f: any) => f.name === n) || {}).label || n : null);
                        const linkOk = typeof selfInfo.link === 'string' && /^https?:\/\//.test(selfInfo.link);
                        return (
                            <div className={card} data-badges-selfpage="">
                                <h3 className="text-[11px] font-black uppercase tracking-widest text-gray-500">{tx('badges.self', 'Página del participante')}</h3>
                                <Toggle on={sp.enabled} disabled={locked} onChange={(v) => patchSelf({ enabled: v })}
                                    title={tx('badges.self.enabled', 'El QR abre «Mi inscripción»')}
                                    hint={tx('badges.self.enabled.hint', 'Al escanear su QR, cada persona escribe su tipo y número de documento y ve su escarapela, sus comidas, su hotel y habitación con el mapa. La cocina sigue escaneando el mismo QR.')} />
                                {sp.enabled && (
                                    <>
                                        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 12rem), 1fr))' }}>
                                            <div>
                                                <label className={label} htmlFor="self-type">{tx('badges.self.type', 'Campo «tipo de documento»')}</label>
                                                <select id="self-type" className={input} value={sp.type_field || ''} disabled={locked} onChange={(e) => patchSelf({ type_field: e.target.value || null })}>
                                                    <option value="">{tx('badges.self.auto', 'Automático')}{!sp.type_field && selfInfo.type_field ? ` (${nameOf(selfInfo.type_field)})` : ''}</option>
                                                    {selfInfo.fields.filter((f: any) => f.type === 'select').map((f: any) => <option key={f.name} value={f.name}>{f.label}</option>)}
                                                </select>
                                            </div>
                                            <div>
                                                <label className={label} htmlFor="self-number">{tx('badges.self.number', 'Campo «número de documento»')}</label>
                                                <select id="self-number" className={input} value={sp.number_field || ''} disabled={locked} onChange={(e) => patchSelf({ number_field: e.target.value || null })}>
                                                    <option value="">{tx('badges.self.auto', 'Automático')}{!sp.number_field && selfInfo.number_field ? ` (${nameOf(selfInfo.number_field)})` : ''}</option>
                                                    {selfInfo.fields.filter((f: any) => f.type !== 'select').map((f: any) => <option key={f.name} value={f.name}>{f.label}</option>)}
                                                </select>
                                            </div>
                                        </div>
                                        {!sp.number_field && !selfInfo.number_field && (
                                            <p className="text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2" role="alert">{tx('badges.self.nonumber', 'El formulario no tiene un campo de número de documento reconocible: elige cuál es, o la página no podrá abrirse.')}</p>
                                        )}
                                        {linkOk ? (
                                            <p className="text-[10px] text-gray-500 break-all">{tx('badges.self.link', 'El QR lleva:')} <span className="font-mono">{selfInfo.link.replace('ABCDEFGHJK', '…')}</span></p>
                                        ) : (
                                            <p className="text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2" role="alert">{tx('badges.self.nolink', 'El plugin no puede leer la dirección del sitio: en Plugins › Conference Manager concede el permiso «settings: read». Mientras tanto el QR lleva solo el código (la cocina lo sigue leyendo).')}</p>
                                        )}
                                        {dirty && <p className="text-[10px] text-gray-400">{tx('badges.self.save', 'Los cambios se aplican al guardar.')}</p>}
                                    </>
                                )}
                            </div>
                        );
                    })()}

                    {/* Design */}
                    <div className={card} data-badges-design="">
                        <h3 className="text-[11px] font-black uppercase tracking-widest text-gray-500">{tx('badges.design', 'Diseño')}</h3>
                        <div>
                            <span className={label}>{tx('badges.layout', 'Orientación')}</span>
                            <div className="flex gap-2">
                                <button type="button" className={seg(design.layout === 'horizontal')} disabled={locked} onClick={() => patch({ layout: 'horizontal' })} aria-pressed={design.layout === 'horizontal'}><i className="fa-solid fa-id-card mr-1.5"></i>{tx('badges.layout.h', 'Horizontal')}</button>
                                <button type="button" className={seg(design.layout === 'vertical')} disabled={locked} onClick={() => patch({ layout: 'vertical' })} aria-pressed={design.layout === 'vertical'}><i className="fa-solid fa-id-badge mr-1.5"></i>{tx('badges.layout.v', 'Vertical')}</button>
                            </div>
                        </div>
                        <div>
                            <label className={label} htmlFor="badge-title">{tx('badges.title.field', 'Título')}</label>
                            <input id="badge-title" className={input} maxLength={80} value={design.title} disabled={locked} placeholder={conference?.name || ''} onChange={(e) => patch({ title: e.target.value })} />
                            <p className="text-[10px] text-gray-400 mt-1">{tx('badges.title.hint', 'Vacío: el nombre de la conferencia.')}</p>
                        </div>
                        {/* Columns from the card width (viewport breakpoints put four 62px boxes beside the preview on a tablet and the hex ran out). */}
                        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 7.5rem), 1fr))' }}>
                            {COLOR_KEYS.map(([k, key, fb]) => (
                                <label key={String(k)} className="block min-w-0">
                                    <span className={label}>{tx(key, fb)}</span>
                                    <span className="flex items-center gap-2 border-2 border-gray-100 rounded-xl px-2 py-1.5">
                                        <input type="color" value={design.colors[k]} disabled={locked} onChange={(e) => patchColors({ [k]: e.target.value })} className="w-9 h-9 shrink-0 rounded-lg border-0 bg-transparent p-0 cursor-pointer" aria-label={tx(key, fb)} />
                                        <span className="text-[11px] font-mono text-gray-600 min-w-0 truncate">{design.colors[k]}</span>
                                    </span>
                                </label>
                            ))}
                        </div>
                        <div>
                            <span className={label}>{tx('badges.panel', 'Panel detrás del texto')}</span>
                            <div className="flex gap-2">
                                {[['none', 'badges.panel.none', 'Ninguno'], ['light', 'badges.panel.light', 'Claro'], ['dark', 'badges.panel.dark', 'Oscuro']].map(([v, key, fb]) => (
                                    <button key={v} type="button" className={seg(design.panel === v)} disabled={locked} onClick={() => patch({ panel: v })} aria-pressed={design.panel === v}>{tx(key, fb)}</button>
                                ))}
                            </div>
                        </div>
                        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 13rem), 1fr))' }}>
                            <ImagePicker title={tx('badges.background', 'Imagen de fondo')} src={bgSrc} disabled={locked} onPick={(f) => pickImage('bg', f)} onDrop={() => dropImage('bg')} tx={tx} />
                            <ImagePicker title={tx('badges.logo', 'Logo')} src={logoSrc} disabled={locked} onPick={(f) => pickImage('logo', f)} onDrop={() => dropImage('logo')} tx={tx} />
                        </div>
                        {imagesDirty.logo && <p className="text-[10px] text-gray-400">{tx('badges.logo.pending', 'El espacio del logo junto al título se ajusta al guardar.')}</p>}
                    </div>

                    {/* Fields */}
                    <div className={card} data-badges-fields="">
                        <div>
                            <h3 className="text-[11px] font-black uppercase tracking-widest text-gray-500">{tx('badges.fields', 'Datos en la escarapela')}</h3>
                            <p className="text-[10px] text-gray-400 mt-1">{tx('badges.fields.hint', 'El nombre y el código van siempre. Escoge el resto y su orden.')}</p>
                        </div>
                        <p className="text-[11px] font-bold text-blue-800 bg-blue-50 border border-blue-100 rounded-xl px-3 py-2" data-badges-capacity={maxRows[design.layout]}>
                            {tx('badges.fields.capacity', 'En {layout} caben {n} datos; los que pasen de ahí no se imprimen.')
                                .replace('{layout}', design.layout === 'vertical' ? tx('badges.layout.v.lower', 'vertical') : tx('badges.layout.h.lower', 'horizontal'))
                                .replace('{n}', String(maxRows[design.layout]))}
                        </p>
                        <ul className="space-y-2">
                            {design.fields.map((f, i) => {
                                const meta = available.find(a => a.key === f.key) || {};
                                const overflow = i >= maxRows[design.layout];
                                return (
                                    <li key={f.key} className={`border-2 rounded-2xl p-3 space-y-2 ${overflow ? 'border-dashed border-gray-200 opacity-70' : 'border-gray-100'}`} data-badge-field={f.key} data-badge-field-fits={overflow ? '0' : '1'}>
                                        <div className="flex items-center gap-2">
                                            <span className="flex-1 min-w-0 text-sm font-bold text-gray-800 truncate">{labelOf(f.key)}</span>
                                            {overflow && <span className="shrink-0 px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 text-[9px] font-black uppercase tracking-widest">{tx('badges.field.nofit', 'No cabe')}</span>}
                                            {canManage && <>
                                                <IconBtn icon="fa-arrow-up" label={tx('badges.field.up', 'Subir')} disabled={i === 0} onClick={() => moveField(i, -1)} />
                                                <IconBtn icon="fa-arrow-down" label={tx('badges.field.down', 'Bajar')} disabled={i === design.fields.length - 1} onClick={() => moveField(i, 1)} />
                                                <IconBtn icon="fa-xmark" label={tx('badges.field.remove', 'Quitar')} onClick={() => patch({ fields: design.fields.filter((_, k) => k !== i) })} />
                                            </>}
                                        </div>
                                        <div className="flex flex-wrap items-center gap-3">
                                            <label className="inline-flex items-center gap-2 text-[11px] font-bold text-gray-600">
                                                <input type="checkbox" checked={f.show_label} disabled={locked} onChange={(e) => setField(i, { show_label: e.target.checked })} className="w-4 h-4" />
                                                {tx('badges.field.showLabel', 'Mostrar la etiqueta')}
                                            </label>
                                            {f.show_label && <input className={`${input} flex-1 min-w-[140px] py-1.5`} maxLength={40} value={f.label || ''} placeholder={labelOf(f.key)} disabled={locked}
                                                onChange={(e) => setField(i, { label: e.target.value })} aria-label={tx('badges.field.label', 'Etiqueta')} />}
                                        </div>
                                        {meta.sensitive && <p className="text-[10px] font-bold text-amber-700"><i className="fa-solid fa-triangle-exclamation mr-1"></i>{tx('badges.field.sensitive', 'Quedará visible para quien tenga el enlace.')}</p>}
                                    </li>
                                );
                            })}
                            {design.fields.length === 0 && <li className="text-xs text-gray-400 italic">{tx('badges.fields.none', 'Solo el nombre y el código.')}</li>}
                        </ul>
                        {canManage && addable.length > 0 && design.fields.length < 8 && (
                            <select className={input} value="" onChange={(e) => { if (e.target.value) patch({ fields: [...design.fields, { key: e.target.value, show_label: true }] }); }} aria-label={tx('badges.field.add', 'Añadir un dato')} data-badge-add-field="">
                                <option value="">{tx('badges.field.add', 'Añadir un dato…')}</option>
                                {addable.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                            </select>
                        )}
                    </div>

                </div>
            </div>
        </div>
    );
}

/** Why the SAVED policy makes every link show nothing (the server's rule: the day ends at UTC−12). */
const linksStateOf = (p: any): 'disabled' | 'expired' | null => {
    if (!p || !p.enabled) return 'disabled';
    if (!p.expires_on) return null;
    const [y, m, d] = String(p.expires_on).split('-').map(Number);
    return Date.now() >= Date.UTC(y, m - 1, d + 1, 12) ? 'expired' : null;
};

function Toggle({ on, onChange, title, hint, disabled }: any) {
    return (
        <button type="button" role="switch" aria-checked={!!on} disabled={disabled} onClick={() => onChange(!on)}
            className="w-full flex items-start gap-3 text-left disabled:opacity-70">
            <span className={`mt-0.5 w-11 h-6 shrink-0 rounded-full transition-colors relative ${on ? 'bg-blue-600' : 'bg-gray-200'}`}>
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`}></span>
            </span>
            <span className="min-w-0">
                <span className="block text-sm font-bold text-gray-800">{title}</span>
                {hint && <span className="block text-[11px] text-gray-500">{hint}</span>}
            </span>
        </button>
    );
}

function IconBtn({ icon, label: aria, onClick, disabled }: any) {
    return (
        <button type="button" onClick={onClick} disabled={disabled} aria-label={aria} title={aria}
            className="w-9 h-9 shrink-0 rounded-xl border-2 border-gray-100 text-gray-500 hover:border-blue-300 disabled:opacity-30 flex items-center justify-center">
            <i className={`fa-solid ${icon} text-[11px]`}></i>
        </button>
    );
}

function ImagePicker({ title, src, onPick, onDrop, disabled, tx }: any) {
    const ref = useRef<HTMLInputElement | null>(null);
    return (
        <div className="border-2 border-dashed border-gray-200 rounded-2xl p-3 flex items-center gap-3 min-w-0">
            <div className="w-16 h-12 shrink-0 rounded-lg bg-gray-50 border border-gray-100 overflow-hidden flex items-center justify-center">
                {src ? <img src={src} alt="" className="w-full h-full object-contain" /> : <i className="fa-regular fa-image text-gray-300"></i>}
            </div>
            <div className="min-w-0 flex-1">
                <div className="text-[11px] font-black uppercase tracking-widest text-gray-600 truncate">{title}</div>
                <div className="flex flex-wrap gap-2 mt-1.5">
                    <button type="button" className="text-[11px] font-bold text-blue-600 hover:underline disabled:opacity-50" disabled={disabled} onClick={() => ref.current && ref.current.click()}>{src ? tx('badges.image.change', 'Cambiar') : tx('badges.image.pick', 'Subir imagen')}</button>
                    {src && <button type="button" className="text-[11px] font-bold text-rose-600 hover:underline disabled:opacity-50" disabled={disabled} onClick={onDrop}>{tx('badges.image.remove', 'Quitar')}</button>}
                </div>
                <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; onPick(f || null); }} />
            </div>
        </div>
    );
}

/** People shown at first and per «Mostrar más»: a long list stays quick on a phone. */
const PEOPLE_PAGE = 60;
const rowBtn = 'min-h-[40px] min-w-0 px-2.5 rounded-xl font-black text-[10px] uppercase tracking-wider inline-flex items-center justify-center gap-1.5 bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-400 disabled:opacity-50';
/** A counter text: the «.one» key for 1, else the plural one, with {n} filled. */
const countText = (tx: any, key: string, n: number, plural: string, one: string) => (n === 1 ? tx(`${key}.one`, one) : tx(key, plural)).replace('{n}', String(n));
const fold = (s: any) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * «Personas»: every active registrant with their own badge — open it (the badge as it looks, and everything to
 * do with it: BadgeActions), copy its link, send it by WhatsApp — found by name, code or location; and, below,
 * everyone's at once (the location chosen here, or all).
 */
function PeopleView({ conferenceId, conference, cfg, canManage, tx, addToast, onDesign }: any) {
    const [people, setPeople] = useState<any[] | null>(null);
    const [fields, setFields] = useState<any[]>([]);
    const [locations, setLocations] = useState<any[]>([]);
    const [links, setLinks] = useState<Map<number, any>>(() => new Map());
    const [cc, setCc] = useState<string>((cfg && cfg.policy && cfg.policy.country_code) || '57');
    const [base, setBase] = useState('');
    const [error, setError] = useState('');
    const [q, setQ] = useState('');
    const [loc, setLoc] = useState('');
    const [limit, setLimit] = useState(PEOPLE_PAGE);
    const [open, setOpen] = useState<any>(null);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [attempt, setAttempt] = useState(0);
    const configured = !!(cfg && cfg.configured);
    const state = linksStateOf(cfg && cfg.policy);

    const linkMap = (list: any[]) => new Map((list || []).map((l) => [Number(l.inscription_id), l]));
    const mergeLinks = (list: any[]) => setLinks((cur) => { const m = new Map(cur); for (const l of list || []) m.set(Number(l.inscription_id), l); return m; });
    // Whole-map loads are numbered: only the latest one lands (a slow first load must not undo a revoke).
    const linkSeq = useRef(0);
    const loadLinks = (fn: () => Promise<any>, after?: (r: any) => void) => {
        const seq = ++linkSeq.current;
        return fn().then((r) => { if (seq !== linkSeq.current) return; setLinks(linkMap(r.links)); if (after) after(r); });
    };
    // After a regenerate or a revoke: what exists now (a revoked link must not linger here).
    const refreshLinks = () => { loadLinks(() => badgesApi.existingLinks(conferenceId)).catch(() => { /* keep the last known */ }); };

    useEffect(() => {
        let alive = true;
        setError(''); setPeople(null);
        Promise.all([
            conferenceApi.getInscriptions(conferenceId),
            conferenceApi.getFields(conferenceId),
            conferenceApi.getLocations(conferenceId).catch(() => null),
            publicBase(),
        ]).then(([rows, f, l, b]) => {
            if (!alive) return;
            setPeople((rows || []).filter((r: any) => r.status !== 'cancelled'));
            setFields(f || []); setLocations((l && l.locations) || []); setBase(b);
        }).catch((e) => { if (alive) setError(e?.message || 'Error'); });
        // Every active person's link, made now, so «Copiar» and «WhatsApp» work in one tap (a phone allows a
        // copy or a new window only inside the tap). Too many at once: the existing ones, the rest on demand.
        if (configured) {
            loadLinks(() => badgesApi.links(conferenceId, { all: true }), (r) => { if (alive && r.country_code) setCc(r.country_code); })
                .catch(() => loadLinks(() => badgesApi.existingLinks(conferenceId)).catch(() => { /* on demand */ }));
        }
        return () => { alive = false; linkSeq.current++; };
    }, [conferenceId, configured, attempt]);
    useEffect(() => { setLimit(PEOPLE_PAGE); }, [q, loc]);

    const placeOf = (r: any) => {
        const id = personLocationId(r, locations);
        const hit = id != null ? locations.find((l) => Number(l.id) === id) : null;
        return hit ? hit.name : (r.location || '');
    };
    const shown = useMemo(() => {
        const needle = fold(q.trim());
        return (people || [])
            .map((r) => ({ r, name: personDisplayName(r, fields), place: placeOf(r) }))
            .filter((x) => (!loc || String(rawLocationId(x.r)) === loc)
                && (!needle || fold(x.name).includes(needle) || fold(x.place).includes(needle) || fold(x.r.reg_code).includes(needle)));
        // placeOf reads `locations`, which is in the list.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [people, fields, locations, q, loc]);

    const intro = tx('badges.share.intro', 'Tu escarapela de {conference}').replace('{conference}', (conference && conference.name) || '');
    const copyOne = async (r: any) => {
        if (busyId != null) return;
        setBusyId(Number(r.id));
        try {
            const known = links.get(Number(r.id));
            // Started inside the tap (Safari); a person without a link yet gets one now.
            const url = known ? Promise.resolve(badgeUrl(known.token, base)) : badgesApi.links(conferenceId, { inscription_ids: [Number(r.id)] }).then((x) => {
                const l = x.links && x.links[0];
                if (!l) throw new Error(tx('badges.person.cancelled', 'Una inscripción cancelada no tiene escarapela.'));
                mergeLinks([l]);
                return badgeUrl(l.token, base);
            });
            if (await copyLater(url)) addToast(tx('badges.act.copied', 'Enlace copiado'), 'success');
            else addToast(await url, 'info');
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setBusyId(null); }
    };

    if (!configured) {
        return (
            <div className={card} data-badges-people="unsaved">
                <p className="text-sm font-bold text-gray-700">{tx('badges.people.unsaved', 'Guarda el diseño primero: después aquí verás la escarapela de cada persona.')}</p>
                <button type="button" className={ghost} onClick={onDesign}><i className="fa-solid fa-palette"></i>{tx('badges.people.toDesign', 'Ir al diseño')}</button>
            </div>
        );
    }
    const locName = loc ? (locations.find((l) => String(l.id) === loc) || {}).name : null;
    const total = people ? people.length : 0;
    return (
        <div className="space-y-6" data-badges-people="">
            {state && (
                <p className="text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3" role="note" data-badges-state={state}>
                    {state === 'disabled'
                        ? tx('badges.state.disabled.bulk', 'Las escarapelas están apagadas: los enlaces no muestran nada hasta que las actives.')
                        : tx('badges.state.expired.bulk', 'Las escarapelas ya vencieron: los enlaces no muestran nada hasta que cambies la fecha.')}
                </p>
            )}
            <div className={card}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-[11px] font-black uppercase tracking-widest text-gray-500">{tx('badges.people.list', 'Escarapelas por persona')}</h3>
                    {people && <span className="text-[11px] font-bold text-gray-500" data-badges-people-count={shown.length}>
                        {shown.length === total
                            ? countText(tx, 'badges.people.count', total, '{n} personas', '1 persona')
                            : tx('badges.people.count.filtered', '{n} de {total} personas').replace('{n}', String(shown.length)).replace('{total}', String(total))}
                    </span>}
                </div>
                <div className="flex flex-wrap gap-2">
                    <input type="search" className={`${input} flex-1 min-w-[12rem]`} value={q} onChange={(e) => setQ(e.target.value)}
                        placeholder={tx('badges.people.search', 'Buscar por nombre, código o localidad')} aria-label={tx('badges.people.search', 'Buscar por nombre, código o localidad')} data-badges-search="" />
                    <select className={`${input} flex-1 min-w-[12rem]`} value={loc} onChange={(e) => setLoc(e.target.value)} aria-label={tx('badges.bulk.location', 'Localidad')} data-badges-location="">
                        <option value="">{tx('badges.bulk.all', 'Todas las localidades')}</option>
                        {locations.map((l) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                    </select>
                </div>
                {error ? (
                    <div className="py-6 text-center"><p className="text-rose-600 font-bold text-sm mb-3">{error}</p><button type="button" className={ghost} onClick={() => setAttempt((n) => n + 1)}>{tx('retry', 'Reintentar')}</button></div>
                ) : !people ? (
                    <div className="py-8 text-center text-gray-400 text-xs font-black uppercase tracking-widest"><i className="fa-solid fa-spinner animate-spin mr-2"></i>{tx('badges.loading', 'Cargando escarapelas…')}</div>
                ) : total === 0 ? (
                    <p className="py-6 text-center text-xs text-gray-400 italic">{tx('badges.people.empty', 'Aún no hay inscritos activos.')}</p>
                ) : shown.length === 0 ? (
                    <p className="py-6 text-center text-xs text-gray-400 italic">{tx('badges.people.none', 'Nadie coincide con la búsqueda.')}</p>
                ) : (
                    <ul className="divide-y divide-gray-100" data-badges-people-list="">
                        {shown.slice(0, limit).map(({ r, name, place }) => {
                            const link = links.get(Number(r.id));
                            const url = link ? badgeUrl(link.token, base) : '';
                            const phone = phoneOfRow(r, fields);
                            const number = waNumber(phone, cc);
                            const views = link ? (link.view_count > 0 ? countText(tx, 'badges.people.opened', Number(link.view_count), 'Abierta {n} veces', 'Abierta 1 vez') : tx('badges.people.unopened', 'Sin abrir')) : '';
                            return (
                                <li key={r.id} className="py-3 flex flex-wrap items-center gap-x-4 gap-y-2" data-badge-person={r.id}>
                                    <button type="button" className="min-w-0 text-left" style={{ flex: '1 1 14rem' }} onClick={() => setOpen(r)}
                                        title={tx('badges.people.view.title', 'Ver la escarapela de {name}').replace('{name}', name)}>
                                        <span className="block text-sm font-bold text-gray-900 truncate">{name}</span>
                                        <span className="block text-[11px] text-gray-500 truncate">{place || tx('badges.people.noloc', 'Sin localidad')}{views ? ` · ${views}` : ''}</span>
                                    </button>
                                    <div className="flex gap-1.5 max-w-full">
                                        <button type="button" className={rowBtn} onClick={() => setOpen(r)} data-badge-row="view"
                                            aria-label={tx('badges.people.view.title', 'Ver la escarapela de {name}').replace('{name}', name)}>
                                            <i className="fa-solid fa-id-badge" aria-hidden="true"></i>{tx('badges.people.view', 'Ver')}
                                        </button>
                                        <button type="button" className={rowBtn} onClick={() => copyOne(r)} disabled={busyId != null} data-badge-row="copy"
                                            aria-label={tx('badges.people.copy.title', 'Copiar el enlace de {name}').replace('{name}', name)}>
                                            <i className={`fa-solid ${busyId === Number(r.id) ? 'fa-spinner animate-spin' : 'fa-copy'}`} aria-hidden="true"></i>{tx('badges.people.copy', 'Copiar')}
                                        </button>
                                        {link ? (
                                            <a className={rowBtn} href={whatsappUrl(phone, `${intro}: ${url}`, cc)} target="_blank" rel="noopener noreferrer" data-badge-row="whatsapp"
                                                title={number ? `+${number}` : tx('badges.act.whatsapp.hint', 'No hay un teléfono válido en la inscripción: WhatsApp se abrirá para escoger el contacto.')}>
                                                <i className="fa-brands fa-whatsapp" aria-hidden="true"></i>WhatsApp
                                            </a>
                                        ) : (
                                            <span className={`${rowBtn} opacity-40`} aria-disabled="true"><i className="fa-brands fa-whatsapp" aria-hidden="true"></i>WhatsApp</span>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
                {people && shown.length > limit && (
                    <button type="button" className={`${ghost} w-full`} onClick={() => setLimit((n) => n + PEOPLE_PAGE)} data-badges-more="">
                        {countText(tx, 'badges.people.more', shown.length - limit, 'Mostrar más ({n} restantes)', 'Mostrar 1 más')}
                    </button>
                )}
            </div>

            <BulkTools conferenceId={conferenceId} conference={conference} tx={tx} addToast={addToast} loc={loc} locName={locName}
                placeOf={placeOf} onLinks={mergeLinks} />

            {open && (
                <BadgeActions person={open} name={personDisplayName(open, fields)} fields={fields} conferenceId={conferenceId}
                    conferenceName={(conference && conference.name) || ''} canManage={canManage}
                    onClose={() => { setOpen(null); refreshLinks(); }} />
            )}
        </div>
    );
}

/** Everyone's links and PDFs at once: the location chosen in the person list, or the whole conference. */
function BulkTools({ conferenceId, conference, tx, addToast, loc, locName, placeOf, onLinks }: any) {
    const [busy, setBusy] = useState('');
    const [count, setCount] = useState<number | null>(null);
    // What could not be copied (no clipboard): shown to copy by hand.
    const [manual, setManual] = useState<string | null>(null);
    useEffect(() => { setCount(null); }, [loc]);
    const scope = () => (loc ? { location_id: Number(loc) } : { all: true });
    const run = async (what: string, fn: () => Promise<void>) => {
        if (busy) return;
        setBusy(what);
        try { await fn(); } catch (e: any) { addToast(e?.message || 'Error', 'error'); } finally { setBusy(''); }
    };
    const links = async () => { const r = await badgesApi.links(conferenceId, scope()); if (onLinks) onLinks(r.links); return r.links; };
    // The roster as it is now (someone may have registered since the list loaded).
    const roster = async () => {
        const [rows, f] = await Promise.all([conferenceApi.getInscriptions(conferenceId), conferenceApi.getFields(conferenceId)]);
        return { m: new Map((rows || []).map((r: any) => [Number(r.id), r])), f: f || [] };
    };
    const nameOf = (m: Map<number, any>, f: any[], id: number) => (m.has(id) ? personDisplayName(m.get(id), f) : `#${id}`);
    return (
        <div className="bg-white rounded-3xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-4" data-badges-bulk="">
            <div>
                <h3 className="text-[11px] font-black uppercase tracking-widest text-gray-500">
                    {tx('badges.bulk', 'Todas a la vez')}{locName ? ` · ${locName}` : ''}
                </h3>
                <p className="text-[10px] text-gray-400 mt-1">{tx('badges.bulk.hint', 'Las de la localidad escogida arriba, o las de todos si no escoges ninguna.')}</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button type="button" className={ghost} disabled={!!busy} data-bulk="copy"
                    onClick={() => run('copy', async () => {
                        // The text is fetched while the copy is already under way (Safari: inside the click).
                        let n = 0;
                        const text = (async () => {
                            const [list, { m, f }, base] = await Promise.all([links(), roster(), publicBase()]);
                            n = list.length;
                            return list.map((l: any) => `${nameOf(m, f, l.inscription_id)}: ${badgeUrl(l.token, base)}`).join('\n');
                        })();
                        if (await copyLater(text)) { setCount(n); addToast(tx('badges.bulk.copied', '{n} enlaces copiados').replace('{n}', String(n)), 'success'); }
                        else setManual(await text);
                    })}>
                    <i className={`fa-solid ${busy === 'copy' ? 'fa-spinner animate-spin' : 'fa-copy'}`}></i>{tx('badges.bulk.copy', 'Copiar todos los enlaces')}
                </button>
                <button type="button" className={ghost} disabled={!!busy} data-bulk="xlsx"
                    onClick={() => run('xlsx', async () => {
                        const [list, { m, f }, base] = await Promise.all([links(), roster(), publicBase()]);
                        setCount(list.length);
                        const rows = list.map((l: any) => {
                            const r = m.get(l.inscription_id);
                            return [nameOf(m, f, l.inscription_id), r ? placeOf(r) : '', r ? phoneOfRow(r, f) : '', badgeUrl(l.token, base)];
                        });
                        const cols = [
                            { header: tx('badges.xlsx.name', 'Nombre'), width: 32 }, { header: tx('badges.xlsx.location', 'Localidad'), width: 22 },
                            { header: tx('badges.xlsx.phone', 'Teléfono'), width: 16 }, { header: tx('badges.xlsx.link', 'Enlace'), width: 70 },
                        ];
                        const bytes = buildXlsx([{ name: tx('badges.title', 'Escarapelas'), columns: cols, rows }]);
                        downloadXlsx(bytes, exportFilename(`${tx('badges.xlsx.file', 'escarapelas')}${locName ? '-' + locName : ''}`, conference?.slug));
                    })}>
                    <i className={`fa-solid ${busy === 'xlsx' ? 'fa-spinner animate-spin' : 'fa-file-excel'}`}></i>{tx('badges.bulk.xlsx', 'Enlaces en Excel')}
                </button>
                <button type="button" className={ghost} disabled={!!busy} data-bulk="sheet"
                    onClick={() => run('sheet', () => openBadgeFileFrom(async () => (await badgesApi.ticket(conferenceId, scope(), 'letter')).d))}>
                    <i className={`fa-solid ${busy === 'sheet' ? 'fa-spinner animate-spin' : 'fa-print'}`}></i>{tx('badges.bulk.sheet', 'PDF para imprimir (hoja Carta)')}
                </button>
                <button type="button" className={ghost} disabled={!!busy} data-bulk="single"
                    onClick={() => run('single', () => openBadgeFileFrom(async () => (await badgesApi.ticket(conferenceId, scope(), 'single')).d))}>
                    <i className={`fa-solid ${busy === 'single' ? 'fa-spinner animate-spin' : 'fa-file-pdf'}`}></i>{tx('badges.bulk.single', 'PDF una por página')}
                </button>
            </div>
            {count != null && <p className="text-[11px] font-bold text-emerald-700" data-bulk-count={count}>{tx('badges.bulk.count', '{n} enlaces listos').replace('{n}', String(count))}</p>}
            {manual != null && (
                <div className="space-y-2" data-bulk-manual="">
                    <p className="text-[11px] font-bold text-amber-800">{tx('badges.bulk.manual', 'Este navegador no dejó copiar: selecciona el texto y cópialo.')}</p>
                    <textarea readOnly value={manual} rows={6} className={`${input} font-mono text-[11px]`} onFocus={(e) => e.currentTarget.select()} />
                    <button type="button" className={ghost} onClick={() => setManual(null)}>{tx('close', 'Cerrar')}</button>
                </div>
            )}
        </div>
    );
}
