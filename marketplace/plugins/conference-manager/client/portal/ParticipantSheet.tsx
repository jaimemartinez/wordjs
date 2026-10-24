// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * The participant's sheet («⋮» of a row; tables-design 2.3): everything the coordinator knows about one
 * person, without another request — the name, the payment state (paid of the fee, what awaits validation,
 * what was returned, what is still to cover), the registration date, and EVERY form field in the form's
 * order, untruncated, with «—» for an empty one (D11). E-mails and phones are links.
 *
 * Actions: «Registrar pago de esta persona» (the payment sheet opens on top, layer 2) and «Ver sus pagos»
 * («Pagos de cuotas» filtered to this person). A cancelled inscription (D-P19) says why it cannot be paid
 * and offers no payment button. The sheet reads the person BY ID from the live roster, so it shows the new
 * balance as soon as a payment is sent, and closes itself if the person disappears.
 */
import React from "react";
import type { PortalField } from "./form";
import { fmtMoney } from "./form";
import { fieldDisplayValue, normalizeSearch } from "./lodgingView";
import { fieldRaw, isCancelled, payStateOf, personName, PAY_STATE_LABEL, type PortalPerson } from "./participants";
import { money, rowBalanceC, stampDayLabel } from "./feePayments";
import { PAY_STATE_TONE, SoftWrap } from "./ParticipantList";
import { Badge, Button, InfoRow, Modal, Notice, SheetNotice, labelCls } from "./ui";
import type { HubNotice } from "./feePayments";
import { PortalBadgeSection } from "./PortalBadges";
import { ConsentChip, PortalConsentSection } from "./ConsentBits";

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

/** A field's value as the sheet shows it: text, a mailto: link or a tel: link; null when empty. */
export function fieldNode(field: PortalField, raw: unknown): React.ReactNode {
    const value = fieldDisplayValue(raw, field.type);
    if (!value) return null;
    const type = String(field.type || "").toLowerCase();
    const name = normalizeSearch(field.name);
    if ((type === "email" || /e-?mail|correo/.test(name)) && EMAIL_RE.test(value)) {
        // Wraps at the address's own points (after «@», before «.»), never mid-word: «…@iglesiaevan» / «gelica…».
        return <a href={`mailto:${value}`} className="text-blue-700 underline break-words" data-mail=""><SoftWrap text={value} /></a>;
    }
    const digits = value.replace(/[^\d+]/g, "");
    if ((type === "tel" || type === "phone" || /phone|telefono|celular|movil|whatsapp/.test(name)) && digits.replace(/\D/g, "").length >= 6) {
        return <a href={`tel:${digits}`} className="text-blue-700 underline">{value}</a>;
    }
    return value;
}

export type ParticipantSheetProps = {
    person: PortalPerson;
    fields: PortalField[];
    onClose: () => void;
    /** «Pagos de cuotas» exists in this plugin (≥ 2.18.0): «Ver sus pagos» and the new payment sheet. */
    feesOn: boolean;
    /** The location has at least one enabled form of payment. */
    canRecord: boolean;
    onPay: (id: number) => void;
    onSeePayments?: (id: number) => void;
    /** The payment sheet is being prepared (its data is loading). */
    payBusy?: boolean;
    /** What the payment hub has to say while this sheet is open (a payment sent from it): shown here, not in a toast. */
    notice?: HubNotice | null;
    /** «Escarapela» (conference-manager ≥ 2.19.0, while coordinators may share badges): the portal's request headers. */
    badges?: { authHeaders: (extra?: Record<string, string>) => Record<string, string>; conferenceName?: string } | null;
    /** «Autorización de datos» (2.33.0, while the conference asks for it): the state and «Reenviar enlace». */
    consent?: { authHeaders: (extra?: Record<string, string>) => Record<string, string>; onChanged?: () => void } | null;
};

export default function ParticipantSheet({ person, fields, onClose, feesOn, canRecord, onPay, onSeePayments, payBusy, notice, badges, consent }: ParticipantSheetProps) {
    const id = Number(person.id);
    const name = personName(person, fields);
    const cancelled = isCancelled(person);
    const st = payStateOf(person);
    const b = rowBalanceC(person);
    const groupField = fields.find((f) => !!f.is_group);
    const group = groupField ? String(fieldRaw(person, groupField.name) || "").trim() : "";
    // A server stamp (UTC): the local day, never the UTC calendar day (stampDayLabel).
    const registered = stampDayLabel(person.registration_date ?? null);
    return (
        <Modal title={name} subtitle={registered ? `Inscripción: ${registered}` : undefined} onClose={onClose} size="lg" testId="participant-sheet">
            <SheetNotice notice={notice} />
            <div className="flex flex-wrap gap-2" data-sheet-chips="">
                {cancelled && <Badge tone="gray" icon="fa-ban">Cancelada</Badge>}
                {group && <Badge tone="indigo" icon="fa-people-roof">{group}</Badge>}
                <ConsentChip consent={person.consent} />
            </div>

            {consent && person.consent && !cancelled && (
                <PortalConsentSection inscriptionId={id} consent={person.consent} authHeaders={consent.authHeaders} onChanged={consent.onChanged} />
            )}

            <section className="space-y-3" aria-labelledby={`pay-${id}`} data-sheet-section="pago">
                <h4 id={`pay-${id}`} className={labelCls}>Pago</h4>
                {cancelled ? (
                    <Notice tone="blue" icon="fa-ban">
                        Inscripción cancelada: no tiene cuota pendiente y no se le pueden registrar pagos.
                        {b.validated > 0 ? <> Tiene {money(b.validated)} pagados.</> : null}
                    </Notice>
                ) : (
                    <div className="rounded-2xl border border-gray-100 bg-gray-50/40 p-4 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge tone={PAY_STATE_TONE[st]}>{PAY_STATE_LABEL[st]}</Badge>
                            <span className="text-sm font-bold text-gray-700">Pagado <span className="text-gray-900 tabular-nums">${fmtMoney(person.amount_paid)}</span> de <span className="tabular-nums">${fmtMoney(person.total_due)}</span></span>
                        </div>
                        <ul className="text-sm text-gray-700 space-y-1">
                            {b.pending > 0 && <li data-line="pending"><i className="fa-solid fa-clock text-amber-600 mr-2" aria-hidden="true"></i>{money(b.pending)} por validar</li>}
                            {b.returned > 0 && <li data-line="returned"><i className="fa-solid fa-rotate-left text-orange-600 mr-2" aria-hidden="true"></i>{money(b.returned)} en un pago devuelto: corrígelo en «Pagos de cuotas»</li>}
                            <li data-line="to-cover" className="font-bold">{b.toCover > 0 ? <>Falta por pagar: <span className="tabular-nums">{money(b.toCover)}</span></> : b.pending > 0 ? "Sin saldo por registrar (falta la validación)" : "Al día"}</li>
                        </ul>
                    </div>
                )}
                {(b.payable || (feesOn && onSeePayments)) && (
                    <div className="flex flex-col sm:flex-row gap-2">
                        {b.payable && (
                            <Button icon="fa-file-invoice-dollar" variant="success" onClick={() => onPay(id)} disabled={!canRecord || payBusy} title={canRecord ? undefined : "No hay formas de pago habilitadas para esta localidad."} data-action="pay">
                                {payBusy ? "Preparando…" : "Registrar pago de esta persona"}
                            </Button>
                        )}
                        {feesOn && onSeePayments && (
                            <Button variant="outline" icon="fa-receipt" onClick={() => onSeePayments(id)} data-action="see-payments">Ver sus pagos</Button>
                        )}
                    </div>
                )}
                {!cancelled && b.payable && !canRecord && (
                    <p className="text-xs text-rose-700 font-medium">La administración no ha habilitado formas de pago para esta localidad.</p>
                )}
            </section>

            {badges && !cancelled && (
                <PortalBadgeSection inscriptionId={id} firstName={String(fieldRaw(person, "first_name") ?? "")} conferenceName={badges.conferenceName} authHeaders={badges.authHeaders} />
            )}

            <section className="space-y-1" aria-labelledby={`data-${id}`} data-sheet-section="datos">
                <h4 id={`data-${id}`} className={labelCls}>Datos del formulario</h4>
                <dl>
                    {fields.map((f) => (
                        <InfoRow key={f.name} label={f.label || f.name}>{fieldNode(f, fieldRaw(person, f.name))}</InfoRow>
                    ))}
                    <InfoRow label="Fecha de inscripción">{registered || null}</InfoRow>
                </dl>
            </section>
        </Modal>
    );
}
