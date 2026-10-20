// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * Receipts of «Pagos de cuotas» (2.18.0).
 *
 * - `ProofThumb`: the receipt of a payment, fetched ON DEMAND (GET /fee-payments/:id/proof — lists never
 *   carry receipts) and kept in a 10-entry LRU keyed by the payment AND its split generation (`alloc_gen`):
 *   a receipt only ever changes through an edit, and every edit — the coordinator's «Corregir y reenviar»
 *   included — mints a new generation, so the admin never validates a payment while looking at the receipt
 *   it had before (2.18.0 review). «Ver grande» opens the lightbox (layer 3), «Descargar» saves it. Only an
 *   image data URL is ever rendered (`isImageDataUrl`: coordinator input is untrusted).
 * - `ProofLightbox`: the receipt full size, above whatever opened it.
 * - `ProofPicker`: «Tomar foto o elegir archivo» → compressed on the device to ≤ 1 MB (lib/proofImage.ts),
 *   with «Preparando foto…», a thumbnail, its size, «Cambiar» and «Quitar».
 */
import React, { useEffect, useRef, useState } from "react";
import { feePaymentsApi } from "../lib/conference";
import { LAYER } from "../lib/overlay";
import { PROOF_ERROR_TEXT, createLru, dataUrlBytes, formatBytes, isImageDataUrl, pickSequence, prepareProof } from "../lib/proofImage";
import { Overlay } from "./Overlay";
import { useTx } from "./MealScanner";

const cache = createLru<string>(10);
/** The cache key of payment `transferId`'s receipt at split generation `allocGen`. */
export const proofKey = (transferId: number, allocGen?: number | null): string => `${Number(transferId)}:${Number(allocGen) || 0}`;
/** The cached receipt of a payment at a generation (undefined when not cached). */
export const cachedProof = (transferId: number, allocGen?: number | null): string | undefined => cache.get(proofKey(transferId, allocGen));
/** Remember a fetched receipt under its payment and generation. */
export const rememberProof = (transferId: number, allocGen: number | null | undefined, src: string): void => cache.set(proofKey(transferId, allocGen), src);
/** Forget every cached receipt of a payment (an edit replaced it, or it was deleted). */
export const forgetProof = (transferId: number) => {
    const prefix = `${Number(transferId)}:`;
    for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
};
/**
 * The receipt of payment `transferId` at generation `allocGen`: the cached one, else fetched and cached.
 * `fetcher` = GET /fee-payments/:id/proof. Resolves null when the payment has none.
 */
export async function loadProof(transferId: number, allocGen: number | null | undefined, fetcher: (id: number) => Promise<any> = (id) => feePaymentsApi.getProof(id)): Promise<string | null> {
    const hit = cachedProof(transferId, allocGen);
    if (hit) return hit;
    const r = await fetcher(transferId);
    const src = r && typeof r.proof === 'string' ? r.proof : null;
    if (src) rememberProof(transferId, allocGen, src);
    return src;
}

/** The receipt of payment `transferId` at `allocGen` (null while loading or when there is none; `error` when it failed). */
export function useProof(transferId: number | null, hasProof: boolean, allocGen?: number | null) {
    const [state, setState] = useState<{ src: string | null; loading: boolean; error: string | null }>(() => {
        const hit = transferId ? cachedProof(transferId, allocGen) : undefined;
        return { src: hit || null, loading: !!(hasProof && transferId && !hit), error: null };
    });
    useEffect(() => {
        if (!transferId || !hasProof) { setState({ src: null, loading: false, error: null }); return undefined; }
        const hit = cachedProof(transferId, allocGen);
        if (hit) { setState({ src: hit, loading: false, error: null }); return undefined; }
        let alive = true;
        setState({ src: null, loading: true, error: null });
        loadProof(transferId, allocGen)
            .then((src) => { if (alive) setState({ src, loading: false, error: null }); })
            .catch((e: any) => { if (alive) setState({ src: null, loading: false, error: e?.message || 'Error' }); });
        return () => { alive = false; };
    }, [transferId, hasProof, allocGen]);
    return state;
}

/** Save a receipt (data URL) as a file. A PDF (later phase) would only ever be downloaded, never opened. */
export function downloadProof(src: string, name: string) {
    try {
        const a = document.createElement('a');
        a.href = src;
        const ext = /^data:image\/png/.test(src) ? 'png' : /^data:image\/webp/.test(src) ? 'webp' : /^data:image\/gif/.test(src) ? 'gif' : 'jpg';
        a.download = `${name}.${ext}`;
        document.body.appendChild(a); a.click(); a.remove();
    } catch { /* blocked */ }
}

export function ProofThumb({ transferId, hasProof, allocGen, large = false }: { transferId: number; hasProof: boolean; allocGen?: number | null; large?: boolean }) {
    const tx = useTx();
    const { src, loading, error } = useProof(transferId, hasProof, allocGen);
    const [open, setOpen] = useState(false);
    if (!hasProof) {
        return <p className="text-xs font-bold text-gray-500 italic" data-proof="none"><i className="fa-solid fa-receipt mr-1.5" aria-hidden="true"></i>{tx('fees.proof.none', 'Sin comprobante')}</p>;
    }
    if (loading) return <div className={`${large ? 'h-64' : 'h-24'} rounded-2xl bg-gray-100 animate-pulse`} data-proof="loading" aria-label={tx('loading', 'Cargando...')}></div>;
    if (error) return <p className="text-xs font-bold text-rose-700" role="alert" data-proof="error">{error}</p>;
    if (!isImageDataUrl(src)) {
        return <p className="text-xs font-bold text-gray-600" data-proof="invalid"><i className="fa-solid fa-triangle-exclamation mr-1.5" aria-hidden="true"></i>{tx('fees.proof.invalid', 'El comprobante guardado no es una imagen')}</p>;
    }
    return (
        <div className="space-y-2" data-proof="image">
            <button type="button" onClick={() => setOpen(true)} className="block w-full rounded-2xl border border-gray-100 bg-gray-50 overflow-hidden" aria-label={tx('fees.proof.view', 'Ver grande')}>
                <img src={src} alt={tx('fees.proof', 'Comprobante')} className={`w-full object-contain ${large ? 'max-h-[45vh]' : 'max-h-56'}`} />
            </button>
            <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setOpen(true)} className="min-h-[44px] px-4 rounded-xl border-2 border-gray-100 text-xs font-black uppercase tracking-widest text-gray-700 hover:border-blue-400"><i className="fa-solid fa-magnifying-glass-plus mr-1.5" aria-hidden="true"></i>{tx('fees.proof.view', 'Ver grande')}</button>
                <button type="button" onClick={() => downloadProof(src, `comprobante-${transferId}`)} className="min-h-[44px] px-4 rounded-xl border-2 border-gray-100 text-xs font-black uppercase tracking-widest text-gray-700 hover:border-blue-400"><i className="fa-solid fa-download mr-1.5" aria-hidden="true"></i>{tx('fees.proof.download', 'Descargar')}</button>
            </div>
            {open && <ProofLightbox src={src} onClose={() => setOpen(false)} />}
        </div>
    );
}

export function ProofLightbox({ src, onClose }: { src: string; onClose: () => void }) {
    const tx = useTx();
    if (!isImageDataUrl(src)) return null;
    return (
        <Overlay layer={LAYER.lightbox} sheet={false} backdrop="rgba(0,0,0,0.85)" onBackdrop={onClose} onEscape={onClose}>
            <div role="dialog" aria-modal="true" aria-label={tx('fees.proof', 'Comprobante')} className="relative">
                <button type="button" onClick={onClose} aria-label={tx('close', 'Cerrar')}
                    className="absolute top-2 right-2 w-11 h-11 shrink-0 flex items-center justify-center rounded-full bg-white text-gray-800 shadow-lg z-10">
                    <i className="fa-solid fa-xmark text-lg" aria-hidden="true"></i>
                </button>
                <img src={src} alt={tx('fees.proof', 'Comprobante')} className="max-w-full max-h-[90vh] rounded-xl shadow-2xl object-contain bg-white" />
            </div>
        </Overlay>
    );
}

/**
 * Where the keyboard focus goes once the receipt picker changed under it (a photo prepared, failed or removed):
 * «Cambiar» when there is a receipt, else «Tomar foto o elegir archivo». The button pressed is gone by then (the
 * busy state replaces the whole picker, «Quitar» removes itself) and the focus fell to <body> — outside the
 * dialog, the overlay's Tab trap no longer applying, a screen reader's place lost (2.18.0 review UX6-5).
 */
export function proofFocusTarget<T>(root: { querySelector: (sel: string) => T | null } | null | undefined): T | null {
    if (!root) return null;
    return root.querySelector('[data-proof-change]') || root.querySelector('[data-proof-empty]') || null;
}

/**
 * The receipt input. `value`: a new data URL, null (none / removed) or undefined (keep the payment's own,
 * `existingId` names it). `required`: transfer (D-P12: optional for cash). `onBusy(true|false)` while a photo
 * is being shrunk: the sheet keeps «Registrar» disabled meanwhile (sending would send the old receipt). The
 * focus stays in the picker when what it shows changes under it (proofFocusTarget).
 */
export function ProofPicker({ value, onChange, required, existingId, onError, onBusy }: {
    value: string | null | undefined; onChange: (v: string | null | undefined) => void; required: boolean; existingId?: number | null; onError?: (msg: string) => void; onBusy?: (busy: boolean) => void;
}) {
    const tx = useTx();
    const inputRef = useRef<HTMLInputElement | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    // The focus was in the picker when it changed (a pick, «Quitar»): it goes back in once it settles.
    const refocus = useRef(false);
    const focusWasIn = () => !!(rootRef.current && typeof document !== 'undefined' && rootRef.current.contains(document.activeElement));
    const [busy, setBusyState] = useState(false);
    const [err, setErr] = useState('');
    const [preview, setPreview] = useState(false);
    const setBusy = (b: boolean) => { setBusyState(b); if (onBusy) onBusy(b); };
    // The latest pick wins (lib/proofImage.ts pickSequence); the input is disabled while one is prepared.
    const picks = useRef(pickSequence()).current;
    const pick = async (file: File | undefined) => {
        if (!file) return;
        refocus.current = refocus.current || focusWasIn();
        const mine = picks.next();
        setBusy(true); setErr('');
        let r: any;
        try { r = await prepareProof(file); }
        finally { if (picks.isLatest(mine)) setBusy(false); }
        if (!picks.isLatest(mine)) return;
        if (inputRef.current) inputRef.current.value = '';
        if (r.ok) onChange(r.dataUrl);
        else {
            const m = PROOF_ERROR_TEXT[r.error];
            const text = tx(m.key, m.fallback);
            setErr(text);
            if (onError) onError(text);
        }
    };
    const keeping = value === undefined && !!existingId;
    useEffect(() => {
        if (busy || !refocus.current) return;
        refocus.current = false;
        const el: any = proofFocusTarget(rootRef.current as any);
        try { if (el) el.focus({ preventScroll: true }); } catch { /* gone */ }
    }, [busy, value, err]);
    const remove = (next: string | null | undefined) => { refocus.current = focusWasIn(); onChange(next); };
    // «Tomar foto o elegir archivo» / «Cambiar» are BUTTONS that open the hidden file input: a keyboard (an iPad
    // with one, a desktop, Switch Control) lands on them with a visible ring. As <label>s they took no focus, and
    // Tab went to the invisible 1 px input with nothing on screen showing where (2.18.0 review PUX-6, WCAG 2.4.7).
    const choose = () => { const el = inputRef.current; if (el && !busy) { try { el.click(); } catch { /* ignore */ } } };
    const ring = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500';
    return (
        <div ref={rootRef} className="space-y-2" data-proof-picker="">
            <input ref={inputRef} type="file" accept="image/*" className="sr-only" id="fee-proof-input" disabled={busy} onChange={(e) => pick(e.target.files?.[0])} data-proof-input=""
                tabIndex={-1} aria-hidden="true" />
            {busy ? (
                <div className="rounded-2xl border-2 border-dashed border-blue-200 bg-blue-50/40 px-4 py-6 text-center text-sm font-bold text-blue-700" role="status">
                    <i className="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i>{tx('fees.proof.preparing', 'Preparando foto…')}
                </div>
            ) : typeof value === 'string' && isImageDataUrl(value) ? (
                <div className="flex items-center gap-3 rounded-2xl border border-gray-100 bg-gray-50 p-3">
                    <button type="button" onClick={() => setPreview(true)} className="shrink-0 w-16 h-16 rounded-xl overflow-hidden border border-gray-200 bg-white" aria-label={tx('fees.proof.view', 'Ver grande')}>
                        <img src={value} alt="" className="w-full h-full object-cover" />
                    </button>
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-black text-gray-900">{tx('fees.proof.ready', 'Comprobante listo')}</p>
                        <p className="text-xs font-bold text-gray-500" data-proof-size="">{formatBytes(dataUrlBytes(value))}</p>
                    </div>
                    <button type="button" onClick={choose} className={`min-h-[44px] px-3 inline-flex items-center rounded-xl border-2 border-gray-100 bg-white text-[11px] font-black uppercase tracking-widest text-gray-700 cursor-pointer hover:border-blue-400 ${ring}`} data-proof-change="">{tx('fees.proof.change', 'Cambiar')}</button>
                    <button type="button" onClick={() => remove(existingId ? undefined : null)} className="min-h-[44px] px-3 rounded-xl border-2 border-gray-100 bg-white text-[11px] font-black uppercase tracking-widest text-rose-700 hover:border-rose-300" data-proof-remove="">{tx('fees.proof.remove', 'Quitar')}</button>
                </div>
            ) : keeping ? (
                <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-gray-100 bg-gray-50 p-3">
                    <p className="flex-1 min-w-[10rem] text-sm font-bold text-gray-700"><i className="fa-solid fa-paperclip mr-1.5" aria-hidden="true"></i>{tx('fees.proof.kept', 'Se mantiene el comprobante del pago')}</p>
                    <button type="button" onClick={choose} className={`min-h-[44px] px-3 inline-flex items-center rounded-xl border-2 border-gray-100 bg-white text-[11px] font-black uppercase tracking-widest text-gray-700 cursor-pointer hover:border-blue-400 ${ring}`} data-proof-change="">{tx('fees.proof.change', 'Cambiar')}</button>
                    {!required && <button type="button" onClick={() => remove(null)} className="min-h-[44px] px-3 rounded-xl border-2 border-gray-100 bg-white text-[11px] font-black uppercase tracking-widest text-rose-700 hover:border-rose-300" data-proof-remove="">{tx('fees.proof.remove', 'Quitar')}</button>}
                </div>
            ) : (
                <button type="button" onClick={choose} className={`w-full flex items-center justify-center gap-2 min-h-[56px] rounded-2xl border-2 border-dashed border-gray-200 bg-white px-4 py-4 text-center text-sm font-bold text-gray-600 cursor-pointer hover:border-blue-400 hover:text-blue-700 ${ring}`} data-proof-empty="">
                    <i className="fa-solid fa-camera" aria-hidden="true"></i>{tx('fees.proof.pick', 'Tomar foto o elegir archivo')}
                </button>
            )}
            <p className="text-[11px] font-bold text-gray-500">
                {required ? tx('fees.proof.required.hint', 'Obligatorio para una transferencia. La foto se reduce en el teléfono antes de enviarse.') : tx('fees.proof.optional.hint', 'Opcional en efectivo.')}
            </p>
            {err && <p role="alert" className="text-xs font-bold text-rose-700">{err}</p>}
            {preview && typeof value === 'string' && <ProofLightbox src={value} onClose={() => setPreview(false)} />}
        </div>
    );
}
