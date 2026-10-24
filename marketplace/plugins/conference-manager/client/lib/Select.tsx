// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * Conference Manager's select (2.33.2) — every dropdown of the plugin, in place of the browser's: a styled button
 * that opens a panel with a scrolling list and, for longer lists, a search box. It is a DROP-IN for <select>: the
 * same <option> / <optgroup> children, `value`, `onChange(e)` with `e.target.value` (a string, as the browser's),
 * `disabled`, `id` (so a <label htmlFor> still names it), aria-* and data-* (they land on the button, so
 * `[data-field=…]` still finds the field). `required` is ignored on purpose: errors are shown in place, never with
 * the browser's bubbles.
 *
 * The panel (SelectPanel, shared with the phone country picker) is portalled to <body> above every dialog, placed
 * under the button (above it when there is no room), follows it on scroll and resize, and closes on a press
 * outside. Keyboard: Enter / Space / ↓ open; in the panel ↑/↓/Home/End move, Enter picks, Escape closes only the
 * panel (the dialog under it stays), Tab leaves; typing on the closed button jumps like a native select. ARIA: a
 * combobox (the search box, or the list itself) driving a listbox. Until the host form kit reaches plugins, this
 * is the plugin's own.
 */
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const SELECT_LABELS: Record<string, { search: string; none: string }> = {
    es: { search: 'Buscar…', none: 'Nada coincide.' },
    en: { search: 'Search…', none: 'Nothing matches.' },
    pt: { search: 'Buscar…', none: 'Nada corresponde.' },
};
const langNow = () => {
    try { const s = typeof localStorage !== 'undefined' && localStorage.getItem('wordjs-lang'); if (s) return String(s).slice(0, 2); } catch { /* private mode */ }
    return typeof navigator !== 'undefined' ? String(navigator.language || 'es').slice(0, 2) : 'es';
};
export const normSearch = (s: unknown) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export type SelectItem = { value: string; label: string; disabled?: boolean; group?: string; data?: any };

/** Text of React children (an <option>'s label). */
function textOf(node: any): string {
    if (node == null || node === false || node === true) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (node.props) return textOf(node.props.children);
    return '';
}
/** <option> / <optgroup> children → items (fragments and arrays flattened, null / false skipped). */
export function itemsOf(children: any, group?: string, out: SelectItem[] = []): SelectItem[] {
    React.Children.forEach(children, (c: any) => {
        if (!c || typeof c !== 'object') return;
        if (c.type === React.Fragment) { itemsOf(c.props.children, group, out); return; }
        if (c.type === 'optgroup') { itemsOf(c.props.children, String(c.props.label || ''), out); return; }
        if (c.type === 'option') {
            const label = textOf(c.props.children);
            const value = c.props.value === undefined ? label : String(c.props.value);
            out.push({ value, label, disabled: !!c.props.disabled, group });
        }
    });
    return out;
}
/** The items matching a search: labels starting with it first, then containing it. */
export function filterItems(items: SelectItem[], q: string): SelectItem[] {
    const n = normSearch(q);
    if (!n) return items;
    const starts: SelectItem[] = [], rest: SelectItem[] = [];
    for (const it of items) {
        const l = normSearch(it.label);
        if (l.startsWith(n)) starts.push(it);
        else if (l.includes(n)) rest.push(it);
    }
    return [...starts, ...rest];
}

/**
 * The open panel: search box (when `searchable`), the list, keyboard. `filter(items, q)` may replace the default
 * search; `renderItem(item)` draws a row (the label by default).
 */
export function SelectPanel({ anchor, items, value, onPick, onClose, searchable, label, lang, placeholder, filter = filterItems, renderItem }: {
    anchor: React.RefObject<HTMLElement>; items: SelectItem[]; value: string; onPick: (v: string) => void; onClose: (focusBack: boolean) => void;
    searchable: boolean; label?: string; lang?: string; placeholder?: string; filter?: (items: SelectItem[], q: string) => SelectItem[]; renderItem?: (it: SelectItem, selected: boolean) => React.ReactNode;
}) {
    const L = SELECT_LABELS[String(lang || langNow()).slice(0, 2)] || SELECT_LABELS.es;
    const [q, setQ] = useState('');
    const shown = useMemo(() => filter(items, q), [items, q, filter]);
    const firstOn = (list: SelectItem[], from = 0, step = 1) => { for (let i = from; i >= 0 && i < list.length; i += step) if (!list[i].disabled) return i; return -1; };
    const [active, setActive] = useState(() => { const i = items.findIndex(it => it.value === value); return i >= 0 ? i : firstOn(items); });
    const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number; maxH: number } | null>(null);
    const panel = useRef<HTMLDivElement>(null);
    const list = useRef<HTMLUListElement>(null);
    const uid = useId();
    const listId = `${uid}-list`;

    // Under the field; above it only when the list does not fit below and there is more room above. Opening upward,
    // the panel's BOTTOM edge sits on the field, so a short list stays next to it instead of floating higher up.
    const place = () => {
        const b = anchor.current;
        if (!b || typeof window === 'undefined') return;
        const r = b.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const width = Math.min(Math.max(r.width, 240), 360, vw - 16);
        const left = Math.max(8, Math.min(r.left, vw - width - 8));
        const need = Math.min(360, items.length * 44 + (searchable ? 58 : 0) + 10);
        const below = vh - r.bottom - 12, above = r.top - 12;
        const up = below < need && above > below;
        const maxH = Math.max(120, Math.min(360, up ? above : below));
        setPos(up ? { bottom: vh - r.top + 6, left, width, maxH } : { top: r.bottom + 6, left, width, maxH });
    };
    useLayoutEffect(() => { place(); }, []);
    useEffect(() => {
        const onMove = (e?: Event) => { if (e && panel.current && e.target instanceof Node && panel.current.contains(e.target)) return; place(); };
        const onDown = (e: Event) => {
            const t = e.target as Node;
            if (panel.current && panel.current.contains(t)) return;
            if (anchor.current && anchor.current.contains(t)) return;
            onClose(false);
        };
        window.addEventListener('resize', onMove);
        window.addEventListener('scroll', onMove, true);
        document.addEventListener('pointerdown', onDown, true);
        // Focus inside the panel: the search box, else the list.
        const t = setTimeout(() => { const f = panel.current && (panel.current.querySelector('input') || panel.current.querySelector('[role="listbox"]')); if (f) (f as HTMLElement).focus(); }, 0);
        return () => { clearTimeout(t); window.removeEventListener('resize', onMove); window.removeEventListener('scroll', onMove, true); document.removeEventListener('pointerdown', onDown, true); };
    }, []);
    // 2.36.6 («en los select con search no se puede hacer scroll, sube y baja»): the active row is scrolled into view
    // only when the panel opens (the chosen one, centred), on a keyboard move and on a new search — NEVER because the
    // pointer passed over a row. Scrolling the list moves rows under the pointer; scrolling the hovered one back into
    // view (and a parent's fresh `items` re-running this) made the list jump up and down.
    const reveal = useRef<'center' | 'nearest' | null>('center');
    // A new search puts its best match first: the list goes back to its top.
    useEffect(() => { if (q) { reveal.current = null; setActive(firstOn(shown)); if (list.current) list.current.scrollTop = 0; } }, [q]);
    useEffect(() => {
        const block = reveal.current;
        if (!list.current || !block) return;
        const el = list.current.querySelector(`[data-index="${active}"]`) as HTMLElement | null;
        if (!el) return;
        reveal.current = null;
        el.scrollIntoView({ block });
    }, [active, shown, !!pos]);
    const move = (n: number) => { if (n < 0) return; reveal.current = 'nearest'; setActive(n); };

    const onKey = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(firstOn(shown, active + 1, 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(firstOn(shown, active - 1, -1)); }
        else if (e.key === 'Home') { e.preventDefault(); move(firstOn(shown)); }
        else if (e.key === 'End') { e.preventDefault(); move(firstOn(shown, shown.length - 1, -1)); }
        else if (e.key === 'Enter' || (e.key === ' ' && !searchable)) { e.preventDefault(); const it = shown[active]; if (it && !it.disabled) onPick(it.value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (e.nativeEvent && e.nativeEvent.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation(); onClose(true); }
        else if (e.key === 'Tab') onClose(false);
    };
    if (!pos || typeof document === 'undefined') return null;
    const activeId = shown[active] ? `${uid}-${active}` : undefined;
    let lastGroup: string | undefined;
    return createPortal(
        <div ref={panel} className="bg-white rounded-2xl border border-gray-200 shadow-2xl overflow-hidden flex flex-col text-left" data-select-panel=""
            style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.maxH, zIndex: 7000 }} onKeyDown={onKey}>
            {searchable && (
                <div className="p-2 border-b border-gray-100 shrink-0">
                    <div className="relative">
                        <i className="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs" aria-hidden="true"></i>
                        <input type="text" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeId}
                            aria-label={placeholder || (label ? `${L.search} ${label}` : L.search)} placeholder={placeholder || L.search} value={q} onChange={(e) => setQ(e.target.value)} data-select-search=""
                            className="w-full rounded-xl border-2 border-gray-100 bg-gray-50/50 pl-8 pr-3 py-2 text-base sm:text-sm text-gray-900 outline-none focus:border-blue-500 focus:bg-white" />
                    </div>
                </div>
            )}
            <ul ref={list} id={listId} role="listbox" aria-label={label} tabIndex={searchable ? -1 : 0} aria-activedescendant={searchable ? undefined : activeId}
                className="overflow-y-auto overscroll-contain py-1 flex-1 min-h-0 outline-none" data-select-list="">
                {shown.length === 0 && <li className="px-4 py-6 text-center text-sm text-gray-400" role="presentation">{L.none}</li>}
                {shown.map((it, i) => {
                    const selected = it.value === value;
                    const head = !q && it.group && it.group !== lastGroup ? it.group : null;
                    lastGroup = it.group;
                    return (
                        <React.Fragment key={`${it.group || ''}|${it.value}|${i}`}>
                            {head && <li role="presentation" className="px-3 pt-2 pb-1 text-[10px] font-black uppercase tracking-widest text-gray-400">{head}</li>}
                            <li id={`${uid}-${i}`} role="option" aria-selected={selected} aria-disabled={it.disabled || undefined} data-index={i} data-option-value={it.value}
                                onMouseEnter={() => !it.disabled && setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => !it.disabled && onPick(it.value)}
                                className={`flex items-center gap-3 px-3 min-h-[44px] text-sm ${it.disabled ? 'text-gray-300 cursor-not-allowed' : 'cursor-pointer'} ${i === active && !it.disabled ? 'bg-blue-50' : ''} ${selected ? 'font-bold text-blue-700' : it.disabled ? '' : 'text-gray-800'}`}>
                                {renderItem ? renderItem(it, selected) : <span className="flex-1 min-w-0" style={{ overflowWrap: 'anywhere' }}>{it.label || ' '}</span>}
                                {selected && <i className="fa-solid fa-check text-blue-600 text-xs shrink-0" aria-hidden="true"></i>}
                            </li>
                        </React.Fragment>
                    );
                })}
            </ul>
        </div>, document.body);
}

/** Lists longer than this get a search box (a prop can force it either way). */
export const SEARCH_FROM = 8;

export function Select(props: any) {
    const { value, defaultValue, onChange, children, className = '', style, disabled, id, name, searchable, lang, required, title, ...rest } = props;
    const items = useMemo(() => itemsOf(children), [children]);
    const [inner, setInner] = useState(defaultValue == null ? (items[0] ? items[0].value : '') : String(defaultValue));
    const current = value === undefined ? inner : String(value == null ? '' : value);
    // A value no option has shows the first option, as the browser's select does.
    const selected = items.find(it => it.value === current) || items[0] || null;
    const [open, setOpen] = useState(false);
    const btn = useRef<HTMLButtonElement>(null);
    const typed = useRef({ s: '', at: 0 });
    const aria = Object.fromEntries(Object.entries(rest).filter(([k]) => k.startsWith('aria-') || k.startsWith('data-')));
    const ariaLabel = rest['aria-label'];
    const emit = (v: string) => {
        if (value === undefined) setInner(v);
        if (onChange) {
            const target = { value: v, name, id };
            onChange({ target, currentTarget: target, type: 'change', preventDefault() {}, stopPropagation() {} });
        }
    };
    const close = (focusBack: boolean) => { setOpen(false); if (focusBack) setTimeout(() => btn.current && btn.current.focus(), 0); };
    // Typing on the closed button jumps to the next option starting with what was typed, as a native select does.
    const typeAhead = (key: string) => {
        const now = Date.now();
        typed.current = { s: (now - typed.current.at < 700 ? typed.current.s : '') + key, at: now };
        const n = normSearch(typed.current.s);
        const hit = items.find(it => !it.disabled && normSearch(it.label).startsWith(n));
        if (hit && hit.value !== current) emit(hit.value);
    };
    const shownLabel = selected ? selected.label : '';
    return (
        <>
            <button ref={btn} type="button" id={id} disabled={disabled} title={title} {...aria}
                aria-label={ariaLabel ? `${ariaLabel}: ${shownLabel}` : undefined} aria-haspopup="listbox" aria-expanded={open}
                onClick={() => setOpen(o => !o)}
                onKeyDown={(e) => {
                    if (open) return;
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); }
                    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) typeAhead(e.key);
                }}
                className={`${className} inline-flex items-center justify-between gap-2 text-left cursor-pointer disabled:cursor-not-allowed disabled:opacity-60`}
                style={style} data-select="" data-value={current}>
                <span className="min-w-0 flex-1 truncate">{shownLabel || ' '}</span>
                <i className={`fa-solid fa-chevron-down text-[10px] text-gray-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true"></i>
            </button>
            {open && (
                <SelectPanel anchor={btn} items={items} value={current} lang={lang} label={ariaLabel}
                    searchable={searchable === undefined ? items.length >= SEARCH_FROM : !!searchable}
                    onPick={(v) => { if (v !== current) emit(v); close(true); }} onClose={close} />
            )}
        </>
    );
}

export default Select;
