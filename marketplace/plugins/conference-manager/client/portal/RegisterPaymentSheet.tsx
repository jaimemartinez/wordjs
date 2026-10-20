// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Registrar pago» — one receipt (a bank transfer or a cash handover) for one or several of the location's
 * people (payments-design 1.2). Also «Corregir y reenviar» a payment the administration returned, «Editar»
 * a pending one, and «Duplicar» a rejected one (same people and amounts; the server copies its receipt).
 *
 * Sections: PERSONAS (each with what they still owe; «+ Añadir» picks more, family-group chips included —
 * cancelled people and people who owe nothing are never offered) · PAGO (the total, prefilled with what the
 * people owe; the location's enabled forms of payment; the date, default today; the reference; an optional
 * note) · REPARTO («Iguales» by default, «Manual»; the live «Asignado $X de $Y» says whether it adds up to
 * the cent; each part says what the person will still owe, and a part over what they owe is refused —
 * owner decision «Nunca») · COMPROBANTE (required for a transfer, optional for cash; shrunk on the phone).
 * «Enviar pago» stays disabled until everything is right, and the reason is written right above it, in the
 * footer (a failed send's message first) — with «Repartir según lo que debe cada uno» when the reason is a part
 * of «Iguales» over what someone owes (one tap seeds «Manual» with each one's debt). A payment being corrected
 * after the administration returned it shows its note at the top («Nota de la administración»).
 *
 * Pure rendering over the draft: the rules are feePayments.ts's checkDraft, the network is the hub's.
 */
import React, { useMemo, useState } from "react";
import {
    carriedNotice, checkDraft, followTotal, manualOnSwitch, manualSeed, money, overCapInEqual, startOver, type BalanceC, type DraftCheck, type DraftContext, type FeeDraft,
} from "./feePayments";
import { browserProofEnv, dataUrlBytes, pickSequence, prepareProof, ProofError, sizeLabel, type ProofEnv, type DecodedImage } from "./proofImage";
import { normalizeSearch } from "./lodgingView";
import { familyChips, type FamilyGroup } from "./participants";
import { Badge, Button, Field, MoneyInput, Modal, Notice, SPLIT_COLUMN_REM, SegmentedControl, SheetNotice, cx, inputCls, labelCls, touchTextCls } from "./ui";

export type RegisterSheetProps = {
    draft: FeeDraft;
    setDraft: (fn: (d: FeeDraft) => FeeDraft) => void;
    ctx: DraftContext;
    nameOf: (id: number) => string;
    groups: FamilyGroup[];
    busy: boolean;
    /** A message from the last failed send (network, refusal); the draft is kept. */
    error: string | null;
    /** Who was left out of the payment when it opened (they owe nothing more), or that the payments could not be reloaded. */
    notice?: string | null;
    /** Per-person messages from the server (over the cap, unknown, cancelled). */
    personErrors: Record<number, string>;
    onSubmit: () => void;
    onClose: () => void;
    /** Loads the receipt already stored on the payment being corrected (on demand). */
    loadStoredProof?: () => Promise<string>;
    /** «Empezar de cero» on a recovered correction (the payment as it is on the server). */
    onRestart?: () => void;
    proofEnv?: ProofEnv<DecodedImage>;
};

/** The sheet's title and send label for the draft kind. */
export function sheetCopy(d: Pick<FeeDraft, "kind" | "expected">, totalC: number | null): { title: string; send: string } {
    const amt = totalC && totalC > 0 ? ` ${money(totalC)}` : "";
    if (d.kind === "edit") {
        return d.expected?.status === "returned"
            ? { title: "Corregir y reenviar", send: `Reenviar pago${amt}` }
            : { title: "Editar pago", send: `Guardar cambios${amt}` };
    }
    if (d.kind === "duplicate") return { title: "Registrar de nuevo", send: `Enviar pago${amt}` };
    return { title: "Registrar pago", send: `Enviar pago${amt}` };
}

/**
 * What a person will owe once this payment is validated — the admin's words for the same case (plugin
 * lib/feePayments.ts partAfterKind): «Faltará $X»; «Queda pagado al validarse lo pendiente» when other money
 * of theirs still awaits validation too; else «Queda pagado al validarse».
 */
export const afterText = (afterOwed: number, otherPending = 0): string =>
    (afterOwed > 0 ? `Faltará ${money(afterOwed)}` : otherPending > 0 ? "Queda pagado al validarse lo pendiente" : "Queda pagado al validarse");

export default function RegisterPaymentSheet(props: RegisterSheetProps) {
    const { draft, setDraft, ctx, nameOf, groups, busy, error, personErrors, onSubmit, onClose } = props;
    const check: DraftCheck = useMemo(() => checkDraft(draft, ctx), [draft, ctx]);
    const [picking, setPicking] = useState(draft.ids.length === 0);
    const copy = sheetCopy(draft, check.totalC);
    const set = (patch: Partial<FeeDraft>) => setDraft((d) => ({ ...d, ...patch }));

    // While the coordinator has not typed a total, it follows the people: what they owe together.
    const setIds = (ids: number[]) => setDraft((d) => {
        const manual = { ...d.manual };
        for (const k of Object.keys(manual)) if (!ids.includes(Number(k))) delete manual[Number(k)];
        return followTotal({ ...d, ids, manual }, ctx.balances);
    });
    const removeId = (id: number) => setIds(draft.ids.filter((x) => x !== id));
    const addIds = (ids: number[]) => setIds([...draft.ids, ...ids.filter((x) => !draft.ids.includes(x))]);

    // «Cómo repartir»: back to «Manual», the amounts typed before are back (manualOnSwitch, 2.18.0 review UX6-6).
    const switchMode = (mode: "equal" | "manual") => setDraft((d) => (d.mode === mode ? d : mode === "manual" ? { ...d, mode, manual: manualOnSwitch(d, ctx) } : { ...d, mode }));
    // «Repartir según lo que debe cada uno»: what each one owes, whatever was typed before (it says so).
    const splitByOwed = () => setDraft((d) => ({ ...d, mode: "manual", manual: manualSeed(d, ctx), manualTyped: false }));
    const partInput = (id: number, v: string) => setDraft((d) => ({ ...d, mode: "manual", manualTyped: true, manual: d.mode === "manual" ? { ...d.manual, [id]: v } : { ...manualSeed(d, ctx), [id]: v } }));
    const totalOk = check.totalC !== null && check.totalC > 0;
    const firstProblem = !check.canSubmit && check.problems.length > 0 ? check.problems[0] : null;
    const status = error || firstProblem;

    return (
        <Modal
            title={copy.title}
            subtitle={draft.kind === "edit" ? "El pago vuelve a quedar por validar" : "Queda por validar por la administración"}
            onClose={onClose}
            size="lg"
            testId="register-payment-sheet"
            footerNote={status ? (
                <div id="register-problems" role="status" aria-live="polite" className="space-y-2" data-register-problems="">
                    {error ? (
                        <p className="flex gap-2 text-xs font-bold text-rose-700" data-register-error=""><i className="fa-solid fa-triangle-exclamation mt-0.5" aria-hidden="true"></i><span>{error}</span></p>
                    ) : (
                        <p className="flex gap-2 text-xs font-bold text-gray-700"><i className="fa-solid fa-circle-info mt-0.5 text-blue-600" aria-hidden="true"></i><span>{firstProblem}</span></p>
                    )}
                    {!error && overCapInEqual(draft, check) && (
                        <Button variant="outline" size="sm" icon="fa-scale-balanced" onClick={splitByOwed} data-action="split-by-owed">Repartir según lo que debe cada uno</Button>
                    )}
                </div>
            ) : undefined}
            footer={(
                <>
                    <Button variant="ghost" onClick={onClose}>Cancelar</Button>
                    <Button variant="success" icon="fa-paper-plane" onClick={onSubmit} disabled={!check.canSubmit || busy} data-action="send" aria-describedby="register-problems">
                        {busy ? "Enviando…" : copy.send}
                    </Button>
                </>
            )}
        >
            {/* Said here, at the top, while the coordinator reads the people — not in a toast over «Enviar pago». */}
            {props.notice ? <SheetNotice notice={{ text: props.notice, tone: "amber", n: 0 }} /> : null}
            {carriedNotice(draft) && (
                <Notice tone="blue" icon="fa-paperclip" data-carried-notice="">
                    <span className="block font-bold">{carriedNotice(draft)}</span>
                    <Button variant="outline" size="sm" icon="fa-eraser" className="mt-2" onClick={() => setDraft((d) => startOver(d, ctx))} data-action="start-over">
                        Empezar de cero
                    </Button>
                </Notice>
            )}
            {draft.recovered && (
                <Notice tone="blue" icon="fa-clock-rotate-left" data-recovered-notice="">
                    <span className="block font-bold">Recuperamos lo que cambiaste y no enviaste en este pago.</span>
                    {props.onRestart && (
                        <Button variant="outline" size="sm" icon="fa-eraser" className="mt-2" onClick={props.onRestart} data-action="restart-correction">
                            Empezar de cero
                        </Button>
                    )}
                </Notice>
            )}
            {draft.returnNote && (
                <Notice tone="amber" icon="fa-rotate-left" data-return-note="">
                    <span className="block text-[10px] font-black uppercase tracking-widest">Nota de la administración</span>
                    <span className="block font-bold break-words">{draft.returnNote}</span>
                </Notice>
            )}

            {/* PERSONAS */}
            <section className="space-y-3" data-register-section="people">
                <div className="flex items-center justify-between gap-2">
                    <h4 className={labelCls}>Personas ({draft.ids.length})</h4>
                    <Button variant="outline" size="sm" icon={picking ? "fa-chevron-up" : "fa-plus"} onClick={() => setPicking((v) => !v)} aria-expanded={picking}>{picking ? "Listo" : "Añadir"}</Button>
                </div>
                {draft.ids.length > 0 && (
                    <ul className="space-y-2">
                        {draft.ids.map((id) => {
                            const b = ctx.balances.get(id);
                            const err = personErrors[id];
                            return (
                                <li key={id} className={cx("flex items-center gap-2 rounded-2xl border pl-4 pr-1 py-1", err ? "border-rose-200 bg-rose-50/40" : "border-gray-100 bg-white")} data-register-person={id}>
                                    <span className="flex-1 min-w-0 py-1.5">
                                        <span className="block font-bold text-gray-900 break-words">{nameOf(id)}</span>
                                        <span className="block text-xs text-gray-600">{personLine(b)}</span>
                                        {err && <span className="block text-xs font-bold text-rose-700" role="alert">{err}</span>}
                                    </span>
                                    <button type="button" onClick={() => removeId(id)} className="w-11 h-11 shrink-0 flex items-center justify-center rounded-xl text-gray-400 hover:text-rose-600 hover:bg-rose-50" aria-label={`Quitar a ${nameOf(id)} del pago`}>
                                        <i className="fa-solid fa-xmark" aria-hidden="true"></i>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
                {picking && <PersonPicker ctx={ctx} chosen={draft.ids} nameOf={nameOf} groups={groups} onAdd={addIds} />}
            </section>

            {/* PAGO */}
            <section className="space-y-4" data-register-section="payment">
                <h4 className={labelCls}>Pago</h4>
                <Field label="Monto total">
                    {(fid) => (
                        <MoneyInput id={fid} large value={draft.total} invalid={draft.total !== "" && !totalOk} onChange={(v) => set({ total: v, totalTouched: true })} testId="register-total" />
                    )}
                </Field>
                {ctx.methods.length === 0 ? (
                    <Notice tone="rose" icon="fa-ban">La administración no ha habilitado formas de pago para esta localidad.</Notice>
                ) : (
                    <div className="space-y-1.5">
                        <span className={labelCls} id="register-method-label">Forma de pago</span>
                        <SegmentedControl label="Forma de pago" value={draft.method} options={ctx.methods.map((m) => ({ value: m, label: m }))} onChange={(m) => set({ method: m })} testId="register-method" />
                    </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label="Fecha del pago">
                        {(fid) => <input id={fid} type="date" className={cx(inputCls, "min-w-0 min-h-12 appearance-none")} value={draft.paidOn} max={todayMax()} onChange={(e) => set({ paidOn: e.target.value })} />}
                    </Field>
                    <Field label={draft.method === "Transferencia" ? "Referencia de la transferencia" : "Referencia (opcional)"}>
                        {(fid) => <input id={fid} className={inputCls} maxLength={100} value={draft.reference} onChange={(e) => set({ reference: e.target.value })} placeholder={draft.method === "Transferencia" ? "Número de operación" : "Número de recibo"} autoComplete="off" />}
                    </Field>
                </div>
                <NoteField value={draft.note} onChange={(note) => set({ note })} />
            </section>

            {/* REPARTO */}
            {draft.ids.length > 0 && (
                <section className="space-y-3" data-register-section="split">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className={labelCls}>Reparto</h4>
                        {draft.ids.length > 1 && (
                            <SegmentedControl label="Cómo repartir" value={draft.mode} options={[{ value: "equal", label: "Iguales" }, { value: "manual", label: "Manual" }]} onChange={switchMode} testId="register-mode" />
                        )}
                    </div>
                    <ul className="space-y-2">
                        {check.parts.map((p) => (
                            <SplitRow key={p.id} id={p.id} over={p.over} className={cx("grid items-center gap-3 rounded-2xl border px-4 py-2", p.over ? "border-rose-200 bg-rose-50/40" : "border-gray-100")}>
                                <span className="min-w-0">
                                    <span className="block text-sm font-bold text-gray-900 break-words">{nameOf(p.id)}</span>
                                    <span id={`split-after-${p.id}`} className={cx("block text-xs", p.over ? "font-bold text-rose-700" : "text-gray-600")} data-split-after={p.id}>
                                        {p.over ? `Supera lo que falta: máximo ${money(p.cap)}` : afterText(p.afterOwed, p.otherPending)}
                                    </span>
                                </span>
                                {draft.mode === "manual" || draft.ids.length === 1 ? (
                                    draft.ids.length === 1 ? (
                                        <span className="text-right font-black tabular-nums text-gray-900">{money(p.cents ?? 0)}</span>
                                    ) : (
                                        <MoneyInput compact value={draft.manual[p.id] ?? ""} onChange={(v) => partInput(p.id, v)} label={`Parte de ${nameOf(p.id)}`} invalid={p.over || p.cents === null || p.cents <= 0} describedBy={`split-after-${p.id}`} testId={`split-input-${p.id}`} />
                                    )
                                ) : (
                                    <button type="button" className="min-h-11 text-right font-black tabular-nums text-gray-900 rounded-xl hover:bg-gray-50 px-2" onClick={() => switchMode("manual")} aria-label={`Parte de ${nameOf(p.id)}: ${money(p.cents ?? 0)}. Cambiar a reparto manual`}>
                                        {money(p.cents ?? 0)}
                                    </button>
                                )}
                            </SplitRow>
                        ))}
                    </ul>
                    <SumLine check={check} />
                </section>
            )}

            {/* COMPROBANTE */}
            <ProofPicker
                required={check.proofRequired}
                working={draft.proofWorking}
                onWorking={(proofWorking) => set({ proofWorking })}
                proof={draft.proof}
                stored={draft.hasStoredProof && !draft.removeStoredProof}
                storedLabel={draft.kind === "duplicate" ? "Se usará el comprobante del pago rechazado" : "Comprobante actual"}
                onProof={(proof) => set({ proof })}
                onRemoveStored={() => set({ removeStoredProof: true })}
                loadStored={props.loadStoredProof}
                env={props.proofEnv}
            />

        </Modal>
    );
}

/**
 * One row of «Reparto»: the name and what the part leaves, beside the amount (a SPLIT_COLUMN_REM column, room
 * for «250.000,00»). When the part being typed goes past what the person may receive, the row is brought into
 * view whole, so «Supera lo que falta: máximo $X» under the field is never cut at the sheet's footer.
 */
function SplitRow({ id, over, className, children }: { id: number; over: boolean; className: string; children: React.ReactNode }) {
    const ref = React.useRef<HTMLLIElement>(null);
    React.useEffect(() => {
        const el = ref.current;
        if (!over || !el || typeof document === "undefined" || !el.contains(document.activeElement)) return;
        try { el.scrollIntoView({ block: "nearest" }); } catch { /* old browser */ }
    }, [over]);
    return <li ref={ref} className={className} style={{ gridTemplateColumns: `minmax(0, 1fr) ${SPLIT_COLUMN_REM}rem` }} data-split-row={id}>{children}</li>;
}

/** What a person still has to cover, the register sheet's words (personLine): «debe $X», or «falta $X» over «$Y por validar». */
export const owedLines = (b: BalanceC | undefined): string[] => {
    if (!b || b.toCover <= 0) return [];
    return b.pending > 0 ? [`falta ${money(b.toCover)}`, `${money(b.pending)} por validar`] : [`debe ${money(b.toCover)}`];
};

const todayMax = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** «debe $X», «⏱ $Y por validar · falta $Z», «Al día». */
export const personLine = (b: BalanceC | undefined): string => {
    if (!b) return "Ya no está en tu localidad";
    if (b.cancelled) return "Cancelada";
    const parts: string[] = [];
    if (b.pending > 0) parts.push(`${money(b.pending)} por validar`);
    parts.push(b.toCover > 0 ? (b.pending > 0 ? `falta ${money(b.toCover)}` : `debe ${money(b.toCover)}`) : "sin saldo por registrar");
    // The «·» glued to the fact after it: a narrow line never ends with it (UX6-3 twin).
    return parts.join(" ·\u00a0");
};

/**
 * «Asignado $X de $Y ✓» / «Faltan $Z» / «Sobran $Z» — the exact-sum indicator. Green «✓ Cuadra» only when the split
 * can go: a sum that adds up beside a part refused in red («Supera lo que falta») read as a success and a failure at
 * once (2.18.0 skeptic round 6) — then it says «Una parte supera lo que falta», amber.
 */
export function SumLine({ check }: { check: DraftCheck }) {
    const total = check.totalC ?? 0;
    const { assigned, diff } = check.split;
    const exact = total > 0 && diff === 0;
    const overCap = exact && check.parts.some((p) => p.over);
    return (
        <p
            className={cx("flex flex-wrap items-center justify-between gap-2 rounded-2xl px-4 py-3 text-sm font-bold", exact && !overCap ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900")}
            aria-live="polite"
            data-sum-state={overCap ? "over-cap" : exact ? "ok" : diff > 0 ? "short" : "over"}
        >
            <span>Asignado <span className="tabular-nums">{money(assigned)}</span> de <span className="tabular-nums">{money(total)}</span></span>
            <span>
                {overCap ? "Una parte supera lo que falta" : exact ? <><i className="fa-solid fa-check mr-1" aria-hidden="true"></i>Cuadra</> : diff > 0 ? `Faltan ${money(diff)}` : `Sobran ${money(-diff)}`}
            </span>
        </p>
    );
}

function NoteField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    const [open, setOpen] = useState(value.trim() !== "");
    if (!open) {
        return <Button variant="ghost" size="sm" icon="fa-plus" onClick={() => setOpen(true)}>Añadir nota</Button>;
    }
    return (
        <Field label="Nota (opcional)">
            {(fid) => <textarea id={fid} className={cx(inputCls, "resize-none")} rows={2} maxLength={500} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Algo que la administración deba saber de este pago" />}
        </Field>
    );
}

/** «+ Añadir»: the location's people who still owe something, with search and family-group chips. */
function PersonPicker({ ctx, chosen, nameOf, groups, onAdd }: { ctx: DraftContext; chosen: number[]; nameOf: (id: number) => string; groups: FamilyGroup[]; onAdd: (ids: number[]) => void }) {
    const [q, setQ] = useState("");
    const [allGroups, setAllGroups] = useState(false);
    const payable = useMemo(() => [...ctx.balances.entries()].filter(([, b]) => b.payable).map(([id]) => id)
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b), "es")), [ctx.balances, nameOf]);
    const words = normalizeSearch(q).split(/\s+/).filter(Boolean);
    const list = payable.filter((id) => !chosen.includes(id) && words.every((w) => normalizeSearch(nameOf(id)).includes(w)));
    // The same rule as «Saldos» (familyChips): groups of 2+ people still to add, filtered by the search, at most 8.
    const chips = familyChips(groups, (id) => payable.includes(id) && !chosen.includes(id), nameOf, words, { all: allGroups });
    const groupChips = chips.shown;
    return (
        <div className="rounded-2xl border border-blue-100 bg-blue-50/30 p-3 space-y-3" data-person-picker="">
            <input
                type="search"
                className={cx("w-full min-h-11 border-2 border-gray-100 rounded-xl px-4 py-2 bg-white focus:border-blue-500 outline-none font-medium", touchTextCls)}
                placeholder="Buscar persona"
                aria-label="Buscar persona para añadir"
                value={q}
                onChange={(e) => setQ(e.target.value)}
            />
            {groupChips.length > 0 && (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Añadir un grupo familiar">
                    {groupChips.map((g) => (
                        <button key={g.name} type="button" onClick={() => onAdd(g.ids)} className="min-h-11 px-3 rounded-xl border border-indigo-200 bg-white text-xs font-bold text-indigo-700 hover:bg-indigo-50">
                            <i className="fa-solid fa-people-roof mr-1.5" aria-hidden="true"></i>{g.name} ({g.ids.length})
                        </button>
                    ))}
                    {chips.hidden > 0 && (
                        <button type="button" onClick={() => setAllGroups(true)} className="min-h-11 px-3 rounded-xl text-xs font-black text-indigo-700 underline" data-more-groups="">
                            Ver más grupos ({chips.hidden})
                        </button>
                    )}
                </div>
            )}
            {list.length === 0 ? (
                <p className="text-xs text-gray-600 px-1">{payable.length === 0 ? "Nadie de tu localidad tiene saldo por pagar." : words.length ? "Nadie con saldo coincide con la búsqueda." : "Ya añadiste a todas las personas con saldo."}</p>
            ) : (
                // Capped by the room the sheet has (40dvh: ~150 px on a phone held sideways, whose sheet body is ~205 px)
                // and NOT overscroll-contained: at its end a drag goes on scrolling the sheet to «Pago», «Reparto» and
                // «Comprobante». A 256 px nested list there filled the body and kept every swipe (2.18.0 review PUX-4).
                <ul className="max-h-[min(16rem,40dvh)] overflow-y-auto divide-y divide-blue-50 rounded-xl bg-white border border-gray-100" data-picker-list="">
                    {list.map((id) => (
                        <li key={id}>
                            <button type="button" onClick={() => onAdd([id])} className="w-full min-h-12 flex items-center justify-between gap-3 px-4 py-2 text-left hover:bg-blue-50">
                                <span className="min-w-0 font-bold text-sm text-gray-900 break-words">{nameOf(id)}</span>
                                <span className="shrink-0 text-right text-xs text-gray-600 tabular-nums" data-picker-owed="">
                                    {owedLines(ctx.balances.get(id)).map((line, i) => <span key={i} className={cx("block whitespace-nowrap", i > 0 && "text-amber-800")}>{line}</span>)}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/** Where the focus goes once the receipt picker changed under it: «Cambiar», else the empty picker's button. */
export function proofFocusTarget(root: Pick<ParentNode, "querySelector"> | null | undefined): HTMLElement | null {
    if (!root) return null;
    return root.querySelector<HTMLElement>('[data-proof-change]') || root.querySelector<HTMLElement>('[data-proof-state="empty"]') || null;
}

/**
 * The receipt: «Tomar foto o elegir archivo» → «Preparando foto…» → thumbnail, size, «Cambiar», «Quitar».
 * The photo is shrunk on the device (proofImage.ts). A payment being corrected shows its stored receipt
 * on demand («Ver») and keeps it unless it is replaced or removed. «Preparando foto…» shows whichever state
 * the picker is in — also when a receipt is already there and «Cambiar» was tapped — and `onWorking` tells
 * the sheet, which keeps «Enviar» disabled meanwhile (`working` is that flag back, from the draft).
 */
export function ProofPicker({ required, proof, stored, storedLabel, onProof, onRemoveStored, loadStored, env, working: workingProp, onWorking }: {
    required: boolean;
    proof: string | null;
    stored: boolean;
    storedLabel: string;
    onProof: (proof: string | null) => void;
    onRemoveStored: () => void;
    loadStored?: () => Promise<string>;
    env?: ProofEnv<DecodedImage>;
    working?: boolean;
    onWorking?: (working: boolean) => void;
}) {
    const [state, setState] = useState<{ phase: "idle" | "working" | "error"; message?: string }>({ phase: "idle" });
    const [storedImg, setStoredImg] = useState<string | null>(null);
    const inputId = React.useId();
    // The focus was in the picker when what it shows changed (a photo picked, «Quitar»): the button pressed is gone
    // then, and the focus fell to <body> — a keyboard or screen-reader user lost their place in the sheet (2.18.0
    // review UX6-5). It goes back to «Cambiar», else «Tomar foto o elegir archivo» (proofFocusTarget).
    const rootRef = React.useRef<HTMLElement>(null);
    const refocus = React.useRef(false);
    const focusWasIn = () => !!(rootRef.current && typeof document !== "undefined" && rootRef.current.contains(document.activeElement));
    // «Tomar foto o elegir archivo» / «Cambiar» are BUTTONS that open the hidden file input: a keyboard lands on them
    // with a visible ring. As <label>s they took no focus and Tab went to an invisible 1 px input, nothing on screen
    // showing where (2.18.0 review PUX-6, WCAG 2.4.7).
    const inputRef = React.useRef<HTMLInputElement>(null);
    const choose = () => { if (!working) inputRef.current?.click(); };
    const ring = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2";
    const working = state.phase === "working" || !!workingProp;
    // One photo at a time, the LATEST pick winning (pickSequence): while one is shrunk the picker offers no
    // way to pick another (no <label>, the input disabled), and a result that is not the latest is dropped.
    const picks = React.useRef(pickSequence()).current;
    const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        refocus.current = refocus.current || focusWasIn();
        const mine = picks.next();
        setState({ phase: "working" });
        onWorking?.(true);
        try {
            const r = await prepareProof(file, (env ?? browserProofEnv) as ProofEnv<DecodedImage>);
            if (!picks.isLatest(mine)) return;
            onProof(r.dataUrl);
            setState({ phase: "idle" });
        } catch (err) {
            if (!picks.isLatest(mine)) return;
            setState({ phase: "error", message: err instanceof ProofError ? err.message : "No pudimos leer la imagen; prueba con otra foto." });
        } finally {
            if (picks.isLatest(mine)) onWorking?.(false);
        }
    };
    React.useEffect(() => {
        if (working || !refocus.current) return;
        refocus.current = false;
        const el = proofFocusTarget(rootRef.current);
        try { el?.focus({ preventScroll: true }); } catch { /* gone */ }
    }, [working, proof, stored, state.phase]);
    const removeNew = () => { refocus.current = focusWasIn(); onProof(null); };
    const removeStored = () => { refocus.current = focusWasIn(); onRemoveStored(); };
    const preparing = <span className="text-sm font-bold text-blue-700" role="status" data-proof-working=""><i className="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i>Preparando foto…</span>;
    const showStored = async () => {
        if (!loadStored) return;
        try { setStoredImg(await loadStored()); } catch { setState({ phase: "error", message: "No se pudo cargar el comprobante." }); }
    };
    return (
        <section ref={rootRef} className="space-y-3" data-register-section="proof">
            <h4 className={labelCls}>
                Comprobante{" "}
                {required ? <span className="text-rose-600 normal-case tracking-normal font-bold">(obligatorio para una transferencia)</span> : <span className="text-gray-500 normal-case tracking-normal font-bold">(opcional en efectivo)</span>}
            </h4>
            {working ? (
                <div className="flex items-center justify-center min-h-24 rounded-2xl border-2 border-dashed border-blue-200 bg-blue-50/30 px-4 py-4" data-proof-state="working">{preparing}</div>
            ) : proof ? (
                <div className="flex items-center gap-3 rounded-2xl border border-gray-100 p-3" data-proof-state="new">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a local data: URL, never optimisable */}
                    <img src={proof} alt="Comprobante de pago" className="w-16 h-16 rounded-xl object-cover border border-gray-200 shrink-0" />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-gray-900">Foto lista</p>
                        <p className="text-xs text-gray-600 tabular-nums">{sizeLabel(dataUrlBytes(proof))}</p>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-1">
                        <button type="button" onClick={choose} className={cx("min-h-11 inline-flex items-center justify-center px-3 rounded-xl text-xs font-black text-blue-700 hover:bg-blue-50 cursor-pointer", ring)} data-proof-change="">Cambiar</button>
                        <button type="button" className="min-h-11 px-3 rounded-xl text-xs font-black text-rose-700 hover:bg-rose-50" onClick={removeNew} data-proof-remove="">Quitar</button>
                    </div>
                </div>
            ) : stored ? (
                <div className="rounded-2xl border border-gray-100 p-3 space-y-2" data-proof-state="stored">
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="emerald" size="xs" icon="fa-paperclip">{storedLabel}</Badge>
                        {loadStored && !storedImg && <Button variant="ghost" size="sm" onClick={showStored}>Ver</Button>}
                        <button type="button" onClick={choose} className={cx("min-h-11 inline-flex items-center justify-center px-3 rounded-xl text-xs font-black text-blue-700 hover:bg-blue-50 cursor-pointer", ring)} data-proof-change="">Cambiar</button>
                        <button type="button" className="min-h-11 px-3 rounded-xl text-xs font-black text-rose-700 hover:bg-rose-50" onClick={removeStored} data-proof-remove="">Quitar</button>
                    </div>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL from the API */}
                    {storedImg && <img src={storedImg} alt="Comprobante guardado" className="max-h-64 w-auto rounded-xl border border-gray-200" />}
                </div>
            ) : (
                <button type="button" onClick={choose} className={cx("w-full flex flex-col items-center justify-center gap-1 min-h-24 rounded-2xl border-2 border-dashed px-4 py-4 text-center cursor-pointer transition-colors", required ? "border-blue-200 bg-blue-50/30 hover:border-blue-400" : "border-gray-200 bg-gray-50/30 hover:border-blue-300", ring)} data-proof-state="empty">
                    <i className="fa-solid fa-camera text-xl text-blue-500" aria-hidden="true"></i>
                    <span className="text-sm font-bold text-gray-800">Tomar foto o elegir archivo</span>
                    <span className="text-[11px] text-gray-500">Se reduce en tu teléfono antes de enviarla</span>
                </button>
            )}
            <input ref={inputRef} id={inputId} type="file" accept="image/*" className="sr-only" onChange={pick} disabled={working} tabIndex={-1} aria-hidden="true" data-testid="proof-input" />
            {state.phase === "error" && <p className="text-xs font-bold text-rose-700" role="alert">{state.message}</p>}
        </section>
    );
}
