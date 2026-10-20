// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Pagos de cuotas» (2.18.0) — the small visual pieces shared by the fee screens, the inscription tables and
 * the person sheet: the payment status pill, the person's money pill and chips, the compact KPI tiles, the
 * segmented control and the stacked «Resumen» bar. Status is ALWAYS text plus an icon, never colour alone.
 */
import React from "react";
import { fmtFeeMoney } from "../lib/conference";
import { balanceChips, barPercents, moneyText, statusMeta } from "../lib/feePayments";
import type { Balance } from "../lib/feePayments";
import { useTx } from "./MealScanner";

/** Cents → «$1.250,00» — the coordinator portal's format (lib/conference.ts fmtFeeMoney). */
export const money = (c: number) => moneyText(Math.round(Number(c) || 0), fmtFeeMoney);

/**
 * A payment reference («Ref. KEEP-77», «TRF-1001») as ONE unit: it moves to the next line whole instead of
 * breaking after «Ref.» or at its hyphen («KEEP-» / «77») — an admin matches it against a bank statement.
 * Only a reference longer than a whole line wraps inside (inline styles: no plugin class needed).
 */
export function RefText({ children }: { children: React.ReactNode }) {
    return <span data-ref="" style={{ display: 'inline-block', maxWidth: '100%', overflowWrap: 'anywhere' }}>{children}</span>;
}

/**
 * A line of facts («$250,00 · Efectivo · 07/10/2026 · Ref. X»): each fact one unit carrying its OWN leading «· »,
 * for a wrapping row (`flex flex-wrap gap-x-1`), so a narrow line breaks BETWEEN facts — never leaving a «·» alone
 * at the end of a line (2.18.0 reviews PUX-10, UX6-3). A short fact never breaks inside (nowrap). `long`: facts that
 * may be longer than a phone's line (a list of names, «registrado 11/10 22:10 por <login>») move to the next line
 * whole and wrap inside only when longer than a whole line — their «·» glued to the first word (U+00A0). `ref` (a
 * reference, already worded) is a RefText unit.
 */
export function factsOf(parts: React.ReactNode[], ref?: React.ReactNode, { long = false }: { long?: boolean } = {}): React.ReactNode[] {
    const style: React.CSSProperties = long ? { display: 'inline-block', maxWidth: '100%', overflowWrap: 'anywhere' } : { whiteSpace: 'nowrap' };
    const dot = long ? '·\u00a0' : '· ';
    const out: React.ReactNode[] = parts.filter((x) => x != null && x !== false && x !== '').map((x, i) => (
        <span key={i} style={style} data-fact="">{i > 0 ? dot : ''}{x}</span>
    ));
    if (ref) out.push(<RefText key="ref">{out.length ? dot : ''}{ref}</RefText>);
    return out;
}

/**
 * The exact-sum line of a split, the portal's words (RegisterPaymentSheet SumLine): «Asignado $X de $Y» and
 * «✓ Cuadra» / «Faltan $Z» / «Sobran $Z». `invalid`: the sum is right but a part is not (≤ 0).
 */
export function SumState({ assignedC, totalC, invalid = '', className = '' }: { assignedC: number; totalC: number; invalid?: string; className?: string }) {
    const tx = useTx();
    const diff = totalC - assignedC;
    const ok = diff === 0 && totalC > 0 && !invalid;
    return (
        <p data-split-state={ok ? 'ok' : diff > 0 ? 'short' : diff < 0 ? 'over' : 'invalid'} aria-live="polite"
            className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl px-3 py-2 text-sm font-black ${ok ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'} ${className}`}>
            <span className="tabular-nums">{tx('fees.split.assigned', 'Asignado {assigned} de {total}', { assigned: money(assignedC), total: money(totalC) })}</span>
            <span>{diff === 0
                ? (ok ? <><i className="fa-solid fa-check mr-1" aria-hidden="true"></i>{tx('fees.split.ok', 'Cuadra')}</> : invalid)
                : diff > 0 ? tx('fees.split.missing', 'Faltan {amount}', { amount: money(diff) }) : tx('fees.split.extra', 'Sobran {amount}', { amount: money(-diff) })}</span>
        </p>
    );
}

export function StatusPill({ status, className = '' }: { status: string; className?: string }) {
    const tx = useTx();
    const m = statusMeta(status);
    return (
        <span data-fee-status={status} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-black uppercase tracking-widest whitespace-nowrap ${m.cls} ${className}`}>
            <i className={`fa-solid ${m.icon}`} aria-hidden="true"></i>{tx(m.key, m.fallback)}
        </span>
    );
}

const PILL: Record<string, { key: string; fallback: string; cls: string; icon: string }> = {
    paid: { key: 'fees.pill.paid', fallback: 'Pagado', cls: 'bg-emerald-50 text-emerald-800', icon: 'fa-circle-check' },
    partial: { key: 'fees.pill.partial', fallback: 'Abono', cls: 'bg-amber-50 text-amber-800', icon: 'fa-circle-half-stroke' },
    unpaid: { key: 'fees.pill.unpaid', fallback: 'Sin pagar', cls: 'bg-rose-50 text-rose-800', icon: 'fa-circle-xmark' },
};
/** Pagado / Abono / Sin pagar — from VALIDATED money only. A button when `onClick` is given. */
export function PayPill({ state, onClick, label }: { state: string; onClick?: () => void; label?: string }) {
    const tx = useTx();
    const m = PILL[state] || PILL.unpaid;
    const cls = `inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest whitespace-nowrap ${m.cls}`;
    const body = <><i className={`fa-solid ${m.icon}`} aria-hidden="true"></i>{tx(m.key, m.fallback)}</>;
    return onClick
        ? <button type="button" onClick={onClick} className={`${cls} min-h-[44px] hover:ring-2 hover:ring-blue-200`} aria-label={label} data-pay-pill={state}>{body}</button>
        : <span className={cls} data-pay-pill={state}>{body}</span>;
}

/**
 * «⏱ $X por validar», «↩ $X devuelto», «+$X a favor», «Cancelada» — only those that apply. `wrap`: a chip may
 * break between its words (a narrow table cell: «$1.300.000,00 por validar» never runs into the next column).
 */
export function BalanceChips({ balance, className = '', wrap = false }: { balance: Balance; className?: string; wrap?: boolean }) {
    const tx = useTx();
    const chips = balanceChips(balance);
    if (!chips.length) return null;
    const nw = wrap ? 'whitespace-normal text-left' : 'whitespace-nowrap';
    return (
        <span className={`inline-flex flex-wrap items-center gap-1 ${className}`}>
            {chips.map((c) => c.kind === 'pending' ? (
                <span key="p" data-chip="pending" className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 text-[10px] font-black ${nw}`}><i className="fa-solid fa-clock" aria-hidden="true"></i>{tx('fees.chip.pending', '{amount} por validar', { amount: money(c.cents) })}</span>
            ) : c.kind === 'returned' ? (
                <span key="r" data-chip="returned" className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-50 text-orange-800 text-[10px] font-black ${nw}`}><i className="fa-solid fa-rotate-left" aria-hidden="true"></i>{tx('fees.chip.returned', '{amount} devuelto', { amount: money(c.cents) })}</span>
            ) : c.kind === 'credit' ? (
                <span key="c" data-chip="credit" className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-50 text-sky-800 text-[10px] font-black ${nw}`}><i className="fa-solid fa-plus" aria-hidden="true"></i>{tx('fees.chip.credit', '{amount} a favor', { amount: money(c.cents) })}</span>
            ) : (
                <span key="x" data-chip="cancelled" className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-[10px] font-black uppercase tracking-widest whitespace-nowrap"><i className="fa-solid fa-ban" aria-hidden="true"></i>{tx('roster.cancelled', 'Cancelada')}</span>
            ))}
        </span>
    );
}

/**
 * An amount in a tile is NEVER broken («$7.500.000,0» / «0» in a 117 px phone tile): one line, and its size
 * follows the tile — the tile is a size container and the figure gets 100cqi / (its characters × 0.62 em),
 * at most `maxRem`. A browser without container units keeps a size chosen by the length alone.
 */
export function kpiValueFit(text: string, maxRem = 1.25): { className: string; style: Record<string, string> } {
    const n = Math.max(1, String(text || '').length);
    const fallback = n <= 10 ? 'text-lg sm:text-xl' : n <= 12 ? 'text-base' : n <= 14 ? 'text-sm' : 'text-xs';
    return { className: `whitespace-nowrap ${fallback}`, style: { fontSize: `min(${maxRem}rem, calc(100cqi / ${(n * 0.62).toFixed(2)}))` } };
}

/** The box of every KPI tile, button or not: a column stacked from the top (see KpiTile). */
export const KPI_TILE_BOX = Object.freeze({ containerType: 'inline-size', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', alignItems: 'stretch' });

/**
 * The keyboard of a one-choice strip (WAI-ARIA APG radio group / tabs): the key an arrow, Home or End moves the
 * choice to — ArrowRight / ArrowDown the next, ArrowLeft / ArrowUp the previous (both wrapping), Home the first,
 * End the last — skipping disabled ones; null for any other key. `current` = the chosen key (or the focused one).
 */
export function segmentKeyTarget(keys: string[], current: string, key: string, disabled: (k: string) => boolean = () => false): string | null {
    const live = keys.filter((k) => !disabled(k));
    if (!live.length) return null;
    const i = live.indexOf(current);
    switch (key) {
        case 'ArrowRight': case 'ArrowDown': return live[(i + 1 + live.length) % live.length];
        case 'ArrowLeft': case 'ArrowUp': return live[(i - 1 + live.length) % live.length];
        case 'Home': return live[0];
        case 'End': return live[live.length - 1];
        default: return null;
    }
}
/**
 * The keydown of a strip option: moves the choice (onChange) and the focus to the option `segmentKeyTarget` names.
 * The options are found by `attr` (data-seg="key") among the strip's own buttons.
 */
export function segmentKeyDown(e: any, keys: string[], current: string, onChange: (k: string) => void, attr = 'data-seg', disabled?: (k: string) => boolean) {
    const next = segmentKeyTarget(keys, current, e.key, disabled);
    if (next == null) return;
    e.preventDefault();
    if (next !== current) onChange(next);
    const strip = e.currentTarget && e.currentTarget.parentElement;
    const btn = strip && typeof strip.querySelector === 'function' ? strip.querySelector(`[${attr}="${String(next).replace(/["\\]/g, '\\$&')}"]`) : null;
    if (btn && typeof btn.focus === 'function') { try { btn.focus(); } catch { /* ignore */ } }
}

/** A compact 64–72 px figure. A button when `onClick` is given. */
export function KpiTile({ label, value, icon, tone = 'gray', onClick, kpi }: { label: string; value: React.ReactNode; icon: string; tone?: string; onClick?: () => void; kpi?: string }) {
    const tones: Record<string, string> = {
        gray: 'text-gray-900', emerald: 'text-emerald-700', amber: 'text-amber-700', orange: 'text-orange-700', rose: 'text-rose-700', sky: 'text-sky-700', blue: 'text-blue-700',
    };
    const fit = kpiValueFit(typeof value === 'string' ? value : '');
    const inner = (
        <>
            <span className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-gray-500"><i className={`fa-solid ${icon}`} aria-hidden="true"></i>{label}</span>
            <span className={`block font-black tabular-nums mt-0.5 ${fit.className} ${tones[tone] || tones.gray}`} style={fit.style} data-kpi-value="">{value}</span>
        </>
    );
    const cls = 'min-h-[64px] min-w-0 text-left rounded-2xl border border-gray-100 bg-gray-50/70 px-4 py-3';
    // KPI_TILE_BOX: a tile that is a <button> (it opens a list) stacks its label and figure from the TOP like its
    // <div> siblings — a button centres its content vertically, and in a row stretched by a longer tile its
    // figures sat ~8 px lower than the rest (2.18.0 skeptic round 4). Inline: no plugin class needed.
    const box = KPI_TILE_BOX;
    return onClick
        ? <button type="button" onClick={onClick} className={`${cls} hover:border-blue-300 hover:bg-blue-50/40`} style={box} data-kpi={kpi}>{inner}</button>
        : <div className={cls} style={box} data-kpi={kpi}>{inner}</div>;
}

/**
 * The strip's phone rules (unlayered, like OVERLAY_CSS: plugin `sm:` variants can lose to host classes).
 * Below 640 px every choice stays in sight — the choices share the width and wrap onto a second row when they
 * do not fit (four sections become two rows of two), instead of scrolling sideways where «Resumen» hid off
 * the left edge with nothing hinting at it. From 640 px it is a compact strip that STILL wraps when its row does
 * not fit: the strip lives in a panel, not in the window — beside the 320 px admin sidebar an iPhone held
 * sideways (844 px) left it ~424 px and «SALDOS» stuck out of the strip; an iPad in portrait, or the longer
 * en / pt labels, pushed it past the panel's edge. A holder marked `data-cm-seg-box` (the «Pagos de cuotas»
 * tabs) is a size container: below 36rem of room its four sections are two rows of two, as on a phone.
 */
export const SEGMENTED_CSS = `
[data-cm-segmented] { display: flex; flex-wrap: wrap; }
[data-cm-segmented] > [data-seg] { flex: 1 1 auto; justify-content: center; min-width: 0; }
@media (max-width: 639.98px) {
  [data-cm-segmented][data-seg-count="4"] > [data-seg] { flex-basis: calc(50% - 0.25rem); }
  [data-cm-segmented] > [data-seg] { white-space: normal; text-align: center; padding-left: 0.5rem; padding-right: 0.5rem; }
}
@media (min-width: 640px) {
  [data-cm-segmented] { display: inline-flex; max-width: 100%; }
}
[data-cm-seg-box] { container: cm-seg / inline-size; }
@container cm-seg (max-width: 35.99rem) {
  [data-cm-segmented][data-seg-count="4"] { display: flex; }
  [data-cm-segmented][data-seg-count="4"] > [data-seg] { flex-basis: calc(50% - 0.25rem); white-space: normal; text-align: center; padding-left: 0.5rem; padding-right: 0.5rem; }
}
`;

/**
 * A one-choice strip of 44 px buttons. `variant="tabs"` (default) switches sections (tablist / tab);
 * `variant="radio"` picks a form value — the method, the split mode — and is announced as one
 * (radiogroup / radio, aria-checked).
 */
export function SegmentedControl({ options, value, onChange, label, className = '', variant = 'tabs' }: { options: { key: string; label: string; badge?: number | string | null }[]; value: string; onChange: (k: string) => void; label: string; className?: string; variant?: 'tabs' | 'radio' }) {
    const radio = variant === 'radio';
    // ONE Tab stop (the chosen option, else the first) and the arrow keys inside, as the roles promise (APG): a
    // screen reader says «radio button, 1 of 2» / «tab, 1 of 4» and its user presses an arrow (2.18.0 PUX-7).
    const keys = options.map((o) => o.key);
    const stop = keys.includes(value) ? value : keys[0];
    return (
        <div role={radio ? 'radiogroup' : 'tablist'} aria-label={label} className={`gap-1 p-1 rounded-2xl bg-gray-100 ${className}`} data-cm-segmented="" data-seg-count={options.length}>
            <style>{SEGMENTED_CSS}</style>
            {options.map((o) => {
                const on = o.key === value;
                const state = radio ? { role: 'radio', 'aria-checked': on ? 'true' : 'false' } : { role: 'tab', 'aria-selected': on ? 'true' : 'false' };
                return (
                    <button key={o.key} type="button" {...state} onClick={() => onChange(o.key)} data-seg={o.key}
                        tabIndex={o.key === stop ? 0 : -1} onKeyDown={(e) => segmentKeyDown(e, keys, o.key, onChange)}
                        className={`min-h-[44px] px-4 rounded-xl text-xs font-black uppercase tracking-widest whitespace-nowrap inline-flex items-center gap-2 ${on ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}>
                        {o.label}
                        {/* amber-700 under white text: ≥ 4.5:1 (amber-500 was ~2.2:1, and this count is the cue that work waits). */}
                        {o.badge != null && o.badge !== 0 && o.badge !== '' && <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${on ? 'bg-blue-600 text-white' : 'bg-amber-700 text-white'}`} data-seg-badge="">{o.badge}</span>}
                    </button>
                );
            })}
        </div>
    );
}

/** Validado + Por validar + Por cobrar = Cuotas, one stacked bar with its legend (cents in, labels out). */
export function MoneyBar({ seg }: { seg: { due: number; validated: number; pending: number; toCover: number } }) {
    const tx = useTx();
    const pct = barPercents(seg);
    return (
        <div data-money-bar="">
            <div className="w-full h-3 rounded-full overflow-hidden flex bg-gray-100" role="img"
                aria-label={tx('fees.bar.aria', 'Validado {v} · Por validar {p} · Por cobrar {c} de {d}', { v: money(seg.validated), p: money(seg.pending), c: money(seg.toCover), d: money(seg.due) })}>
                <div className="bg-emerald-500 h-full" style={{ width: `${pct.validated}%` }}></div>
                <div className="bg-amber-400 h-full" style={{ width: `${pct.pending}%` }}></div>
                <div className="bg-rose-200 h-full" style={{ width: `${pct.toCover}%` }}></div>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] font-bold text-gray-600">
                <span><i className="fa-solid fa-square text-emerald-500 mr-1" aria-hidden="true"></i>{tx('fees.kpi.validated', 'Validado')} {money(seg.validated)}</span>
                <span><i className="fa-solid fa-square text-amber-400 mr-1" aria-hidden="true"></i>{tx('fees.kpi.pending', 'Por validar')} {money(seg.pending)}</span>
                <span><i className="fa-solid fa-square text-rose-200 mr-1" aria-hidden="true"></i>{tx('fees.kpi.to.cover', 'Por cobrar')} {money(seg.toCover)}</span>
            </div>
        </div>
    );
}

/** The same spinner every plugin screen uses. */
export function Spinner({ label }: { label?: string }) {
    return (
        <div className="text-center py-16" role="status">
            <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-3"></div>
            {label && <p className="text-gray-500 text-xs font-bold uppercase tracking-widest">{label}</p>}
        </div>
    );
}
