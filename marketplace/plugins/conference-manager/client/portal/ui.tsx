// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * Visual primitives for the coordinator portal — the SAME design language as the conference-manager
 * admin page (marketplace/plugins/conference-manager/client/admin/page.tsx): rounded-3xl / [40px]
 * white cards with soft gray-100 shadows, black-italic tight-tracked headings, 10px uppercase
 * wide-tracked labels, 2px gray-100 input borders that turn blue on focus, blue-600 primary buttons
 * with a blue-500/30 shadow, gray-50 icon buttons that fill with a colour on hover, rounded-full
 * badges, and the blurred colour blobs behind hero cards. Keep every class recipe here in sync with
 * the admin page when it changes; both surfaces must keep looking like one product.
 *
 * Tailwind v4 emits conflicting utilities in a FIXED order (the later one in the stylesheet wins,
 * whatever the className order), so a caller can never override a primitive's `py-3` / `text-[10px]`
 * / `tracking-widest` by appending another value. Every variation lives here as a prop or a
 * separate class string instead.
 *
 * PHONES FIRST («debe servir en todos los celulares», iPhone Safari included): every control is at least
 * 44 px tall (Button, IconButton, Pager, MoreButton, SegmentedControl, CheckboxLabel), inputs are 16 px
 * below 640 px (iOS zooms the page into a smaller field on focus), and a Modal is a bottom sheet on a
 * phone, capped by the DYNAMIC viewport, with the page behind it pinned (lockBodyScroll).
 */
import React from "react";
import { createPortal } from "react-dom";
import { tidyMoneyInput } from "./feeSplit";
import { FieldError } from "../lib/useFieldErrors";
import { Select } from "../lib/Select";

export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(" ");

// ── text ─────────────────────────────────────────────────────────────────────────────────────────
// Labels and captions are gray-500 (≈4.8:1 on white, WCAG AA), not gray-400 (≈2.6:1): read outdoors on a
// phone, «REFERENCIA» and «FECHA DEL PAGO» must be legible — the plugin admin's labels are gray-500 too.
/** 10px black uppercase label, as above every admin form field / table column. */
export const labelCls = "block text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1";
/** Heading shape without a colour (so a caller can grey a disabled name): black, italic, tight tracking. */
export const headingShapeCls = "font-black italic tracking-tighter";
/** Page / card heading: black, italic, tight tracking (admin: location names, conference name). */
export const headingCls = cx(headingShapeCls, "text-gray-900");
/** Caption without its tracking; `captionCls` adds the admin's default `tracking-widest`. */
export const captionBaseCls = "text-[10px] text-gray-500 font-bold uppercase";
/** Tiny uppercase caption under a heading (admin: "Sedes regionales y grupos locales"). */
export const captionCls = cx(captionBaseCls, "tracking-widest");
/** The wider 0.2em caption the admin uses under card titles and the dashboard hero. */
export const captionWideCls = cx(captionBaseCls, "tracking-[0.2em]");

// ── inputs ───────────────────────────────────────────────────────────────────────────────────────
/** Input shape without size / weight / focus colour — compose it when a variant is needed. */
const inputShapeCls = "w-full border-2 border-gray-100 rounded-xl px-4 bg-gray-50/30 focus:bg-white transition-all outline-none text-gray-900 placeholder:text-gray-300 disabled:opacity-60 disabled:cursor-not-allowed";
/**
 * Text size of every input: 16 px below 640 px (iOS Safari zooms the whole page into a field under 16 px
 * when it takes the focus, and never zooms back), the admin's 14 px from 640 px up — and 16 px on EVERY touch
 * screen whatever its width (an iPhone held sideways is 667–932 px): portalCss.ts PORTAL_COARSE_FIELDS_CSS,
 * rendered by the portal's layout, sets it for every field of the portal and its sheets.
 */
export const touchTextCls = "text-base sm:text-sm";
/** The admin's form input (rule / inscription modals): text-sm (16 px on phones), medium weight, blue focus. */
export const inputCls = cx(inputShapeCls, "py-3 font-medium focus:border-blue-500", touchTextCls);
export const selectCls = inputCls;
/** Same input in the admin's indigo assignment surface (rule modal). */
export const inputIndigoCls = cx(inputShapeCls, "py-3 font-medium focus:border-indigo-500", touchTextCls);
/** Dense input next to a small button (admin allot bar: `px-3 py-2 text-xs`; 16 px on phones). */
export const inputDenseCls = cx(inputShapeCls, "py-2 font-medium focus:border-blue-500 text-base sm:text-xs");
/** Bold input for amounts / access codes (admin hotel & conference modals use `font-bold`). */
export const inputBoldCls = cx(inputShapeCls, "py-3 font-bold focus:border-blue-500", touchTextCls);
export const checkboxCls = "w-4 h-4 rounded border-2 border-gray-200 text-blue-600 accent-blue-600 cursor-pointer";
/** A checkbox big enough to hit on a phone (inside CheckboxLabel's 44 px target). */
export const touchCheckboxCls = "w-5 h-5 rounded border-2 border-gray-200 text-blue-600 accent-blue-600 cursor-pointer shrink-0";

/**
 * A checkbox inside a 44×44 px label, so the whole square is the target (a 16 px box alone is too small
 * for a thumb). `label` is the accessible name (the label has no visible text).
 */
export function CheckboxLabel({ checked, onChange, label, indeterminate, disabled, className, testId }: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: string;
    indeterminate?: boolean;
    disabled?: boolean;
    className?: string;
    testId?: string;
}) {
    const ref = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate && !checked; }, [indeterminate, checked]);
    return (
        <label className={cx("inline-flex items-center justify-center min-w-11 min-h-11 shrink-0 rounded-xl cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-400", disabled && "cursor-not-allowed opacity-50", className)} data-touch-check="">
            <input
                ref={ref}
                type="checkbox"
                className={touchCheckboxCls}
                checked={checked}
                aria-checked={indeterminate && !checked ? "mixed" : checked}
                aria-label={label}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked)}
                data-testid={testId}
            />
        </label>
    );
}

export function Label({ children, className, htmlFor }: { children: React.ReactNode; className?: string; htmlFor?: string }) {
    return <label htmlFor={htmlFor} className={cx(labelCls, className)}>{children}</label>;
}

/**
 * Label + control + optional help line, the admin's `space-y-1.5` field block. Pass the control as a
 * render function to receive the id the label points at: `<Field label="Nombre">{(id) => <input id={id} … />}</Field>`.
 */
/** `error` / `errorId`: the field's in-app validation message (useFieldErrors), shown under the control. */
export function Field({ label, help, children, className, htmlFor, error, errorId }: { label: React.ReactNode; help?: React.ReactNode; children: React.ReactNode | ((id: string) => React.ReactNode); className?: string; htmlFor?: string; error?: string | null; errorId?: string }) {
    const auto = React.useId();
    const id = htmlFor ?? auto;
    return (
        <div className={cx("space-y-1.5", className)}>
            <Label htmlFor={typeof children === "function" || htmlFor ? id : undefined}>{label}</Label>
            {typeof children === "function" ? children(id) : children}
            {help ? <p className="text-[11px] text-gray-500 ml-1 leading-relaxed">{help}</p> : null}
            <FieldError message={error} id={errorId} />
        </div>
    );
}

// ── buttons ──────────────────────────────────────────────────────────────────────────────────────
export type ButtonVariant = "primary" | "indigo" | "dark" | "success" | "danger" | "dangerGhost" | "outline" | "outlineIndigo" | "ghost";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

const buttonVariant: Record<ButtonVariant, string> = {
    primary: "bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-500/30",
    /** The admin's assignment surface (rule editor save, run). */
    indigo: "bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-500/30",
    dark: "bg-gray-900 text-white hover:bg-blue-600 shadow-xl shadow-gray-200",
    success: "bg-emerald-600 text-white hover:bg-emerald-700 shadow-lg shadow-emerald-500/30",
    danger: "bg-rose-600 text-white hover:bg-rose-700 shadow-lg shadow-rose-500/30",
    /** The admin's "reset all assignments" ghost: rose text, rose-50 fill and hairline on hover. */
    dangerGhost: "text-rose-600 hover:bg-rose-50 border-2 border-transparent hover:border-rose-100",
    outline: "bg-white text-gray-700 border-2 border-gray-100 hover:border-blue-500 hover:text-blue-600 shadow-sm",
    /** The admin's "Add rule" button: white, indigo text, indigo-50 on hover. */
    outlineIndigo: "bg-white text-indigo-600 border-2 border-gray-100 hover:bg-indigo-50 hover:border-indigo-200",
    ghost: "text-gray-500 hover:bg-gray-100 hover:text-gray-900",
};
const buttonSize: Record<ButtonSize, string> = {
    /** Dense, next to a dense input (admin allot bar: `px-4 py-2`). */
    xs: "px-4 py-2 text-[10px] rounded-xl",
    sm: "px-4 py-2 text-[10px] rounded-2xl",
    md: "px-6 py-3 text-[10px] rounded-2xl",
    lg: "px-8 py-4 text-[10px] rounded-2xl",
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    icon?: string;
    /** Full-width (login / modal footers on phones). */
    block?: boolean;
};

/** The admin's pill-shaped action button: black 10px uppercase text, wide tracking, scale on press. At least 44 px tall (a thumb). */
export function Button({ variant = "primary", size = "md", icon, block, className, children, type = "button", ...rest }: ButtonProps) {
    return (
        <button
            type={type}
            className={cx(
                "inline-flex items-center justify-center gap-2 min-h-11 font-black uppercase tracking-widest transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100",
                buttonVariant[variant], buttonSize[size], block && "w-full", className,
            )}
            {...rest}
        >
            {icon ? <i className={cx("fa-solid", icon, "text-[9px]")}></i> : null}
            {children}
        </button>
    );
}

export type IconButtonTone = "blue" | "emerald" | "rose" | "amber" | "gray";
export type IconButtonVariant = "fill" | "soft";
/** Fill: gray-50 at rest, filled with the colour (and a lighter hairline) on hover — the admin roster row actions. */
const iconToneFill: Record<IconButtonTone, string> = {
    blue: "hover:bg-blue-600 hover:border-blue-400",
    emerald: "hover:bg-emerald-600 hover:border-emerald-400",
    rose: "hover:bg-rose-600 hover:border-rose-400",
    amber: "hover:bg-amber-500 hover:border-amber-300",
    gray: "hover:bg-gray-700 hover:border-gray-500",
};
/** Soft: white with a hairline, tinted (not filled) on hover — the admin AssignmentPage rule actions. */
const iconToneSoft: Record<IconButtonTone, string> = {
    blue: "hover:text-blue-600 hover:border-blue-100 hover:bg-blue-50",
    emerald: "hover:text-emerald-600 hover:border-emerald-100 hover:bg-emerald-50",
    rose: "hover:text-rose-600 hover:border-rose-100 hover:bg-rose-50",
    amber: "hover:text-amber-600 hover:border-amber-100 hover:bg-amber-50",
    gray: "hover:text-gray-700 hover:border-gray-200 hover:bg-gray-100",
};

/**
 * The admin's square icon button: 9×9 gray-50 fill-on-hover (roster) or 10×10 white soft-tint (rules) —
 * 11×11 (44 px) below 640 px, where it is tapped with a thumb.
 */
export function IconButton({ icon, tone = "blue", variant = "fill", className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; tone?: IconButtonTone; variant?: IconButtonVariant }) {
    return (
        <button
            type="button"
            className={cx(
                "flex items-center justify-center shrink-0 rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed",
                variant === "fill"
                    ? cx("w-11 h-11 sm:w-9 sm:h-9 bg-gray-50 text-gray-400 hover:text-white shadow-sm border border-transparent", iconToneFill[tone])
                    : cx("w-11 h-11 sm:w-10 sm:h-10 bg-white border border-gray-100 text-gray-400", iconToneSoft[tone]),
                className,
            )}
            {...rest}
        >
            <i className={cx("fa-solid", icon, variant === "fill" ? "text-xs" : "text-sm")}></i>
        </button>
    );
}

// ── badges ───────────────────────────────────────────────────────────────────────────────────────
export type BadgeTone = "blue" | "emerald" | "amber" | "rose" | "gray" | "indigo" | "orange";
export type BadgeSize = "xs" | "sm";
const badgeTone: Record<BadgeTone, string> = {
    blue: "bg-blue-50 text-blue-700 border-blue-100",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    rose: "bg-rose-50 text-rose-700 border-rose-200",
    gray: "bg-gray-100 text-gray-600 border-gray-100",
    indigo: "bg-indigo-50 text-indigo-700 border-indigo-100",
    /** «Devuelto»: a payment the administration sent back for correction (distinct from amber «Por validar»). */
    orange: "bg-orange-50 text-orange-800 border-orange-200",
};
const badgeSize: Record<BadgeSize, string> = {
    /** The compact pill of a list row (`px-2 py-0.5`); 10 px — it carries a state («Cancelada», «Devuelto»), legible on a phone. */
    xs: "px-2 py-0.5 text-[10px]",
    sm: "px-3 py-1 text-[10px]",
};

/** Rounded-full 10px uppercase status pill (admin: payment status, conference status, lodging status). */
export function Badge({ tone = "gray", size = "sm", icon, children, className, ...rest }: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; size?: BadgeSize; icon?: string }) {
    return (
        <span className={cx("inline-flex items-center gap-1.5 rounded-full font-black uppercase tracking-widest border", badgeTone[tone], badgeSize[size], className)} {...rest}>
            {icon ? <i className={cx("fa-solid", icon, "text-[9px]")} aria-hidden="true"></i> : null}
            {children}
        </span>
    );
}

// ── cards ────────────────────────────────────────────────────────────────────────────────────────
/**
 * The admin's list card: white, rounded-3xl, hairline border, soft shadow. `clip` clips the rounded corners
 * with `overflow: clip` instead of `hidden`, which does not make the card a scroll container — so a
 * `position: sticky` bar inside it (the «Registrar pago (n)» bar) sticks to the screen, not to the card.
 */
export function Card({ className, children, clip, ...rest }: React.HTMLAttributes<HTMLDivElement> & { clip?: boolean }) {
    return <div className={cx("bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-100/30", clip ? "overflow-clip" : "overflow-hidden", className)} {...rest}>{children}</div>;
}

export type HeadingTag = "h2" | "h3" | "h4";

/** Card header row: icon tile + heading + caption on the left, actions on the right. */
export function CardHeader({ icon, title, caption, actions, tone = "blue", className, as: Tag = "h2" }: { icon: string; title: React.ReactNode; caption?: React.ReactNode; actions?: React.ReactNode; tone?: "blue" | "emerald" | "amber" | "indigo" | "rose"; className?: string; as?: HeadingTag }) {
    const tile: Record<string, string> = {
        blue: "bg-blue-600 shadow-blue-100",
        emerald: "bg-emerald-600 shadow-emerald-100",
        amber: "bg-amber-500 shadow-amber-100",
        indigo: "bg-indigo-600 shadow-indigo-100",
        rose: "bg-rose-600 shadow-rose-100",
    };
    return (
        <div className={cx("bg-white border-b border-gray-50 px-6 sm:px-8 py-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4", className)}>
            <div className="flex items-center gap-4 min-w-0">
                <div className={cx("w-12 h-12 rounded-2xl flex items-center justify-center text-white shadow-lg shrink-0", tile[tone])}>
                    <i className={cx("fa-solid", icon)}></i>
                </div>
                <div className="min-w-0">
                    <Tag className={cx("text-xl", headingCls, "truncate")}>{title}</Tag>
                    {caption ? <div className={cx(captionWideCls, "mt-1")}>{caption}</div> : null}
                </div>
            </div>
            {actions ? <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div> : null}
        </div>
    );
}

/** The admin's hero card (rounded-[40px], blurred colour blobs behind). `contentClassName` styles the content wrapper (e.g. `space-y-5`). */
export function HeroCard({ tone = "blue", className, contentClassName, children, ...rest }: React.HTMLAttributes<HTMLDivElement> & { tone?: "blue" | "emerald" | "amber" | "rose"; contentClassName?: string }) {
    const blob: Record<string, [string, string]> = {
        blue: ["bg-blue-50/50", "bg-indigo-50/50"],
        emerald: ["bg-emerald-100/60", "bg-teal-50/60"],
        amber: ["bg-amber-100/60", "bg-orange-50/60"],
        rose: ["bg-rose-100/60", "bg-pink-50/60"],
    };
    return (
        <div className={cx("relative overflow-hidden bg-white rounded-[40px] p-6 sm:p-10 border border-gray-100 shadow-xl shadow-gray-100/50", className)} {...rest}>
            {/* The glow sits in its own clipped layer: outside the card it made the card itself scrollable, and focusing a
                control near its edge (the login's «Mostrar el código») slid the whole form sideways. */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none" style={{ borderRadius: "inherit" }} aria-hidden="true">
                <div className={cx("absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 rounded-full blur-3xl", blob[tone][0])}></div>
                <div className={cx("absolute bottom-0 left-0 -ml-16 -mb-16 w-48 h-48 rounded-full blur-3xl", blob[tone][1])}></div>
            </div>
            <div className={cx("relative", contentClassName)}>{children}</div>
        </div>
    );
}

/** The admin's "── QUICK ACTIONS ──" divider with a tiny uppercase title. */
export function SectionDivider({ children, as: Tag = "h3" }: { children: React.ReactNode; as?: HeadingTag }) {
    return (
        <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-gradient-to-r from-transparent via-gray-200 to-transparent"></div>
            <Tag className="text-[10px] font-black text-gray-400 uppercase tracking-[0.3em] whitespace-nowrap">{children}</Tag>
            <div className="h-px flex-1 bg-gradient-to-r from-transparent via-gray-200 to-transparent"></div>
        </div>
    );
}

/** Small info tile inside a card (admin location cards: "Responsable", "Teléfono", "Inscritos / Cupo"). */
export function InfoTile({ icon, label, children, tone = "blue", className }: { icon: string; label: React.ReactNode; children: React.ReactNode; tone?: "blue" | "indigo" | "emerald" | "amber" | "rose"; className?: string }) {
    const tile: Record<string, string> = {
        blue: "bg-blue-50 text-blue-400",
        indigo: "bg-indigo-50 text-indigo-400",
        emerald: "bg-emerald-50 text-emerald-500",
        amber: "bg-amber-50 text-amber-500",
        rose: "bg-rose-50 text-rose-500",
    };
    return (
        <div className={cx("flex items-center gap-4 p-3 bg-white rounded-xl border border-gray-50 shadow-sm", className)}>
            <div className={cx("w-8 h-8 rounded-lg flex items-center justify-center text-sm shrink-0", tile[tone])}>
                <i className={cx("fa-solid", icon)}></i>
            </div>
            <div className="min-w-0">
                <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{label}</div>
                <div className="text-xs font-black text-gray-700 truncate">{children}</div>
            </div>
        </div>
    );
}

// ── states ───────────────────────────────────────────────────────────────────────────────────────
export function Spinner({ label }: { label?: string }) {
    return (
        <div className="text-center py-20" role="status">
            <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            {label ? <p className="text-gray-600 text-xs font-bold uppercase tracking-widest">{label}</p> : null}
        </div>
    );
}

/** The admin's dashed empty box: 20×20 white tile with a faint icon, 10px uppercase title. `padding` = "sm" where space is tight (inside a table cell). */
export function EmptyState({ icon, title, hint, action, className, padding = "lg" }: { icon: string; title: React.ReactNode; hint?: React.ReactNode; action?: React.ReactNode; className?: string; padding?: "sm" | "lg" }) {
    return (
        <div className={cx("flex flex-col justify-center items-center px-6 bg-gray-50/50 border-2 border-dashed border-gray-100 rounded-3xl text-center", padding === "lg" ? "py-20" : "py-16", className)}>
            <div className="w-20 h-20 shrink-0 bg-white rounded-3xl flex items-center justify-center text-gray-200 text-3xl shadow-sm mb-4">
                <i className={cx("fa-solid", icon)}></i>
            </div>
            {/* gray-600 on the gray-50 box: ≥ 4.5:1 (AA) for 12 px text, legible outdoors on a phone. */}
            <p className="text-gray-600 text-xs font-bold uppercase tracking-widest" data-empty-title="">{title}</p>
            {hint ? <p className="text-[10px] text-gray-500 mt-2 max-w-md leading-relaxed">{hint}</p> : null}
            {action ? <div className="mt-5">{action}</div> : null}
        </div>
    );
}

/** Amber / rose / blue / emerald notice line (admin: the review modal notes, the deadline card). */
export function Notice({ tone = "amber", icon, align = "start", children, className, ...rest }: React.HTMLAttributes<HTMLDivElement> & { tone?: "amber" | "rose" | "blue" | "emerald"; icon?: string; align?: "start" | "center" }) {
    const t: Record<string, string> = {
        amber: "bg-amber-50 border-amber-200 text-amber-900",
        rose: "bg-rose-50 border-rose-200 text-rose-900",
        blue: "bg-blue-50 border-blue-200 text-blue-900",
        emerald: "bg-emerald-50 border-emerald-200 text-emerald-900",
    };
    return (
        <div className={cx("rounded-2xl border text-sm px-4 py-3 flex gap-3", align === "center" ? "items-center" : "items-start", t[tone], className)} {...rest}>
            {icon ? <i className={cx("fa-solid", icon, align === "start" && "mt-0.5", "shrink-0")}></i> : null}
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    );
}

const SHEET_NOTICE_ICON: Record<string, string> = { emerald: "fa-circle-check", rose: "fa-triangle-exclamation", amber: "fa-circle-exclamation", blue: "fa-circle-info" };
type RectLike = { top: number; bottom: number };
type RevealEl = { getBoundingClientRect(): RectLike; closest?(sel: string): unknown; scrollIntoView?(o?: unknown): void };
/**
 * Scroll the sheet body `el` is in (`data-portal-sheet-body`, the only part of a sheet that scrolls) so `el` is whole in
 * sight with `margin` px around it — up when it is above the visible part, down when below; one taller than the
 * body lines up with its top. Outside a sheet body, the browser's own scrollIntoView. Returns the scroll applied.
 */
export function revealInSheetBody(el: RevealEl | null | undefined, margin = 8): number {
    if (!el) return 0;
    const body = (typeof el.closest === "function" ? el.closest("[data-portal-sheet-body]") : null) as ({ scrollTop: number } & RevealEl) | null;
    if (!body) {
        try { if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" }); } catch { /* old browser */ }
        return 0;
    }
    const b = body.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const room = b.bottom - b.top - 2 * margin;
    let d = 0;
    if (r.top - margin < b.top || r.bottom - r.top > room) d = r.top - margin - b.top;
    else if (r.bottom + margin > b.bottom) d = r.bottom + margin - b.bottom;
    d = Math.round(d);
    if (d) body.scrollTop = Number(body.scrollTop || 0) + d;
    return d;
}
/**
 * A message said INSIDE an open sheet (the payment hub's notice: a payment sent, a delete that failed, people
 * left out of a payment) — never a toast over the sheet's footer. Announced: an error at once (alert), anything
 * else politely (status). It sits at the TOP of the sheet's body, and each new one (`n`) is brought into sight
 * (revealInSheetBody): a refusal after the coordinator scrolled down to the receipt and tapped a footer button was
 * out of sight (2.18.0 review UX6-1).
 */
export function SheetNotice({ notice }: { notice: { text: string; tone: "amber" | "rose" | "blue" | "emerald"; n: number } | null | undefined }) {
    const ref = React.useRef<HTMLDivElement>(null);
    const key = notice ? `${notice.n}:${notice.text}` : "";
    React.useEffect(() => {
        if (key) revealInSheetBody(ref.current);
    }, [key]);
    if (!notice) return null;
    return (
        <div ref={ref} data-sheet-notice-box="">
            <Notice key={notice.n} tone={notice.tone} icon={SHEET_NOTICE_ICON[notice.tone]} role={notice.tone === "rose" ? "alert" : "status"} data-sheet-notice={notice.tone}>
                <span className="font-bold break-words">{notice.text}</span>
            </Notice>
        </div>
    );
}

// ── modal ────────────────────────────────────────────────────────────────────────────────────────
type SavedStyles = { y: number; body: Record<string, string>; html: string };
let scrollLocks = 0;
let savedStyles: SavedStyles | null = null;
const BODY_LOCK_PROPS = ["position", "top", "left", "right", "width", "overflow", "overscrollBehavior"] as const;

/**
 * Pin the page behind an open dialog; returns the release function (idempotent). iOS Safari ignores
 * `overflow: hidden` on <body> — the page kept rubber-banding behind a sheet — so the body is fixed at
 * -scrollY and restored (scroll position included) when the LAST lock is released. Reference counted: a
 * confirm over a sheet over another sheet release in any order. (The plugin admin's lib/overlay.ts twin.)
 */
export function lockBodyScroll(): () => void {
    if (typeof document === "undefined" || !document.body) return () => { };
    const body = document.body.style as unknown as Record<string, string>;
    const html = document.documentElement.style as unknown as Record<string, string>;
    if (scrollLocks === 0) {
        const y = (typeof window !== "undefined" && (window.scrollY || window.pageYOffset)) || 0;
        savedStyles = { y, body: {}, html: html.overscrollBehavior || "" };
        for (const p of BODY_LOCK_PROPS) savedStyles.body[p] = body[p] || "";
        body.position = "fixed";
        body.top = `-${y}px`;
        body.left = "0";
        body.right = "0";
        body.width = "100%";
        body.overflow = "hidden";
        body.overscrollBehavior = "none";
        html.overscrollBehavior = "none";
    }
    scrollLocks++;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        scrollLocks = Math.max(0, scrollLocks - 1);
        if (scrollLocks > 0 || !savedStyles) return;
        const s = savedStyles;
        savedStyles = null;
        for (const p of BODY_LOCK_PROPS) body[p] = s.body[p];
        html.overscrollBehavior = s.html;
        try { if (typeof window !== "undefined" && s.y) window.scrollTo(0, s.y); } catch { /* not scrollable */ }
    };
}

/**
 * The open dialogs, oldest first. Escape (and the Tab trap) belong to the TOPMOST one only: a confirm
 * over a payment sheet over a participant sheet closes one layer per key press.
 */
const dialogStack: number[] = [];
const dialogPanels = new Map<number, HTMLElement>();
let dialogSeq = 0;
export const topDialog = (): number | null => (dialogStack.length ? dialogStack[dialogStack.length - 1] : null);

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Text-like inputs: Escape in one of them while it holds text belongs to the field (the admin overlay's rule). */
const TEXT_INPUTS = new Set(["", "text", "search", "email", "tel", "url", "number", "password"]);
export function isFilledField(target: unknown): boolean {
    const t = target as { tagName?: unknown; type?: unknown; value?: unknown } | null;
    if (!t || typeof t !== "object") return false;
    const tag = String(t.tagName || "").toLowerCase();
    if (tag === "textarea") return String(t.value ?? "") !== "";
    if (tag === "input") return TEXT_INPUTS.has(String(t.type ?? "").toLowerCase()) && String(t.value ?? "") !== "";
    return false;
}
let fieldEscape: { el: unknown; at: number } | null = null;
/** A second Escape in the same filled field within this long means «close the sheet». */
export const SECOND_ESCAPE_MS = 1500;
/**
 * Escape typed INSIDE a filled field is the field's (a search box clears itself; a text box keeps its text) —
 * it never closes the sheet around it: a coordinator clearing the picker's search lost a whole correction
 * (people, split, a new photo). A second Escape in the same field soon after, or one in an empty field, goes
 * to the sheet. True when the key belongs to the field. (The plugin admin's lib/overlay.ts twin.)
 */
export function fieldKeepsEscape(target: unknown, now: number): boolean {
    if (!isFilledField(target)) { fieldEscape = null; return false; }
    if (fieldEscape && fieldEscape.el === target && now - fieldEscape.at <= SECOND_ESCAPE_MS) { fieldEscape = null; return false; }
    fieldEscape = { el: target, at: now };
    return true;
}

/** Room kept under a focused field of a sheet's body (its scroll padding): the field AND the line under it. */
export const SHEET_BODY_SCROLL_PADDING = "3rem";

/** Panel classes: a bottom sheet below 640 px (full width, square bottom corners), a centred card from 640 px. */
export const MODAL_PANEL_CLS = "bg-white shadow-2xl w-full border border-gray-100 overflow-hidden flex flex-col outline-none rounded-t-[28px] sm:rounded-[40px] max-h-[92vh] supports-[height:100dvh]:max-h-[92dvh]";

/**
 * The admin's modal: dimmed blurred backdrop, rounded-[40px] white panel, gray-50 header with an × button.
 * The panel is the dialog (labelled by its title).
 *
 * On a phone (< 640 px) it is a BOTTOM SHEET: anchored to the bottom edge, full width, at most 92% of the
 * DYNAMIC viewport (iOS: `vh` is the large viewport, so a 92vh sheet started under the toolbar and its
 * buttons were unreachable), its body scrolls while the header and the footer stay put, and the footer
 * clears the home indicator (safe-area inset). From 640 px it is the centred card it always was.
 *
 * Behaviour: rendered into <body> (a portal: no transformed or clipping ancestor can trap it); the page
 * behind is pinned (lockBodyScroll); it takes the focus when it opens (the panel, never an input — that
 * would pop the phone keyboard) and gives it back to whatever had it when it closes, unless the caller
 * already moved it; Tab stays inside; Escape closes the topmost dialog only. `onClose` may change identity
 * freely (it is read through a ref; the focus is taken once, on open).
 *
 * `footerNote`: a line in the footer, ABOVE its buttons — what the primary button is waiting for, in words,
 * where the thumb is (the body may be scrolled two screens away from it).
 */
export function Modal({ title, subtitle, onClose, children, footer, footerNote, size = "md", testId }: { title: React.ReactNode; subtitle?: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; footerNote?: React.ReactNode; size?: "sm" | "md" | "lg" | "xl"; testId?: string }) {
    const width: Record<string, string> = { sm: "sm:max-w-md", md: "sm:max-w-lg", lg: "sm:max-w-2xl", xl: "sm:max-w-4xl" };
    const titleId = React.useId();
    const panel = React.useRef<HTMLDivElement>(null);
    const closeRef = React.useRef(onClose);
    React.useEffect(() => { closeRef.current = onClose; }, [onClose]);
    React.useEffect(() => {
        const id = ++dialogSeq;
        dialogStack.push(id);
        const opener = typeof document !== "undefined" ? document.activeElement : null;
        const el = panel.current;
        if (el) dialogPanels.set(id, el);
        const release = lockBodyScroll();
        el?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (topDialog() !== id) return;
            if (e.key === "Escape") {
                if (fieldKeepsEscape(e.target, Date.now())) return;
                e.stopPropagation();
                closeRef.current();
                return;
            }
            if (e.key !== "Tab" || !el) return;
            const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null || x === document.activeElement);
            if (!items.length) { e.preventDefault(); el.focus(); return; }
            const first = items[0], last = items[items.length - 1];
            const active = document.activeElement;
            if (e.shiftKey && (active === first || active === el)) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
        };
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("keydown", onKey);
            const at = dialogStack.indexOf(id);
            if (at >= 0) dialogStack.splice(at, 1);
            dialogPanels.delete(id);
            release();
            // Focus return: only when the focus was lost with the dialog (it sat inside it, or fell to
            // <body>); a caller that already focused something else on close keeps it. When the control
            // that opened it is gone (a payment sheet's «Registrar pago» disappears once the person owes
            // nothing), the dialog underneath takes the focus, so Escape and Tab still work there.
            const active = document.activeElement;
            const lost = !active || active === document.body || !active.isConnected || (el?.contains(active) ?? false);
            if (!lost) return;
            const under = topDialog();
            const target = opener instanceof HTMLElement && opener.isConnected && opener !== document.body ? opener : under != null ? dialogPanels.get(under) ?? null : null;
            try { target?.focus({ preventScroll: true }); } catch { /* not focusable any more */ }
        };
    }, []);
    const node = (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-end sm:items-center justify-center sm:p-4 overscroll-contain" data-testid={testId} data-portal-overlay="">
            <div
                ref={panel}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className={cx(MODAL_PANEL_CLS, width[size])}
                data-portal-sheet=""
            >
                <div className="bg-gray-50/50 pl-5 pr-3 sm:px-10 py-4 sm:py-8 border-b border-gray-100 flex items-start justify-between gap-3 shrink-0" data-portal-sheet-head="">
                    <div className="min-w-0 pt-1.5 sm:pt-0">
                        <h3 id={titleId} className={cx("text-xl sm:text-2xl break-words", headingCls)}>{title}</h3>
                        {subtitle ? <p className={cx(captionCls, "mt-1")}>{subtitle}</p> : null}
                    </div>
                    <button type="button" onClick={() => closeRef.current()} className="w-11 h-11 shrink-0 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors hover:bg-gray-100 rounded-2xl" aria-label="Cerrar">
                        <i className="fa-solid fa-xmark text-xl" aria-hidden="true"></i>
                    </button>
                </div>
                {/* A focused field is scrolled clear of the body's bottom edge with room for the line under it
                    («Supera lo que falta: máximo $X» was cut at the footer). */}
                <div className={cx("px-5 py-5 sm:p-10 space-y-6 overflow-y-auto overscroll-contain min-h-0 flex-1", !footer && "pb-[max(1.25rem,env(safe-area-inset-bottom))]")} style={{ scrollPaddingBottom: SHEET_BODY_SCROLL_PADDING, scrollPaddingTop: "1rem" }} data-portal-sheet-body="">{children}</div>
                {footer && footerNote ? (
                    <div className="px-5 sm:px-10 pt-3 sm:pt-4 sm:pb-5 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-gray-100 bg-white sm:bg-gray-50/30 shrink-0 space-y-3" data-portal-sheet-foot="">
                        <div data-portal-sheet-note="">{footerNote}</div>
                        <div className="flex flex-wrap justify-end gap-3 [&>*]:flex-1 sm:[&>*]:flex-none">{footer}</div>
                    </div>
                ) : footer ? (
                    <div className="px-5 sm:px-10 pt-4 sm:py-5 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-gray-100 bg-white sm:bg-gray-50/30 flex flex-wrap justify-end gap-3 shrink-0 [&>*]:flex-1 sm:[&>*]:flex-none" data-portal-sheet-foot="">{footer}</div>
                ) : null}
            </div>
        </div>
    );
    // The server renderer (and the unit tests) has no document: render in place there.
    return typeof document === "undefined" ? node : createPortal(node, document.body);
}

// ── lists: pager, ⋮, detail rows ─────────────────────────────────────────────────────────────────
/** The accessible name of the pager's size select: «Mostrar pagos por página». */
export const pagerSizeLabel = (itemsLabel = "personas"): string => `Mostrar ${itemsLabel} por página`;
/**
 * The pager under a paged list. Below 640 px: «‹ Anterior | 2 / 9 | Siguiente ›» with 44 px buttons and
 * «21–40 de 183» under it; from 640 px: «Mostrando 21–40 de 183» and a numbered window. «Mostrar 10/20/
 * 50/100» when `onSize` is given. Nothing at all when everything fits in the smallest page.
 */
export function Pager({ page, count, from, to, total, windowPages, size, sizes, onPage, onSize, label = "Paginación", itemsLabel = "personas" }: {
    page: number;
    count: number;
    from: number;
    to: number;
    total: number;
    /** The numbered window (participants.ts pageWindow). */
    windowPages: (number | "…")[];
    size: number;
    sizes?: readonly number[];
    onPage: (page: number) => void;
    onSize?: (size: number) => void;
    label?: string;
    /** What the list holds («personas», «pagos»): the size select is «Mostrar {itemsLabel} por página». */
    itemsLabel?: string;
}) {
    const smallest = sizes && sizes.length ? Math.min(...sizes) : size;
    if (total <= Math.min(size, smallest)) return null;
    const navBtn = "inline-flex items-center justify-center gap-2 min-h-11 min-w-11 px-3 rounded-xl text-xs font-bold text-gray-600 bg-white border border-gray-100 hover:border-blue-300 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors";
    return (
        <nav aria-label={label} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 py-4 border-t border-gray-50" data-portal-pager="">
            <p className="sr-only" aria-live="polite">Página {page} de {count}</p>
            {count > 1 && (
                <div className="flex items-center justify-between gap-2 sm:hidden" data-pager-phone="">
                    <button type="button" className={navBtn} onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Página anterior">
                        <i className="fa-solid fa-chevron-left text-[10px]" aria-hidden="true"></i> Anterior
                    </button>
                    <span className="text-xs font-black text-gray-700 tabular-nums">{page} / {count}</span>
                    <button type="button" className={navBtn} onClick={() => onPage(page + 1)} disabled={page >= count} aria-label="Página siguiente">
                        Siguiente <i className="fa-solid fa-chevron-right text-[10px]" aria-hidden="true"></i>
                    </button>
                </div>
            )}
            <div className="flex flex-wrap items-center justify-between sm:justify-start gap-3">
                <p className="text-[11px] font-bold text-gray-500 tabular-nums">
                    <span className="hidden sm:inline">Mostrando </span>{from}–{to} de {total}
                </p>
                {onSize && sizes && (
                    <label className="flex items-center gap-2 text-[11px] font-bold text-gray-500">
                        Mostrar
                        {/* The name starts with the visible word «Mostrar» (WCAG 2.5.3) and says what is counted. */}
                        <Select className="min-h-11 rounded-xl border-2 border-gray-100 bg-white px-2 text-base sm:text-xs font-bold text-gray-700" value={size} onChange={(e) => onSize(Number(e.target.value))} aria-label={pagerSizeLabel(itemsLabel)}>
                            {sizes.map((s) => <option key={s} value={s}>{s}</option>)}
                        </Select>
                    </label>
                )}
            </div>
            {count > 1 && (
                <ol className="hidden sm:flex items-center gap-1" data-pager-desktop="">
                    <li><button type="button" className={navBtn} onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Página anterior"><i className="fa-solid fa-chevron-left text-[10px]" aria-hidden="true"></i></button></li>
                    {windowPages.map((p, i) => p === "…" ? (
                        <li key={`gap-${i}`} className="px-1 text-xs text-gray-400" aria-hidden="true">…</li>
                    ) : (
                        <li key={p}>
                            <button type="button" className={cx(navBtn, p === page && "bg-blue-600 border-blue-600 text-white hover:text-white")} onClick={() => onPage(p)} aria-current={p === page ? "page" : undefined} aria-label={`Página ${p}`}>{p}</button>
                        </li>
                    ))}
                    <li><button type="button" className={navBtn} onClick={() => onPage(page + 1)} disabled={page >= count} aria-label="Página siguiente"><i className="fa-solid fa-chevron-right text-[10px]" aria-hidden="true"></i></button></li>
                </ol>
            )}
        </nav>
    );
}

/** The «⋮» (más información) of a row: 44×44, a visible glyph, named after the person. */
export function MoreButton({ name, onClick, expanded, id }: { name: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; expanded?: boolean; id?: number | string }) {
    return (
        <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClick(e); }}
            aria-label={`Más información de ${name}`}
            aria-haspopup="dialog"
            aria-expanded={!!expanded}
            data-portal-more={id === undefined ? "" : String(id)}
            className="w-11 h-11 shrink-0 flex items-center justify-center rounded-xl text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-400 outline-none transition-colors"
        >
            <i className="fa-solid fa-ellipsis-vertical text-base" aria-hidden="true"></i>
        </button>
    );
}

/** A section heading inside a sheet: the label look WITHOUT `ml-1`, flush with the InfoRow labels around it. */
export const sectionLabelCls = "block text-[10px] font-black text-gray-500 uppercase tracking-widest";

/** One «label: value» line of a detail sheet (a <div> of a <dl>). Empty values read «—». */
export function InfoRow({ label, children, mono }: { label: React.ReactNode; children?: React.ReactNode; mono?: boolean }) {
    const empty = children === null || children === undefined || children === "" || children === false;
    return (
        <div className="py-2.5 grid grid-cols-1 sm:grid-cols-[minmax(0,12rem)_1fr] gap-x-4 gap-y-0.5 border-b border-gray-50 last:border-b-0">
            <dt className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{label}</dt>
            <dd className={cx("text-sm text-gray-900 break-words min-w-0", mono && "font-mono", empty && "text-gray-400")}>{empty ? "—" : children}</dd>
        </div>
    );
}

// ── money: tiles, segments, inputs ───────────────────────────────────────────────────────────────
export type KpiTone = "blue" | "emerald" | "amber" | "rose" | "orange" | "gray";
const kpiTone: Record<KpiTone, string> = {
    blue: "text-blue-700",
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    rose: "text-rose-700",
    orange: "text-orange-700",
    gray: "text-gray-700",
};

/**
 * An amount in a tile is NEVER broken («$7.500.000,0» / «0» in a 114 px phone tile): one line, and its size
 * follows the tile — the tile is a size container and the figure gets 100cqi / (its characters × 0.62 em), at
 * most 1.125rem. A browser without container units keeps a size chosen by the length alone (the admin's
 * FeeBits kpiValueFit, the same rule).
 */
export function kpiValueFit(text: string, maxRem = 1.125): { className: string; style: React.CSSProperties } {
    const n = Math.max(1, String(text || "").length);
    const fallback = n <= 10 ? "text-lg" : n <= 12 ? "text-base" : n <= 14 ? "text-sm" : "text-xs";
    return { className: cx("whitespace-nowrap", fallback), style: { fontSize: `min(${maxRem}rem, calc(100cqi / ${(n * 0.62).toFixed(2)}))` } };
}

/** A compact figure (64–72 px): a 10 px caption over the amount. Tappable when `onClick` is given. */
export function KpiTile({ label, value, tone = "gray", icon, onClick, hint, testId }: { label: string; value: React.ReactNode; tone?: KpiTone; icon?: string; onClick?: () => void; hint?: string; testId?: string }) {
    const fit = kpiValueFit(typeof value === "string" ? value : "");
    const inner = (
        <>
            <span className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-gray-500">
                {icon ? <i className={cx("fa-solid", icon, kpiTone[tone])} aria-hidden="true"></i> : null}
                {label}
            </span>
            <span className={cx("block font-black tabular-nums leading-tight", fit.className, kpiTone[tone])} style={fit.style} data-kpi-value="">{value}</span>
            {hint ? <span className="block text-[10px] font-medium text-gray-500">{hint}</span> : null}
        </>
    );
    const cls = "min-h-16 w-full min-w-0 rounded-2xl border border-gray-100 bg-white px-4 py-3 text-left shadow-sm";
    // A tile that is a <button> («Por validar») stacks from the TOP like its <div> siblings: a button centres its
    // content, and in a row stretched by a taller tile its label and figure sat ~8 px lower (2.18.0 skeptic round 4).
    const box: React.CSSProperties = KPI_TILE_BOX;
    return onClick ? (
        <button type="button" onClick={onClick} className={cx(cls, "hover:border-blue-200 transition-colors")} style={box} data-testid={testId}>{inner}</button>
    ) : (
        <div className={cls} style={box} data-testid={testId}>{inner}</div>
    );
}

/** The box of every KPI tile, button or not: a column stacked from the top. */
export const KPI_TILE_BOX: React.CSSProperties = Object.freeze({ containerType: "inline-size", display: "flex", flexDirection: "column", justifyContent: "flex-start", alignItems: "stretch" }) as React.CSSProperties;

/**
 * The keyboard of a radio strip (WAI-ARIA APG radio group): the value an arrow, Home or End moves the choice to —
 * ArrowRight / ArrowDown the next, ArrowLeft / ArrowUp the previous (wrapping), Home the first, End the last —
 * skipping disabled options; null for any other key.
 */
export function segmentKeyTarget<T extends string>(values: readonly T[], current: T, key: string, disabled: (v: T) => boolean = () => false): T | null {
    const live = values.filter((v) => !disabled(v));
    if (!live.length) return null;
    const i = live.indexOf(current);
    switch (key) {
        case "ArrowRight": case "ArrowDown": return live[(i + 1 + live.length) % live.length];
        case "ArrowLeft": case "ArrowUp": return live[(i - 1 + live.length) % live.length];
        case "Home": return live[0];
        case "End": return live[live.length - 1];
        default: return null;
    }
}

/**
 * Two or more mutually exclusive choices (a radio group drawn as one pill strip), 44 px tall. ONE Tab stop (the
 * chosen option) and the arrow keys inside, as the radio role promises: a screen reader says «radio button, 1 of
 * 2» and its user presses an arrow (2.18.0 review PUX-7).
 */
export function SegmentedControl<T extends string>({ value, options, onChange, label, className, testId }: {
    value: T;
    options: readonly { value: T; label: React.ReactNode; badge?: React.ReactNode; disabled?: boolean }[];
    onChange: (v: T) => void;
    label: string;
    className?: string;
    testId?: string;
}) {
    return (
        <div role="radiogroup" aria-label={label} className={cx("flex w-full sm:w-auto sm:inline-flex rounded-2xl bg-gray-100 p-1 gap-1", className)} data-testid={testId}>
            {options.map((o) => {
                const on = o.value === value;
                const values = options.map((x) => x.value);
                const isOff = (v: T) => !!options.find((x) => x.value === v)?.disabled;
                const stop = values.includes(value) && !isOff(value) ? value : values.find((v) => !isOff(v));
                return (
                    <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        disabled={o.disabled}
                        tabIndex={o.value === stop ? 0 : -1}
                        data-seg={o.value}
                        onKeyDown={(e) => {
                            const next = segmentKeyTarget(values, o.value, e.key, isOff);
                            if (next == null) return;
                            e.preventDefault();
                            if (next !== o.value) onChange(next);
                            const strip = e.currentTarget.parentElement;
                            const btn = strip ? Array.from(strip.querySelectorAll<HTMLElement>("[data-seg]")).find((b) => b.getAttribute("data-seg") === next) : null;
                            btn?.focus();
                        }}
                        onClick={() => onChange(o.value)}
                        className={cx(
                            "flex-1 sm:flex-none inline-flex items-center justify-center gap-2 min-h-11 px-4 rounded-xl text-xs font-black transition-colors disabled:opacity-40",
                            on ? "bg-white text-blue-700 shadow-sm" : "text-gray-600 hover:text-gray-900",
                        )}
                    >
                        {o.label}
                        {o.badge != null ? o.badge : null}
                    </button>
                );
            })}
        </div>
    );
}

/**
 * The split column of «Registrar pago» (Manual): wide enough for a six-digit peso part as the sheet writes it
 * on blur («250.000,00», ~87 px of 16 px black digits) in a COMPACT MoneyInput (pl-7 pr-2: 112 px of text).
 * At 8.5rem with the default padding (pl-9 px-4) the field had 80 px: every «250.000,00» was cut.
 */
export const SPLIT_COLUMN_REM = 9.5;
/** The text width (px) a compact MoneyInput leaves in a column `rem` wide (pl-7 + pr-2 + the 2 px borders). */
export const compactMoneyTextPx = (rem: number): number => rem * 16 - 28 - 8 - 4;

/**
 * A money field: «$» prefix, decimal keypad on phones (`inputMode="decimal"`), free text so «1.250,50»
 * and «1250.50» both work (feeSplit.parseMoneyInput reads it), 16 px on phones. `compact`: the split
 * column's geometry (the admin's: «$» at 12 px, the amount right-aligned, pl-7 pr-2).
 */
export function MoneyInput({ value, onChange, id, label, invalid, large, compact, disabled, testId, describedBy }: {
    value: string;
    onChange: (v: string) => void;
    id?: string;
    label?: string;
    invalid?: boolean;
    large?: boolean;
    compact?: boolean;
    disabled?: boolean;
    testId?: string;
    describedBy?: string;
}) {
    return (
        <div className="relative min-w-0">
            <span className={cx("absolute top-1/2 -translate-y-1/2 font-bold text-gray-400 pointer-events-none", compact ? "left-3" : "left-4", large ? "text-lg" : "text-sm")} aria-hidden="true">$</span>
            <input
                id={id}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                enterKeyHint="done"
                aria-label={label}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                disabled={disabled}
                className={cx(compact ? compactMoneyCls : cx(inputShapeCls, "pl-9"), "font-black tabular-nums focus:border-blue-500", large ? "py-3 text-xl" : cx("py-2.5", touchTextCls), invalid && "border-rose-300 bg-rose-50/40")}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                // On leaving it, an amount reads the way the sheet writes amounts («250» → «250,00»).
                onBlur={() => { const tidy = tidyMoneyInput(value); if (tidy !== value) onChange(tidy); }}
                placeholder="0,00"
                data-testid={testId}
            />
        </div>
    );
}

/** The compact MoneyInput's shape: inputShapeCls with the admin split field's padding (no px-4: Tailwind v4 would order it). */
const compactMoneyCls = "w-full border-2 border-gray-100 rounded-xl pl-7 pr-2 text-right bg-gray-50/30 focus:bg-white transition-all outline-none text-gray-900 placeholder:text-gray-300 disabled:opacity-60 disabled:cursor-not-allowed";

// ── table ────────────────────────────────────────────────────────────────────────────────────────
/** Column header cell, as in the admin roster table. */
/** gray-500 on the light header: AA (gray-400 was ~2.5:1 at 10 px). */
export const thCls = "px-6 py-5 text-[10px] font-black text-gray-500 uppercase tracking-widest whitespace-nowrap";
/**
 * A header that may WRAP between its words (a form column «CORREO ELECTRÓNICO»): its own string, never
 * `cx(thCls, "whitespace-normal")` — Tailwind v4 emits `.whitespace-nowrap` after `.whitespace-normal`, so
 * nowrap won and a long label ran over the next header. Never mid-word (no break-words).
 */
export const thWrapCls = "px-3 py-5 text-[10px] font-black text-gray-500 uppercase tracking-widest whitespace-normal";
export const tdCls = "px-6 py-5";
export const trCls = "hover:bg-blue-50/30 transition-colors group/row";
/** Row actions fade in on hover (always visible on touch screens), as in the admin roster. */
export const rowActionsCls = "flex justify-end gap-2 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity";
