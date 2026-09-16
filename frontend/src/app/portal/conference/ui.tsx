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
 */
import React from "react";

export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(" ");

// ── text ─────────────────────────────────────────────────────────────────────────────────────────
/** 10px black uppercase label, as above every admin form field / table column. */
export const labelCls = "block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1";
/** Heading shape without a colour (so a caller can grey a disabled name): black, italic, tight tracking. */
export const headingShapeCls = "font-black italic tracking-tighter";
/** Page / card heading: black, italic, tight tracking (admin: location names, conference name). */
export const headingCls = cx(headingShapeCls, "text-gray-900");
/** Caption without its tracking; `captionCls` adds the admin's default `tracking-widest`. */
export const captionBaseCls = "text-[10px] text-gray-400 font-bold uppercase";
/** Tiny uppercase caption under a heading (admin: "Sedes regionales y grupos locales"). */
export const captionCls = cx(captionBaseCls, "tracking-widest");
/** The wider 0.2em caption the admin uses under card titles and the dashboard hero. */
export const captionWideCls = cx(captionBaseCls, "tracking-[0.2em]");

// ── inputs ───────────────────────────────────────────────────────────────────────────────────────
/** Input shape without size / weight / focus colour — compose it when a variant is needed. */
const inputShapeCls = "w-full border-2 border-gray-100 rounded-xl px-4 bg-gray-50/30 focus:bg-white transition-all outline-none text-gray-900 placeholder:text-gray-300 disabled:opacity-60 disabled:cursor-not-allowed";
/** The admin's form input (rule / inscription modals): text-sm, medium weight, blue focus. */
export const inputCls = cx(inputShapeCls, "py-3 text-sm font-medium focus:border-blue-500");
export const selectCls = inputCls;
/** Same input in the admin's indigo assignment surface (rule modal). */
export const inputIndigoCls = cx(inputShapeCls, "py-3 text-sm font-medium focus:border-indigo-500");
/** Dense input next to a small button (admin allot bar: `px-3 py-2 text-xs`). */
export const inputDenseCls = cx(inputShapeCls, "py-2 text-xs font-medium focus:border-blue-500");
/** Bold input for amounts / access codes (admin hotel & conference modals use `font-bold`). */
export const inputBoldCls = cx(inputShapeCls, "py-3 text-sm font-bold focus:border-blue-500");
export const checkboxCls = "w-4 h-4 rounded border-2 border-gray-200 text-blue-600 accent-blue-600 cursor-pointer";

export function Label({ children, className, htmlFor }: { children: React.ReactNode; className?: string; htmlFor?: string }) {
    return <label htmlFor={htmlFor} className={cx(labelCls, className)}>{children}</label>;
}

/**
 * Label + control + optional help line, the admin's `space-y-1.5` field block. Pass the control as a
 * render function to receive the id the label points at: `<Field label="Nombre">{(id) => <input id={id} … />}</Field>`.
 */
export function Field({ label, help, children, className, htmlFor }: { label: React.ReactNode; help?: React.ReactNode; children: React.ReactNode | ((id: string) => React.ReactNode); className?: string; htmlFor?: string }) {
    const auto = React.useId();
    const id = htmlFor ?? auto;
    return (
        <div className={cx("space-y-1.5", className)}>
            <Label htmlFor={typeof children === "function" || htmlFor ? id : undefined}>{label}</Label>
            {typeof children === "function" ? children(id) : children}
            {help ? <p className="text-[11px] text-gray-500 ml-1 leading-relaxed">{help}</p> : null}
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

/** The admin's pill-shaped action button: black 10px uppercase text, wide tracking, scale on press. */
export function Button({ variant = "primary", size = "md", icon, block, className, children, type = "button", ...rest }: ButtonProps) {
    return (
        <button
            type={type}
            className={cx(
                "inline-flex items-center justify-center gap-2 font-black uppercase tracking-widest transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100",
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

/** The admin's square icon button: 9×9 gray-50 fill-on-hover (roster) or 10×10 white soft-tint (rules). */
export function IconButton({ icon, tone = "blue", variant = "fill", className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; tone?: IconButtonTone; variant?: IconButtonVariant }) {
    return (
        <button
            type="button"
            className={cx(
                "flex items-center justify-center rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed",
                variant === "fill"
                    ? cx("w-9 h-9 bg-gray-50 text-gray-400 hover:text-white shadow-sm border border-transparent", iconToneFill[tone])
                    : cx("w-10 h-10 bg-white border border-gray-100 text-gray-400", iconToneSoft[tone]),
                className,
            )}
            {...rest}
        >
            <i className={cx("fa-solid", icon, variant === "fill" ? "text-xs" : "text-sm")}></i>
        </button>
    );
}

// ── badges ───────────────────────────────────────────────────────────────────────────────────────
export type BadgeTone = "blue" | "emerald" | "amber" | "rose" | "gray" | "indigo";
export type BadgeSize = "xs" | "sm";
const badgeTone: Record<BadgeTone, string> = {
    blue: "bg-blue-50 text-blue-700 border-blue-100",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    rose: "bg-rose-50 text-rose-700 border-rose-200",
    gray: "bg-gray-100 text-gray-500 border-gray-100",
    indigo: "bg-indigo-50 text-indigo-700 border-indigo-100",
};
const badgeSize: Record<BadgeSize, string> = {
    /** The admin rule-row pills (`px-2 py-0.5 text-[8px]`). */
    xs: "px-2 py-0.5 text-[8px]",
    sm: "px-3 py-1 text-[10px]",
};

/** Rounded-full 10px uppercase status pill (admin: payment status, conference status, lodging status). */
export function Badge({ tone = "gray", size = "sm", icon, children, className, ...rest }: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; size?: BadgeSize; icon?: string }) {
    return (
        <span className={cx("inline-flex items-center gap-1.5 rounded-full font-black uppercase tracking-widest border", badgeTone[tone], badgeSize[size], className)} {...rest}>
            {icon ? <i className={cx("fa-solid", icon, size === "xs" ? "text-[8px]" : "text-[9px]")}></i> : null}
            {children}
        </span>
    );
}

// ── cards ────────────────────────────────────────────────────────────────────────────────────────
/** The admin's list card: white, rounded-3xl, hairline border, soft shadow. */
export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={cx("bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-100/30 overflow-hidden", className)} {...rest}>{children}</div>;
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
            <div className={cx("absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 rounded-full blur-3xl pointer-events-none", blob[tone][0])}></div>
            <div className={cx("absolute bottom-0 left-0 -ml-16 -mb-16 w-48 h-48 rounded-full blur-3xl pointer-events-none", blob[tone][1])}></div>
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
            {label ? <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{label}</p> : null}
        </div>
    );
}

/** The admin's dashed empty box: 20×20 white tile with a faint icon, 10px uppercase title. `padding` = "sm" where space is tight (inside a table cell). */
export function EmptyState({ icon, title, hint, action, className, padding = "lg" }: { icon: string; title: React.ReactNode; hint?: React.ReactNode; action?: React.ReactNode; className?: string; padding?: "sm" | "lg" }) {
    return (
        <div className={cx("flex flex-col justify-center items-center px-6 bg-gray-50/50 border-2 border-dashed border-gray-100 rounded-3xl text-center", padding === "lg" ? "py-20" : "py-16", className)}>
            <div className="w-20 h-20 bg-white rounded-3xl flex items-center justify-center text-gray-200 text-3xl shadow-sm mb-4">
                <i className={cx("fa-solid", icon)}></i>
            </div>
            <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{title}</p>
            {hint ? <p className="text-[10px] text-gray-400 mt-2 max-w-md leading-relaxed">{hint}</p> : null}
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

// ── modal ────────────────────────────────────────────────────────────────────────────────────────
/**
 * The admin's modal: dimmed blurred backdrop, rounded-[40px] white panel, gray-50 header with an × button.
 * The panel is the dialog (labelled by its title), takes focus when it opens, and Escape closes it.
 */
export function Modal({ title, subtitle, onClose, children, footer, size = "md", testId }: { title: React.ReactNode; subtitle?: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; size?: "sm" | "md" | "lg" | "xl"; testId?: string }) {
    const width: Record<string, string> = { sm: "max-w-md", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };
    const titleId = React.useId();
    const panel = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        panel.current?.focus();
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);
    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-200" data-testid={testId}>
            <div
                ref={panel}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className={cx("bg-white rounded-[32px] sm:rounded-[40px] shadow-2xl w-full border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200 max-h-[92vh] flex flex-col outline-none", width[size])}
            >
                <div className="bg-gray-50/50 px-6 sm:px-10 py-6 sm:py-8 border-b border-gray-100 flex items-start justify-between gap-4 shrink-0">
                    <div className="min-w-0">
                        <h3 id={titleId} className={cx("text-2xl", headingCls)}>{title}</h3>
                        {subtitle ? <p className={cx(captionCls, "mt-1")}>{subtitle}</p> : null}
                    </div>
                    <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-2xl shrink-0" aria-label="Cerrar">
                        <i className="fa-solid fa-xmark text-xl"></i>
                    </button>
                </div>
                <div className="p-6 sm:p-10 space-y-6 overflow-y-auto">{children}</div>
                {footer ? <div className="px-6 sm:px-10 py-5 border-t border-gray-50 bg-gray-50/30 flex flex-wrap justify-end gap-3 shrink-0">{footer}</div> : null}
            </div>
        </div>
    );
}

// ── table ────────────────────────────────────────────────────────────────────────────────────────
/** Column header cell, as in the admin roster table. */
export const thCls = "px-6 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest whitespace-nowrap";
export const tdCls = "px-6 py-5";
export const trCls = "hover:bg-blue-50/30 transition-colors group/row";
/** Row actions fade in on hover (always visible on touch screens), as in the admin roster. */
export const rowActionsCls = "flex justify-end gap-2 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity";
