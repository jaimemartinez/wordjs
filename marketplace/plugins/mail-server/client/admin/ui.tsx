// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend tsc.
"use client";

// Shared building blocks for the webmail and the server console: buttons, form controls, sheets,
// menus, avatars, formatting helpers and the sandboxed message frame. Everything is plain Tailwind so
// the plugin stylesheet build (backend/scripts/plugin-stylesheet.js) compiles exactly what is used.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const cx = (...a: any[]) => a.filter(Boolean).join(' ');

// --- formatting ----------------------------------------------------------------------------------

export const formatBytes = (bytes: any) => {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    const trim = (x: number, d: number) => x.toFixed(d).replace(/\.0+$/, '');
    if (n < 1024 * 1024 * 1024) return `${trim(n / (1024 * 1024), n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
    return `${trim(n / (1024 * 1024 * 1024), 1)} GB`;
};

/** SQL datetimes come back as 'YYYY-MM-DD HH:MM:SS' in UTC (SQLite CURRENT_TIMESTAMP): parse them as UTC. */
export function parseDate(v: any): Date | null {
    if (!v) return null;
    if (v instanceof Date) return v;
    let s = String(v);
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** Gmail-style list date: time today, "12 mar" this year, "12/03/24" before. */
export function listDate(v: any, locale: string) {
    const d = parseDate(v);
    if (!d) return '';
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
    return d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function fullDate(v: any, locale: string) {
    const d = parseDate(v);
    return d ? d.toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

export function relativeTime(v: any, locale: string) {
    const d = parseDate(v);
    if (!d) return '';
    const diff = (d.getTime() - Date.now()) / 1000;
    const abs = Math.abs(diff);
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    if (abs < 60) return rtf.format(Math.round(diff), 'second');
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    return rtf.format(Math.round(diff / 86400), 'day');
}

export const escapeHtml = (s: unknown): string =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** First address of a "Name <a@b>, c@d" list, display name preferred. */
export function shortPeople(list: string, me?: string, meLabel = 'me') {
    const parts = String(list || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
    return parts.map(p => {
        const m = /^(.*)<([^>]+)>$/.exec(p);
        const addr = (m ? m[2] : p).trim().toLowerCase();
        if (me && addr === me.toLowerCase()) return meLabel;
        const name = m && m[1].trim().replace(/^"|"$/g, '');
        return name || addr.split('@')[0];
    }).join(', ');
}

// --- avatar --------------------------------------------------------------------------------------

const AVATAR_COLORS = ['#7c3aed', '#2563eb', '#0891b2', '#059669', '#65a30d', '#d97706', '#dc2626', '#db2777', '#4f46e5', '#0d9488'];
export function Avatar({ name, email, size = 36, className = '' }: any) {
    const label = String(name || email || '?').trim();
    const base = /^[^\s@]+@[^\s@]+$/.test(label) ? label.split('@')[0] : label;
    const initials = base.split(/[\s._-]+/).filter(w => /[\p{L}]/u.test(w)).slice(0, 2).map(w => (w.match(/\p{L}/u) || ['?'])[0]).join('').toUpperCase()
        || base.charAt(0).toUpperCase() || '?';
    let h = 0;
    for (const ch of String(email || name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const bg = AVATAR_COLORS[h % AVATAR_COLORS.length];
    return (
        <span
            aria-hidden="true"
            className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none', className)}
            style={{ width: size, height: size, background: bg, fontSize: Math.max(11, Math.round(size * 0.38)) }}
        >
            {initials}
        </span>
    );
}

// --- horizontal scroll rows ----------------------------------------------------------------------

/**
 * A row (tab bar, toolbar) that may be wider than its box. The native scrollbar stays hidden, so it
 * shows what it hides instead: a fade plus an arrow button on each side that has more, a vertical mouse
 * wheel scrolls it sideways (a mouse has no other way to), and the element marked aria-selected /
 * aria-current is brought into view whenever `activeKey` changes. When the row fits (or is laid out as
 * a column at wider sizes) none of this shows.
 */
export function ScrollRow({ as: Tag = 'div', className = '', wrapClassName = '', activeKey, children, ...rest }: any) {
    const ref = useRef<HTMLElement>(null);
    const [edge, setEdge] = useState({ l: false, r: false });
    const update = () => {
        const el = ref.current;
        if (!el) return;
        const l = el.scrollLeft > 2;
        const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
        setEdge(p => (p.l === l && p.r === r ? p : { l, r }));
    };
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        update();
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
        ro?.observe(el);
        const onWheel = (e: WheelEvent) => {
            if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
            const atEnd = e.deltaY > 0 ? el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 : el.scrollLeft <= 0;
            if (atEnd) return; // let the page scroll on
            el.scrollLeft += e.deltaY;
            e.preventDefault();
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => { ro?.disconnect(); el.removeEventListener('wheel', onWheel); };
    }, []);
    useEffect(() => {
        const el = ref.current;
        const active = el?.querySelector('[aria-selected="true"], [aria-current="page"]') as HTMLElement | null;
        if (el && active && el.scrollWidth > el.clientWidth) {
            const left = active.offsetLeft - el.offsetLeft;
            if (left < el.scrollLeft || left + active.offsetWidth > el.scrollLeft + el.clientWidth) {
                el.scrollTo({ left: Math.max(0, left - 24), behavior: 'smooth' });
            }
        }
        update();
    }, [activeKey]);
    const by = (dir: number) => ref.current?.scrollBy({ left: dir * Math.max(120, (ref.current?.clientWidth || 0) * 0.7), behavior: 'smooth' });
    // The arrows are pointer conveniences: every item stays reachable with Tab, so they stay out of it.
    const arrow = (side: 'l' | 'r') => (
        <button type="button" tabIndex={-1} aria-hidden="true" onClick={() => by(side === 'l' ? -1 : 1)}
            className={cx('absolute inset-y-0 z-10 flex w-9 items-center text-slate-500 hover:text-violet-700',
                side === 'l' ? 'left-0 justify-start bg-gradient-to-r from-white via-white/90 to-transparent pl-1' : 'right-0 justify-end bg-gradient-to-l from-white via-white/90 to-transparent pr-1')}>
            <span className="flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white shadow-sm">
                <i className={cx('fa-solid text-[10px]', side === 'l' ? 'fa-chevron-left' : 'fa-chevron-right')}></i>
            </span>
        </button>
    );
    return (
        <div className={cx('relative min-w-0', wrapClassName)}>
            {edge.l && arrow('l')}
            <Tag ref={ref} onScroll={update} className={cx('overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)} {...rest}>
                {children}
            </Tag>
            {edge.r && arrow('r')}
        </div>
    );
}

// --- buttons -------------------------------------------------------------------------------------

export function IconBtn({ icon, label, onClick, active, danger, disabled, size = 'md', className = '', badge, type = 'button', ...rest }: any) {
    const dim = size === 'sm' ? 'h-8 w-8 text-[13px]' : size === 'lg' ? 'h-11 w-11 text-base' : 'h-9 w-9 text-sm';
    return (
        <button
            type={type}
            onClick={onClick}
            disabled={disabled}
            title={label}
            aria-label={label}
            className={cx(
                // A caller hiding it at some sizes ('hidden sm:inline-flex') owns the display value.
                /(^|\s)hidden(\s|$)/.test(className) ? '' : 'inline-flex',
                'relative shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50 disabled:cursor-not-allowed disabled:opacity-40',
                dim,
                active ? 'bg-violet-100 text-violet-700' : danger ? 'text-slate-500 hover:bg-red-50 hover:text-red-600' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
                className
            )}
            {...rest}
        >
            <i className={icon}></i>
            {badge ? <span className="absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-violet-600 px-1 text-[10px] font-bold leading-4 text-white">{badge}</span> : null}
        </button>
    );
}

export function Button({ children, icon, variant = 'secondary', loading, disabled, onClick, type = 'button', className = '', size = 'md', ...rest }: any) {
    const base = 'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap';
    const sz = size === 'sm' ? 'h-8 px-3 text-xs' : size === 'lg' ? 'h-12 px-6 text-sm' : 'h-10 px-4 text-sm';
    const v = {
        primary: 'bg-violet-600 text-white shadow-sm shadow-violet-600/20 hover:bg-violet-700 active:bg-violet-800',
        dark: 'bg-slate-900 text-white hover:bg-black',
        secondary: 'border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50',
        ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
        danger: 'bg-red-600 text-white hover:bg-red-700',
        dangerGhost: 'text-red-600 hover:bg-red-50',
    }[variant];
    return (
        <button type={type} onClick={onClick} disabled={disabled || loading} className={cx(base, sz, v, className)} {...rest}>
            {loading ? <i className="fa-solid fa-circle-notch fa-spin"></i> : icon ? <i className={icon}></i> : null}
            {children}
        </button>
    );
}

// --- form controls -------------------------------------------------------------------------------

export const inputCls = 'w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 outline-none transition focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 disabled:bg-slate-50 disabled:text-slate-400';

export function Field({ label, hint, children, className = '', htmlFor }: any) {
    return (
        <div className={className}>
            {label && <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-semibold text-slate-700">{label}</label>}
            {children}
            {hint && <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{hint}</p>}
        </div>
    );
}

export function Toggle({ checked, onChange, label, hint, disabled, className = '' }: any) {
    return (
        <label className={cx('flex cursor-pointer items-start justify-between gap-4', disabled && 'cursor-not-allowed opacity-60', className)}>
            <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-800">{label}</span>
                {hint && <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">{hint}</span>}
            </span>
            <button
                type="button"
                role="switch"
                aria-checked={!!checked}
                disabled={disabled}
                onClick={() => onChange(!checked)}
                className={cx('relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50', checked ? 'bg-violet-600' : 'bg-slate-300')}
            >
                <span className={cx('absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', checked && 'translate-x-5')}></span>
            </button>
        </label>
    );
}

export function Checkbox({ checked, onChange, label, className = '' }: any) {
    return (
        <label className={cx('flex cursor-pointer items-center gap-2.5 text-sm text-slate-700', className)}>
            <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-slate-300 accent-violet-600" />
            <span>{label}</span>
        </label>
    );
}

export function Card({ title, icon, action, children, className = '', bodyClass = 'p-4 sm:p-6' }: any) {
    return (
        <section className={cx('overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm', className)}>
            {(title || action) && (
                <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3.5 sm:px-6">
                    <h3 className="flex min-w-0 items-center gap-2 text-sm font-bold text-slate-800">
                        {icon && <i className={cx(icon, 'text-violet-500')}></i>}
                        <span className="truncate">{title}</span>
                    </h3>
                    {action}
                </header>
            )}
            <div className={bodyClass}>{children}</div>
        </section>
    );
}

export function Spinner({ className = '' }: any) {
    return <i className={cx('fa-solid fa-circle-notch fa-spin text-violet-500', className)}></i>;
}

export function EmptyState({ icon, title, hint, action, className = '' }: any) {
    return (
        <div className={cx('flex flex-col items-center justify-center px-6 py-16 text-center', className)}>
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-2xl text-slate-400">
                <i className={icon}></i>
            </div>
            <p className="text-sm font-semibold text-slate-700">{title}</p>
            {hint && <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-500">{hint}</p>}
            {action && <div className="mt-4">{action}</div>}
        </div>
    );
}

export function Pill({ children, tone = 'slate', className = '', title }: any) {
    const tones = {
        slate: 'bg-slate-100 text-slate-600 border-slate-200',
        violet: 'bg-violet-50 text-violet-700 border-violet-200',
        green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        amber: 'bg-amber-50 text-amber-700 border-amber-200',
        red: 'bg-red-50 text-red-700 border-red-200',
        orange: 'bg-orange-50 text-orange-700 border-orange-200',
        blue: 'bg-sky-50 text-sky-700 border-sky-200',
    };
    return <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold', tones[tone], className)}>{children}</span>;
}

// --- overlays ------------------------------------------------------------------------------------

/** Escape closes; the background page does not scroll while open. */
function useOverlay(open: boolean, onClose: () => void) {
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [open, onClose]);
}

/**
 * A dialog that is a centered card on desktop and a bottom sheet on phones.
 * `wide` gives the settings-style two-column layout room.
 */
export function Sheet({ open, onClose, title, children, footer, wide = false, bodyClass = 'p-4 sm:p-6' }: any) {
    useOverlay(open, onClose);
    if (!open) return null;
    return (
        <div className="fixed inset-0 flex items-end justify-center sm:items-center sm:p-4" style={{ zIndex: 6500 }} role="dialog" aria-modal="true" aria-label={title}>
            <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-[2px]" onClick={onClose}></div>
            <div className={cx('relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
                <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-slate-200 sm:hidden"></div>
                <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-6 sm:py-4">
                    <h2 className="truncate text-base font-bold text-slate-900">{title}</h2>
                    <IconBtn icon="fa-solid fa-xmark" label="Close" onClick={onClose} />
                </header>
                <div className={cx('min-h-0 flex-1 overflow-y-auto overscroll-contain', bodyClass)}>{children}</div>
                {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/70 px-4 py-3 sm:px-6" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>{footer}</footer>}
            </div>
        </div>
    );
}

/** A small dropdown anchored to its trigger; closes on outside click / Escape / selection. */
/**
 * Dropdown menu. The panel is portalled to <body> with FIXED coordinates taken from the trigger, and
 * opens UPWARDS when there is more room above: rendered inline it was clipped by any `overflow-hidden`
 * ancestor (the split Send button, the mailbox table) and fell off the bottom of the screen when the
 * trigger sat at the bottom of the composer — the schedule-send and quota menus could not be used.
 */
export function Menu({ trigger, children, align = 'right', width = 'w-56', className = '' }: any) {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<any>(null);
    const ref = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const place = () => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight, vw = window.innerWidth;
        const below = vh - r.bottom - 8, above = r.top - 8;
        const up = below < 240 && above > below;
        const next: any = { maxHeight: Math.max(120, Math.min(vh * 0.6, up ? above : below)) };
        if (up) next.bottom = vh - r.top + 6; else next.top = r.bottom + 6;
        if (align === 'right') next.right = Math.max(8, vw - r.right); else next.left = Math.max(8, r.left);
        setPos(next);
    };
    useLayoutEffect(() => { if (open) place(); }, [open]);
    useEffect(() => {
        if (!open) return;
        const inside = (t: any) => (ref.current && ref.current.contains(t)) || (panelRef.current && panelRef.current.contains(t));
        const onDoc = (e: any) => { if (!inside(e.target)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        const onMove = () => place();
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('touchstart', onDoc);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', onMove);
        window.addEventListener('scroll', onMove, true);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('touchstart', onDoc);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', onMove);
            window.removeEventListener('scroll', onMove, true);
        };
    }, [open]);
    return (
        <div ref={ref} className={cx('relative', className)}>
            {trigger({ open, toggle: () => setOpen(v => !v) })}
            {open && pos && typeof document !== 'undefined' && createPortal(
                <div
                    ref={panelRef}
                    className={cx('fixed overflow-y-auto rounded-xl border border-slate-200 bg-white py-1.5 shadow-xl shadow-slate-900/10', width)}
                    style={{ zIndex: 1000, ...pos }}
                    onClick={(e) => { if ((e.target as HTMLElement).closest('[data-menu-close]')) setOpen(false); }}
                >
                    {typeof children === 'function' ? children({ close: () => setOpen(false) }) : children}
                </div>,
                document.body
            )}
        </div>
    );
}

export function MenuItem({ icon, children, onClick, danger, checked, hint }: any) {
    return (
        <button
            type="button"
            data-menu-close
            onClick={onClick}
            className={cx('flex w-full items-center gap-3 px-3.5 py-2 text-left text-sm transition-colors', danger ? 'text-red-600 hover:bg-red-50' : 'text-slate-700 hover:bg-slate-50')}
        >
            {checked !== undefined
                ? <i className={cx(checked ? 'fa-solid fa-square-check text-violet-600' : 'fa-regular fa-square text-slate-300', 'w-4 text-center')}></i>
                : icon ? <i className={cx(icon, 'w-4 text-center text-slate-400')}></i> : null}
            <span className="min-w-0 flex-1 truncate">{children}</span>
            {hint && <kbd className="text-[11px] text-slate-400">{hint}</kbd>}
        </button>
    );
}

// --- toasts --------------------------------------------------------------------------------------

/** Toast stack: { id, type, text, action?: { label, onClick }, ttl } */
export function useToasts() {
    const [toasts, setToasts] = useState<any[]>([]);
    const push = (type: string, text: string, opts: any = {}) => {
        const id = Math.random().toString(36).slice(2);
        setToasts(list => [...list.slice(-2), { id, type, text, ...opts }]);
        const ttl = opts.ttl ?? (opts.action ? 8000 : 4000);
        if (ttl > 0) setTimeout(() => setToasts(list => list.filter(x => x.id !== id)), ttl);
        return id;
    };
    const dismiss = (id: string) => setToasts(list => list.filter(x => x.id !== id));
    return { toasts, push, dismiss };
}

export function ToastHost({ toasts, dismiss, dismissLabel = 'Dismiss' }: any) {
    if (!toasts.length) return null;
    return (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 flex flex-col items-center gap-2 px-3" style={{ zIndex: 7000, paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
            {toasts.map(t => (
                <div key={t.id} role="status" className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl bg-slate-900 px-4 py-3 text-sm text-white shadow-2xl shadow-slate-900/30">
                    <i className={cx('fa-solid', t.type === 'error' ? 'fa-circle-exclamation text-red-300' : t.type === 'progress' ? 'fa-paper-plane text-violet-300' : 'fa-circle-check text-emerald-300')}></i>
                    <span className="min-w-0 flex-1 leading-snug">{t.text}</span>
                    {t.action && (
                        <button type="button" onClick={() => { t.action.onClick(); dismiss(t.id); }} className="shrink-0 rounded-lg px-2 py-1 text-sm font-bold text-violet-300 hover:bg-white/10 hover:text-white">
                            {t.action.label}
                        </button>
                    )}
                    <button type="button" onClick={() => dismiss(t.id)} aria-label={dismissLabel} className="shrink-0 rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white">
                        <i className="fa-solid fa-xmark text-xs"></i>
                    </button>
                </div>
            ))}
        </div>
    );
}

// --- container size ------------------------------------------------------------------------------

/** Width of an element, live. The layout keys off the CONTAINER (the admin shell has its own sidebar). */
export function useElementWidth(ref: any) {
    const [w, setW] = useState(0);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        setW(el.getBoundingClientRect().width);
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(entries => setW(entries[0].contentRect.width));
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref]);
    return w;
}

// --- the message frame ---------------------------------------------------------------------------

/**
 * Defense-in-depth strip of active content, and the REMOTE-IMAGE GATE: http(s) images are parked in
 * data-wjs-src until the reader asks for them, so opening a message does not tell a tracker that it was
 * read (and from which IP). Returns the html plus how many images were held back.
 */
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'background', 'poster']);
/**
 * A URL attribute is kept only when its scheme is on an ALLOWLIST: http(s), mailto and cid (an inline
 * part of the message), or no scheme at all (a fragment or relative reference). data: is kept only as
 * an inline IMAGE source (data:image/png|gif|jpeg|webp) — a data: link or frame source can carry an
 * html document. A denylist of javascript:/vbscript: missed every scheme it did not name.
 * `compactLower` has had whitespace AND control characters removed: browsers ignore those inside a
 * scheme, so `java\u0001script:` must be judged as the javascript: it really is.
 */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'cid']);
const MEDIA_ATTRS = new Set(['src', 'background', 'poster']);
export function isSafeUrl(attr: string, compactLower: string) {
    if (compactLower.startsWith('data:')) {
        return MEDIA_ATTRS.has(attr) && /^data:image\/(png|gif|jpe?g|webp);/.test(compactLower);
    }
    const scheme = /^([a-z][a-z0-9+.-]*):/.exec(compactLower);
    if (!scheme) return true;
    return SAFE_SCHEMES.has(scheme[1]);
}

/** Elements that can SET an attribute after sanitizing (SVG animation: `<set attributeName="href" to=…>`). */
const ANIMATION_TAGS = new Set(['set', 'animate', 'animatetransform', 'animatemotion', 'discard']);

export function prepareEmailHtml(html: string, showImages: boolean) {
    if (!html) return { html: '', blocked: 0 };
    if (typeof window === 'undefined' || typeof DOMParser === 'undefined') return { html: '', blocked: 0 };
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script, iframe, object, embed, link, meta, base, form').forEach(el => el.remove());
        // By local name, not a selector: SVG element names are case-sensitive (animateTransform).
        Array.from(doc.getElementsByTagName('*')).forEach(el => {
            if (ANIMATION_TAGS.has(String(el.localName || '').toLowerCase())) el.remove();
        });
        let blocked = 0;
        doc.querySelectorAll('*').forEach(el => {
            for (const attr of Array.from(el.attributes)) {
                const name = attr.name.toLowerCase();
                // eslint-disable-next-line no-control-regex
                const val = attr.value.replace(/[\u0000-\u0020\u007f-\u009f]+/g, '').toLowerCase();
                if (name.startsWith('on')) el.removeAttribute(attr.name);
                else if (URL_ATTRS.has(name) && !isSafeUrl(name, val)) el.removeAttribute(attr.name);
            }
            if (el.tagName === 'IMG' && !showImages) {
                const src = el.getAttribute('src') || '';
                if (/^(https?:)?\/\//i.test(src)) {
                    el.setAttribute('data-wjs-src', src);
                    el.removeAttribute('src');
                    el.removeAttribute('srcset');
                    blocked++;
                }
            }
            if (!showImages && el.getAttribute('style') && /url\(/i.test(el.getAttribute('style'))) {
                el.setAttribute('style', el.getAttribute('style').replace(/url\([^)]*\)/gi, 'none'));
                blocked++;
            }
            if (!showImages && el.hasAttribute('background')) { el.removeAttribute('background'); blocked++; }
        });
        return { html: doc.body.innerHTML, blocked };
    } catch {
        return { html: '', blocked: 0 };
    }
}

/**
 * Untrusted mail HTML renders in a sandboxed iframe with SCRIPTING DISABLED (no `allow-scripts`), so
 * nothing in the message can execute — that is what closes the scripting-flag mutation-XSS class that
 * a live-DOM render cannot (see the history in git). `allow-same-origin` WITHOUT `allow-scripts` adds
 * no execution path: it only lets THIS component read the frame's layout to size it to its content
 * (no inner scrollbar inside the page scroll, which was unusable on phones). No forms (no
 * `allow-forms`), links open as new top-level tabs (allow-popups + escape).
 */
export function EmailBodyFrame({ html, showImages, title = 'Message' }: any) {
    const ref = useRef<HTMLIFrameElement>(null);
    const [height, setHeight] = useState(120);
    const prepared = useMemo(() => prepareEmailHtml(html, showImages), [html, showImages]);
    const srcDoc = '<!doctype html><html><head><meta charset="utf-8"><base target="_blank">'
        + '<meta name="referrer" content="no-referrer">'
        + '<style>html,body{margin:0;padding:0}body{font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1e293b;word-break:break-word;overflow-wrap:anywhere}'
        + 'img{max-width:100%;height:auto}a{color:#6d28d9}table{max-width:100%!important}pre{white-space:pre-wrap}'
        + 'blockquote{margin:0 0 0 .8ex;border-left:2px solid #cbd5e1;padding-left:1ex;color:#475569}img:not([src]){display:inline-block;min-width:16px;min-height:16px;background:#f1f5f9}</style></head><body>'
        + prepared.html + '</body></html>';

    const measure = () => {
        try {
            const doc = ref.current?.contentDocument;
            if (!doc || !doc.body) return;
            const h = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight);
            if (h && Math.abs(h - height) > 2) setHeight(Math.min(h + 4, 20000));
        } catch { /* cross-origin (should not happen with same-origin): keep the current height */ }
    };
    useEffect(() => {
        const id = setInterval(measure, 400); // images loading change the height; cheap layout read
        const stop = setTimeout(() => clearInterval(id), 6000);
        return () => { clearInterval(id); clearTimeout(stop); };
    }, [srcDoc]);

    // The admin shell forces `iframe { height: 100% !important }` (admin-globals.css), so the height is
    // set on a wrapper and the frame fills it.
    return (
        <div style={{ height }} className="w-full">
            <iframe
                ref={ref}
                title={title}
                sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                srcDoc={srcDoc}
                onLoad={measure}
                className="block h-full w-full border-0 bg-transparent"
            />
        </div>
    );
}

export function useBlockedImageCount(html: string) {
    return useMemo(() => prepareEmailHtml(html, false).blocked, [html]);
}
