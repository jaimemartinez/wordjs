// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * One person's badge (2.19.0), opened from the person sheet's «Escarapela»: the badge as it looks, and what to
 * do with it — open the credential page, copy or share its link, send it by WhatsApp to the person's phone,
 * download the PDF (in a new tab); with «Escarapelas › administrar», regenerate the link (the old one stops
 * working) or revoke it. The link is created the first time (POST /badges/links) and carries the site's public
 * address. When badges are off or past their expiry date, a notice says so before anyone sends a dead link.
 * Layer 2, above the sheet.
 */
import React, { useEffect, useState } from "react";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { useModal } from "@/contexts/ModalContext";
import { LAYER } from "../lib/overlay";
import { badgesApi, linkUrl, nativeShare, openBadgeFileFrom, publicBase, waNumber, whatsappUrl } from "../lib/badges";
import { Overlay } from "./Overlay";
import { useCopy } from "../lib/CopyFallback";
import { useTx } from "./MealScanner";
import { BadgeSvg } from "./BadgeSvg";

const btn = 'min-h-[44px] px-4 rounded-2xl font-black text-[11px] uppercase tracking-widest inline-flex items-center justify-center gap-2 disabled:opacity-50';
const ghost = `${btn} bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-400`;

/** The phone of a roster row: the form field with the phone role (or type), as typed. */
export const phoneOfRow = (row: any, fields: any[]): string => {
    const f = (fields || []).find((x) => x.role === 'phone' || x.name === 'phone' || x.type === 'tel');
    if (!f || !row) return '';
    const v = row[f.name] ?? (row.custom_data || {})[f.name];
    return v == null ? '' : String(v);
};

export function BadgeActions({ person, name, fields, conferenceId, conferenceName, canManage, onClose }: any) {
    const tx = useTx();
    const { addToast } = useToast();
    const { confirm } = useModal();
    const [link, setLink] = useState<any>(null);
    const [state, setState] = useState<string | null>(null);
    const [cc, setCc] = useState('57');
    const [base, setBase] = useState('');
    const [badge, setBadge] = useState<any>(null);
    const [plate, setPlate] = useState<string | null>(null);
    const [images, setImages] = useState<Record<string, string> | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState('');
    // 2.36.8: a copy the phone does not allow opens the link to copy by hand (lib/CopyFallback), never a toast.
    const { copy: copyNow, copyUi } = useCopy({ onCopied: (m) => addToast(m, 'success') });
    useEffect(() => {
        let alive = true;
        setError('');
        Promise.all([
            badgesApi.links(conferenceId, { inscription_ids: [person.id] }),
            badgesApi.preview(conferenceId, null, person.id),
            badgesApi.getAsset(conferenceId, 'plate_screen').catch(() => null),
            publicBase(),
        ]).then(([l, p, pl, b]) => {
            if (!alive) return;
            setLink(l.links[0] || null);
            setState(l.state || null);
            setCc(l.country_code || '57');
            setBase(b);
            setBadge(p.badge);
            setImages(p.images || null);
            setPlate(pl ? pl.data_url : null);
            if (!l.links[0]) setError(tx('badges.person.cancelled', 'Una inscripción cancelada no tiene escarapela.'));
        }).catch((e) => { if (alive) setError(e?.message || 'Error'); });
        return () => { alive = false; };
    }, [person.id, conferenceId]);

    const url = link ? linkUrl(link, base) : '';
    const intro = tx('badges.share.intro', 'Tu escarapela de {conference}').replace('{conference}', conferenceName || '');
    const message = `${intro}: ${url}`;
    const phone = phoneOfRow(person, fields);
    const number = waNumber(phone, cc);
    const act = async (what: string, fn: () => Promise<void>) => {
        if (busy) return;
        setBusy(what);
        try { await fn(); } catch (e: any) { addToast(e?.message || 'Error', 'error'); } finally { setBusy(''); }
    };

    return (
        <>
        {copyUi}
        <Overlay layer={LAYER.modal} onBackdrop={onClose} onEscape={onClose}>
            <div role="dialog" aria-modal="true" aria-labelledby="badge-actions-title" data-badge-actions={person.id}
                className="bg-white rounded-[32px] shadow-2xl w-full max-w-lg border border-gray-100 overflow-hidden flex flex-col max-h-[92dvh]">
                <div className="bg-gray-50/50 px-5 sm:px-7 py-4 border-b border-gray-100 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <h2 id="badge-actions-title" className="font-black text-xl text-gray-900 italic tracking-tighter">{tx('badges.person.title', 'Escarapela')}</h2>
                        <p className="text-xs font-bold text-gray-500 truncate">{name}</p>
                    </div>
                    <button type="button" onClick={onClose} aria-label={tx('close', 'Cerrar')} className="shrink-0 w-11 h-11 flex items-center justify-center rounded-2xl text-gray-500 hover:bg-gray-100">
                        <i className="fa-solid fa-xmark text-xl" aria-hidden="true"></i>
                    </button>
                </div>
                <div className="px-5 sm:px-7 py-5 overflow-y-auto space-y-4">
                    {error && <p className="text-sm font-bold text-rose-600" role="alert">{error}</p>}
                    {state && (
                        <p className="text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2" role="note" data-badge-state={state}>
                            <i className="fa-solid fa-triangle-exclamation mr-1.5" aria-hidden="true"></i>
                            {state === 'disabled'
                                ? tx('badges.state.disabled', 'Las escarapelas están apagadas: este enlace no muestra nada hasta que las actives en «Escarapelas».')
                                : tx('badges.state.expired', 'Las escarapelas ya vencieron: este enlace no muestra nada hasta que cambies la fecha en «Escarapelas».')}
                        </p>
                    )}
                    {badge ? (
                        <div className={`mx-auto ${badge.layout === 'vertical' ? 'max-w-[220px]' : 'max-w-[400px]'} rounded-2xl overflow-hidden shadow-lg ring-1 ring-black/5`}>
                            <BadgeSvg badge={badge} plate={badge.version === 2 ? null : plate} images={images} title={name} />
                        </div>
                    ) : !error && <div className="h-40 rounded-2xl bg-gray-100 animate-pulse" />}
                    {link && (
                        <>
                            <div className="grid grid-cols-2 gap-2">
                                <a className={ghost} href={url} target="_blank" rel="noopener noreferrer" data-badge-act="open"><i className="fa-solid fa-arrow-up-right-from-square"></i>{tx('badges.act.open', 'Abrir')}</a>
                                <button type="button" className={ghost} data-badge-act="copy" onClick={() => act('copy', async () => {
                                    await copyNow(url, { done: tx('badges.act.copied', 'Enlace copiado') });
                                })}>
                                    <i className="fa-solid fa-copy"></i>{tx('badges.act.copy', 'Copiar enlace')}
                                </button>
                                <button type="button" className={ghost} data-badge-act="share" onClick={() => act('share', async () => {
                                    // The message and the link apart: a share target joins them (never the link twice).
                                    if (await nativeShare({ title: tx('badges.person.title', 'Escarapela'), text: intro, url })) return;
                                    await copyNow(message, { done: tx('badges.act.copied', 'Enlace copiado') });
                                })}>
                                    <i className="fa-solid fa-share-nodes"></i>{tx('badges.act.share', 'Compartir')}
                                </button>
                                <a className={ghost} href={whatsappUrl(phone, message, cc)} target="_blank" rel="noopener noreferrer" data-badge-act="whatsapp"
                                    title={number ? `+${number}` : tx('badges.act.whatsapp.hint', 'No hay un teléfono válido en la inscripción: WhatsApp se abrirá para escoger el contacto.')}>
                                    <i className="fa-brands fa-whatsapp"></i>{number ? tx('badges.act.whatsapp', 'WhatsApp') : tx('badges.act.whatsapp.nophone', 'WhatsApp (sin número)')}
                                </a>
                                <button type="button" className={ghost} data-badge-act="pdf" disabled={!!busy}
                                    onClick={() => act('pdf', () => openBadgeFileFrom(async () => (await badgesApi.ticket(conferenceId, { inscription_id: person.id }, 'single')).d))}>
                                    <i className={`fa-solid ${busy === 'pdf' ? 'fa-spinner animate-spin' : 'fa-file-pdf'}`}></i>{tx('badges.act.pdf', 'Descargar PDF')}
                                </button>
                                {/* 2.36.0: the printable sticker for the physical badge (one label, its exact size). */}
                                <button type="button" className={ghost} data-badge-act="sticker" disabled={!!busy}
                                    onClick={() => act('sticker', () => openBadgeFileFrom(async () => (await badgesApi.ticket(conferenceId, { inscription_id: person.id }, 'sticker')).d))}>
                                    <i className={`fa-solid ${busy === 'sticker' ? 'fa-spinner animate-spin' : 'fa-note-sticky'}`}></i>{tx('badges.act.sticker', 'Sticker para imprimir')}
                                </button>
                            </div>
                            <p className="text-[10px] text-gray-400 break-all" data-badge-url="">{url}</p>
                            {link.view_count > 0 && <p className="text-[10px] font-bold text-gray-500">{(Number(link.view_count) === 1 ? tx('badges.person.views.one', 'Abierta 1 vez') : tx('badges.person.views', 'Abierta {n} veces')).replace('{n}', String(link.view_count))}</p>}
                            {canManage && (
                                <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-100">
                                    <button type="button" className={ghost} disabled={!!busy} data-badge-act="rotate" onClick={() => act('rotate', async () => {
                                        if (!await confirm(tx('badges.act.rotate.confirm', 'Se creará un enlace nuevo y el anterior dejará de funcionar. ¿Continuar?'), tx('badges.act.rotate', 'Regenerar enlace'), true)) return;
                                        const r = await badgesApi.rotate(person.id);
                                        setLink(r.link);
                                        addToast(tx('badges.act.rotated', 'Enlace nuevo listo'), 'success');
                                    })}><i className="fa-solid fa-rotate"></i>{tx('badges.act.rotate', 'Regenerar enlace')}</button>
                                    <button type="button" className={`${btn} bg-white border-2 border-rose-100 text-rose-600 hover:border-rose-400`} disabled={!!busy} data-badge-act="revoke" onClick={() => act('revoke', async () => {
                                        if (!await confirm(tx('badges.act.revoke.confirm', 'El enlace dejará de funcionar. Podrás crear uno nuevo cuando quieras. ¿Continuar?'), tx('badges.act.revoke', 'Anular enlace'), true)) return;
                                        await badgesApi.revoke(person.id);
                                        addToast(tx('badges.act.revoked', 'Enlace anulado'), 'success');
                                        onClose();
                                    })}><i className="fa-solid fa-ban"></i>{tx('badges.act.revoke', 'Anular enlace')}</button>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </Overlay>
        </>
    );
}
