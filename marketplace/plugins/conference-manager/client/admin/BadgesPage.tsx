// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Escarapelas» (2.19.0) — the conference's badge: its design (orientation, title, colours, background image,
 * logo, legibility panel, the fields and their labels), its policy (on / off, coordinators may share, expiry
 * date) and the bulk tools (links and PDFs per location). One design per conference (owner decision D5).
 *
 * 2.29.0: «Diseño» is a free-form designer (BadgeEditor: templates, texts in 14 typefaces with the person's data,
 * shapes, images, the QR; drag, resize, rotate, layers, undo) drawing the server's own layout; a pre-2.29 design
 * opens converted, and keeps printing as it was until it is saved. «Ajustes» holds the policy and «Mi inscripción».
 * «Escarapelas › ver» sees everything and uses the bulk tools (with «Inscripciones › ver»); «› administrar»
 * edits. Two views: «Personas» (each person's badge — view, copy, WhatsApp — and everyone's at once) and
 * «Diseño». The per-person overlay (BadgeActions) is also in the person sheet.
 *
 * 2.36.0: «Diseño» has two targets — «Escarapela virtual» (the one shown on the phone) and «Sticker para imprimir»
 * (a label for a sticker printer, to stick on the physical badge: its own size, the same designer). Both are saved
 * together; stickers print one per PDF page at the label's exact size (for a person, the list shown, a locality or
 * everyone).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { conferenceApi } from "../lib/conference";
import { buildXlsx, downloadXlsx } from "../lib/xlsx";
import { exportFilename } from "../lib/exports";
import { personDisplayName, personLocationId, rawLocationId } from "../lib/lodgingView";
import {
    badgesApi, copyLater, loadImage, openBadgeFileFrom, publicBase,
    linkUrl, waNumber, whatsappUrl,
} from "../lib/badges";
import { usePerms, ReadOnlyNotice } from "./perms";
import { useTx } from "./MealScanner";
import { BadgeActions, phoneOfRow } from "./BadgeActions";
import { BadgeEditor } from "./BadgeEditor";
import { TEMPLATES, fromLegacy, sampleData } from "../lib/badgeEditor";
import { DateField } from "../lib/DateField";
import { Select } from "../lib/Select";
import { StickerPrint } from "./StickerPrint";

const card = 'bg-white rounded-3xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-4';
const label = 'block text-[10px] font-black uppercase tracking-widest text-gray-500 mb-1.5';
const input = 'w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/40 focus:bg-white focus:border-blue-500 outline-none text-sm text-gray-900 font-medium';
const btn = 'min-h-[44px] px-4 rounded-2xl font-black text-[11px] uppercase tracking-widest inline-flex items-center justify-center gap-2 disabled:opacity-50';
const ghost = `${btn} bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-400`;
const primary = `${btn} bg-gray-900 text-white hover:bg-blue-600`;
const seg = (on: boolean) => `flex-1 min-h-[40px] px-3 rounded-xl text-[11px] font-black uppercase tracking-widest border-2 ${on ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-100 text-gray-500 hover:border-gray-300'}`;

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
    const [sticker, setSticker] = useState<any>(null);
    const [target, setTarget] = useState<'badge' | 'sticker'>('badge');
    const [policy, setPolicy] = useState<any>(null);
    const [available, setAvailable] = useState<any[]>([]);
    // «Mi inscripción» (2.23.0): the form fields, the document fields in use and the QR's link.
    const [selfInfo, setSelfInfo] = useState<any>(null);
    // 2.29.0: the free-form designer's image gallery ({ id, w, h, url }) and the editor's generation (a reload remounts it).
    const [images, setImages] = useState<any[]>([]);
    const [editorKey, setEditorKey] = useState(0);
    const [converted, setConverted] = useState(false);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    // Nothing is editable while a save runs: an edit made then would be overwritten by the saved design.
    const locked = !canManage || saving;
    // «Personas» once there is a saved design (and the person may see the links), else «Diseño».
    const [tab, setTab] = useState<'people' | 'design' | 'settings'>('design');
    const tabChosen = useRef(false);

    const load = async () => {
        setLoading(true); setError('');
        try {
            const r = await badgesApi.getConfig(conferenceId);
            if (!tabChosen.current) { tabChosen.current = true; setTab(r.config.configured && canLinks ? 'people' : 'design'); }
            setCfg(r.config); setPolicy(r.config.policy);
            setAvailable(r.available_fields || []); setSelfInfo(r.self_page || null);
            // The gallery: every image uploaded for this conference's designs.
            const imgs = await Promise.all((r.assets || []).filter((a: any) => /^img_[0-9a-f]{16}$/.test(a.kind)).map(async (a: any) => {
                try { const g = await badgesApi.getAsset(conferenceId, a.kind); return { id: a.kind.slice(4), w: g.width || a.width, h: g.height || a.height, url: g.data_url }; } catch { return null; }
            }));
            let gallery = imgs.filter(Boolean);
            let d = r.config.design;
            let wasLegacy = false;
            if (!d || d.version !== 2) {
                // A pre-2.29 design opens in the new designer as it looks; its background and logo join the gallery.
                wasLegacy = true;
                const kinds = new Set((r.assets || []).map((a: any) => a.kind));
                const lift = async (kind: string) => {
                    if (!canManage || !kinds.has(kind)) return null;
                    try {
                        const g = await badgesApi.getAsset(conferenceId, kind);
                        const img = await loadImage(g.data_url);
                        const up = await badgesApi.putImage(conferenceId, g.data_url, img.naturalWidth, img.naturalHeight);
                        const entry = { id: up.id, w: img.naturalWidth, h: img.naturalHeight, url: g.data_url };
                        if (!gallery.some((x: any) => x.id === entry.id)) gallery = [...gallery, entry];
                        return entry;
                    } catch { return null; }
                };
                const bg = await lift('background_src');
                const logo = await lift('logo_src');
                const labelOf = (key: string) => ((r.available_fields || []).find((f: any) => f.key === key) || {}).label || key;
                const rows = r.max_rows ? r.max_rows[(d && d.layout) === 'vertical' ? 'vertical' : 'horizontal'] : 3;
                d = r.config.configured ? fromLegacy(d, r.zones, { bg, logo }, labelOf, rows) : TEMPLATES[0].make();
            }
            setImages(gallery);
            setSticker(r.config.sticker || null);
            setDesign(d); setConverted(wasLegacy && r.config.configured);
            setEditorKey(k => k + 1);
            setDirty(wasLegacy && !r.config.configured ? false : false);
        } catch (e: any) { setError(e?.message || 'Error'); }
        finally { setLoading(false); }
    };
    useEffect(() => { load(); }, [conferenceId]);

    const patchPolicy = (p: any) => { setPolicy((cur: any) => ({ ...cur, ...p })); setDirty(true); };
    const onDesign = useCallback((d: any) => { setDesign(d); setDirty(true); }, []);
    const onSticker = useCallback((d: any) => { setSticker(d); setDirty(true); }, []);

    // The data the designer's texts can show, with their labels (and a sample person for the canvas).
    const tokenLabels = useMemo(() => {
        const out: Record<string, string> = { '@name': tx('badges.ed.token.name', 'Nombre completo'), '@code': tx('badges.ed.token.code', 'Código') };
        for (const f of available) out[f.key] = f.label;
        return out;
    }, [available]);
    const tokenShown = useMemo(() => Object.fromEntries(Object.entries(tokenLabels).map(([k, v]) => [k, `[${v}]`])), [tokenLabels]);
    const sample = useMemo(() => sampleData(conference, available), [conference, available]);
    const qrSample = selfInfo && typeof selfInfo.link === 'string' && /^https?:\/\//.test(selfInfo.link) ? selfInfo.link.replace('ABCDEFGHJK', 'ABCD2345EF') : 'ABCD2345EF';

    const save = async () => {
        if (!canManage || saving || !design) return;
        setSaving(true);
        try {
            const r = await badgesApi.saveConfig(conferenceId, design, policy, sticker);
            setCfg(r.config); setPolicy(r.config.policy); setConverted(false);
            setDirty(false);
            addToast(tx('badges.saved', 'Escarapela guardada'), 'success');
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setSaving(false); }
    };

    if (loading) return <div className="py-16 text-center text-gray-400 text-xs font-black uppercase tracking-widest" data-badges-loading=""><i className="fa-solid fa-spinner animate-spin mr-2"></i>{tx('badges.loading', 'Cargando escarapelas…')}</div>;
    if (error) return <div className="py-10 text-center"><p className="text-rose-600 font-bold text-sm mb-3">{error}</p><button type="button" className={ghost} onClick={load}>{tx('retry', 'Reintentar')}</button></div>;

    return (
        <div className="space-y-6" data-badges-page="">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h2 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">{tx('badges.title', 'Escarapelas')}</h2>
                    <p className="text-[11px] text-gray-500 font-medium mt-1 max-w-xl">{tx('badges.subtitle2', 'La credencial de cada inscrito: diséñala a tu gusto; cada persona la ve en «Mi inscripción» y se imprime en PDF tamaño carnet, con el QR que lee el escáner de comidas.')}</p>
                </div>
                {canManage && (
                    <button type="button" className={primary} onClick={save} disabled={saving || (cfg.configured && !dirty)} data-badges-save="">
                        <i className={`fa-solid ${saving ? 'fa-spinner animate-spin' : 'fa-floppy-disk'}`}></i>{tx('badges.save', 'Guardar diseño')}
                    </button>
                )}
            </div>
            <ReadOnlyNotice section="badges" />
            {!cfg.configured && <p className="text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3" data-badges-unsaved="">{tx('badges.unconfigured', 'Aún no hay un diseño guardado: los encargados no verán las escarapelas hasta que lo guardes.')}</p>}
            {converted && canManage && <p className="text-xs font-bold text-blue-800 bg-blue-50 border border-blue-100 rounded-2xl px-4 py-3" data-badges-converted="">{tx('badges.converted', 'Tu diseño anterior se abrió en el editor nuevo. Revísalo y guárdalo para empezar a usarlo; mientras no lo guardes, las escarapelas siguen como estaban.')}</p>}

            <div className="flex gap-2 max-w-xl" role="tablist" aria-label={tx('badges.title', 'Escarapelas')} data-badges-tabs="">
                {canLinks && (
                    <button type="button" role="tab" aria-selected={tab === 'people'} className={seg(tab === 'people')} onClick={() => setTab('people')} data-badges-tab="people">
                        <i className="fa-solid fa-users mr-1.5"></i>{tx('badges.tab.people', 'Personas')}
                    </button>
                )}
                <button type="button" role="tab" aria-selected={tab === 'design'} className={seg(tab === 'design')} onClick={() => setTab('design')} data-badges-tab="design">
                    <i className="fa-solid fa-palette mr-1.5"></i>{tx('badges.tab.design', 'Diseño')}
                </button>
                <button type="button" role="tab" aria-selected={tab === 'settings'} className={seg(tab === 'settings')} onClick={() => setTab('settings')} data-badges-tab="settings">
                    <i className="fa-solid fa-sliders mr-1.5"></i>{tx('badges.tab.settings', 'Ajustes')}
                </button>
            </div>

            {canLinks && tab === 'people' && (
                <PeopleView conferenceId={conferenceId} conference={conference} cfg={cfg} canManage={canManage} tx={tx} addToast={addToast} onDesign={() => setTab('design')} />
            )}

            {/* Hidden, not unmounted: an unsaved edit (and the designer's undo history) stays. An inline style, because a layered `hidden` loses to core's `grid`. */}
            <div style={tab === 'design' ? undefined : { display: 'none' }} data-badges-designer="">
                {/* 2.36.0: what is being designed — the badge on the phone, or the printed sticker for the physical one. */}
                <div className="flex gap-2 max-w-xl mb-3" role="tablist" aria-label={tx('badges.target', 'Qué diseñas')} data-badges-target="">
                    <button type="button" role="tab" aria-selected={target === 'badge'} className={seg(target === 'badge')} onClick={() => setTarget('badge')} data-badges-target-tab="badge">
                        <i className="fa-solid fa-mobile-screen mr-1.5"></i>{tx('badges.target.badge', 'Escarapela virtual')}
                    </button>
                    <button type="button" role="tab" aria-selected={target === 'sticker'} className={seg(target === 'sticker')} onClick={() => setTarget('sticker')} data-badges-target-tab="sticker">
                        <i className="fa-solid fa-note-sticky mr-1.5"></i>{tx('badges.target.sticker', 'Sticker para imprimir')}
                    </button>
                </div>
                {target === 'sticker' && (
                    <div className="text-[11px] text-gray-600 bg-gray-50 border border-gray-100 rounded-2xl px-4 py-3 mb-3 space-y-1" data-badges-sticker-help="">
                        <p className="font-bold text-gray-800">{tx('badges.sticker.help.title', 'Una etiqueta por persona, del tamaño exacto de tu rollo de stickers.')}</p>
                        <p>{tx('badges.sticker.help.size', 'Escoge el tamaño de la etiqueta arriba del diseño (o «Personalizado» en mm). Las impresoras de stickers imprimen en negro: diseña en blanco y negro.')}</p>
                        <p>{tx('badges.sticker.help.print', 'Para imprimir: «Personas» › «Imprimir stickers» (o el botón de cada persona). En la ventana de impresión escoge la impresora de stickers y el tamaño de la etiqueta, «Márgenes: ninguno» y «Escala: 100 %» (o «Tamaño real»).')}</p>
                    </div>
                )}
                <div style={target === 'badge' ? undefined : { display: 'none' }}>
                    {design && (
                        <BadgeEditor key={editorKey} conferenceId={conferenceId} initial={design} onChange={onDesign} images={images} onImages={setImages}
                            sample={sample} tokenLabels={tokenLabels} tokenShown={tokenShown} qrSample={qrSample} locked={locked} canManage={canManage} tx={tx} addToast={addToast}
                            onSave={save} dirty={dirty || !cfg.configured} saving={saving} />
                    )}
                </div>
                <div style={target === 'sticker' ? undefined : { display: 'none' }} data-badges-sticker-designer="">
                    {sticker && (
                        <BadgeEditor key={`sticker-${editorKey}`} conferenceId={conferenceId} initial={sticker} onChange={onSticker} images={images} onImages={setImages}
                            sample={sample} tokenLabels={tokenLabels} tokenShown={tokenShown} qrSample={qrSample} locked={locked} canManage={canManage} tx={tx} addToast={addToast}
                            onSave={save} dirty={dirty || !cfg.configured} saving={saving} />
                    )}
                </div>
            </div>

            {tab === 'settings' && (
                <div className="grid xl:grid-cols-2 gap-6 items-start" data-badges-settings="">
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
                                <div className="w-full max-w-[220px]">
                                    <DateField id="badge-expires" value={policy.expires_on || ''} disabled={locked} clearable={false}
                                        onChange={(v) => patchPolicy({ expires_on: v || null })} />
                                </div>
                                {canManage && policy.expires_on && <button type="button" className={ghost} onClick={() => patchPolicy({ expires_on: null })}>{tx('badges.expires.none', 'Sin vencimiento')}</button>}
                            </div>
                            <p className="text-[10px] text-gray-400 mt-1">{policy.expires_on ? tx('badges.expires.hint', 'Funcionan hasta ese día, inclusive.') : tx('badges.expires.never', 'Sin fecha: funcionan mientras la inscripción esté activa.')}</p>
                        </div>
                        <div>
                            <label className={label} htmlFor="badge-cc">{tx('badges.cc', 'Código de país para WhatsApp')}</label>
                            <input id="badge-cc" className={`${input} max-w-[120px]`} inputMode="numeric" maxLength={4} value={policy.country_code || ''} disabled={locked}
                                onChange={(e) => patchPolicy({ country_code: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
                            <p className="text-[10px] text-gray-400 mt-1">{tx('badges.cc.hint', 'Se antepone a los números sin indicativo al enviar por WhatsApp (57 = Colombia). Si eliges el indicativo por defecto en Campos, se usa ese.')}</p>
                        </div>
                        {dirty && <p className="text-[10px] text-gray-400">{tx('badges.self.save', 'Los cambios se aplican al guardar.')}</p>}
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
                                                <Select id="self-type" className={input} value={sp.type_field || ''} disabled={locked} onChange={(e) => patchSelf({ type_field: e.target.value || null })}>
                                                    <option value="">{tx('badges.self.auto', 'Automático')}{!sp.type_field && selfInfo.type_field ? ` (${nameOf(selfInfo.type_field)})` : ''}</option>
                                                    {selfInfo.fields.filter((f: any) => f.type === 'select').map((f: any) => <option key={f.name} value={f.name}>{f.label}</option>)}
                                                </Select>
                                            </div>
                                            <div>
                                                <label className={label} htmlFor="self-number">{tx('badges.self.number', 'Campo «número de documento»')}</label>
                                                <Select id="self-number" className={input} value={sp.number_field || ''} disabled={locked} onChange={(e) => patchSelf({ number_field: e.target.value || null })}>
                                                    <option value="">{tx('badges.self.auto', 'Automático')}{!sp.number_field && selfInfo.number_field ? ` (${nameOf(selfInfo.number_field)})` : ''}</option>
                                                    {selfInfo.fields.filter((f: any) => f.type !== 'select').map((f: any) => <option key={f.name} value={f.name}>{f.label}</option>)}
                                                </Select>
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
                                    </>
                                )}
                            </div>
                        );
                    })()}
                </div>
            )}
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
            const url = known ? Promise.resolve(linkUrl(known, base)) : badgesApi.links(conferenceId, { inscription_ids: [Number(r.id)] }).then((x) => {
                const l = x.links && x.links[0];
                if (!l) throw new Error(tx('badges.person.cancelled', 'Una inscripción cancelada no tiene escarapela.'));
                mergeLinks([l]);
                return linkUrl(l, base);
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
                    <Select className={`${input} flex-1 min-w-[12rem]`} value={loc} onChange={(e) => setLoc(e.target.value)} aria-label={tx('badges.bulk.location', 'Localidad')} data-badges-location="">
                        <option value="">{tx('badges.bulk.all', 'Todas las localidades')}</option>
                        {locations.map((l) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                    </Select>
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
                            const url = link ? linkUrl(link, base) : '';
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
                placeOf={placeOf} onLinks={mergeLinks} shownIds={q.trim() ? shown.map((x: any) => Number(x.r.id)) : null}
                everyone={(people || []).map((r: any) => ({ id: Number(r.id), name: personDisplayName(r, fields), place: placeOf(r), loc: String(rawLocationId(r) ?? ''), code: r.reg_code || '' }))}
                locations={locations} stickerSize={cfg && cfg.sticker && cfg.sticker.size} />

            {open && (
                <BadgeActions person={open} name={personDisplayName(open, fields)} fields={fields} conferenceId={conferenceId}
                    conferenceName={(conference && conference.name) || ''} canManage={canManage}
                    onClose={() => { setOpen(null); refreshLinks(); }} />
            )}
        </div>
    );
}

/** Everyone's links and PDFs at once: the location chosen in the person list, or the whole conference. */
function BulkTools({ conferenceId, conference, tx, addToast, loc, locName, placeOf, onLinks, shownIds, everyone, locations, stickerSize }: any) {
    const [busy, setBusy] = useState('');
    // 2.36.3: «Imprimir stickers» — the dialog where the scope is chosen (everyone, a locality, the people ticked).
    const [stickers, setStickers] = useState(false);
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
                            return list.map((l: any) => `${nameOf(m, f, l.inscription_id)}: ${linkUrl(l, base)}`).join('\n');
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
                            return [nameOf(m, f, l.inscription_id), r ? placeOf(r) : '', r ? phoneOfRow(r, f) : '', linkUrl(l, base)];
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
                {/* The printable stickers (2.36.3): one dialog where the scope is chosen, starting on what the list shows. */}
                <button type="button" className={`${ghost} sm:col-span-2`} disabled={!!busy} data-bulk="sticker" onClick={() => setStickers(true)}>
                    <i className="fa-solid fa-note-sticky"></i>{tx('badges.bulk.sticker', 'Imprimir stickers')}
                </button>
            </div>
            {stickers && (
                <StickerPrint conferenceId={conferenceId} people={everyone || []} locations={locations || []} tx={tx} addToast={addToast} size={stickerSize}
                    initial={shownIds ? { scope: 'pick', picked: shownIds } : loc ? { scope: 'loc', loc: String(loc) } : { scope: 'all' }}
                    onClose={() => setStickers(false)} />
            )}
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
