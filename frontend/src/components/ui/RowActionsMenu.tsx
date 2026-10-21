"use client";

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ADMIN_Z } from "@/lib/adminLayers";
import type { DataTableAction } from "./DataTable";

/**
 * The "More actions" button of a table row: the row's less frequent actions in a small menu, so a narrow
 * table keeps one or two visible buttons per row instead of scrolling sideways. The menu is portalled to
 * <body> (the table's scroller would clip it) and positioned against the button; it follows the menu
 * button pattern — Enter/Space/ArrowDown open it on the first item, arrows move, Escape closes and returns
 * focus to the button, Tab or a click elsewhere closes it.
 */
export function RowActionsMenu({ actions, label, buttonClassName }: { actions: DataTableAction[]; label: string; buttonClassName: string }) {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const menuId = useId();

    const place = useCallback(() => {
        const r = buttonRef.current?.getBoundingClientRect();
        if (!r) return;
        const menuH = menuRef.current?.offsetHeight ?? 48 * actions.length + 8;
        const menuW = menuRef.current?.offsetWidth ?? 220;
        const up = r.bottom + menuH + 8 > window.innerHeight && r.top - menuH - 8 > 0;
        const left = Math.max(8, Math.min(r.right - menuW, window.innerWidth - menuW - 8));
        setPos({ top: up ? r.top - menuH - 4 : r.bottom + 4, left, up });
    }, [actions.length]);

    useLayoutEffect(() => { if (open) place(); }, [open, place]);

    const close = useCallback((refocus: boolean) => {
        setOpen(false);
        if (refocus) buttonRef.current?.focus();
    }, []);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent | TouchEvent) => {
            const t = e.target as Node;
            if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) close(false);
        };
        const onMove = () => close(false);
        document.addEventListener("mousedown", onDown);
        document.addEventListener("touchstart", onDown);
        window.addEventListener("resize", onMove);
        window.addEventListener("scroll", onMove, true);
        // Focus the first item once the menu is in place.
        const id = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>("[role=menuitem]:not([aria-disabled=true])")?.focus());
        return () => {
            cancelAnimationFrame(id);
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("touchstart", onDown);
            window.removeEventListener("resize", onMove);
            window.removeEventListener("scroll", onMove, true);
        };
    }, [open, close]);

    const onMenuKey = (e: React.KeyboardEvent) => {
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([aria-disabled=true])") ?? []);
        const i = items.indexOf(document.activeElement as HTMLElement);
        if (e.key === "Escape") { e.preventDefault(); close(true); }
        else if (e.key === "Tab") close(false);
        else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
        else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
        else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
    };

    const itemCls = (a: DataTableAction) =>
        `flex w-full min-h-11 items-center gap-3 rounded-lg px-3 text-left text-sm font-bold outline-none transition-colors ${a.disabled ? "opacity-50 pointer-events-none" : ""} ${a.tone === "danger" ? "text-red-600 hover:bg-red-50 focus:bg-red-50" : "text-gray-700 hover:bg-gray-100 focus:bg-gray-100"}`;

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                className={buttonClassName}
                aria-label={label}
                title={label}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
                onClick={() => setOpen((o) => !o)}
                onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}
            >
                <i className="fa-solid fa-ellipsis text-sm" aria-hidden="true"></i>
            </button>
            {open && typeof document !== "undefined" && createPortal(
                <div
                    ref={menuRef}
                    id={menuId}
                    role="menu"
                    aria-label={label}
                    data-wjs-host-ui=""
                    onKeyDown={onMenuKey}
                    style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999, zIndex: ADMIN_Z.popover }}
                    className="min-w-[13rem] max-w-[calc(100vw-1rem)] rounded-xl border border-gray-100 bg-white p-1 shadow-xl animate-in fade-in duration-100"
                >
                    {actions.map((a) => {
                        const inner = (
                            <>
                                <i className={`fa-solid ${a.icon} w-4 text-center text-xs`} aria-hidden="true"></i>
                                <span>{a.label}</span>
                            </>
                        );
                        if (a.href && !a.disabled) {
                            return a.external
                                ? <a key={a.key} role="menuitem" tabIndex={-1} href={a.href} target="_blank" rel="noopener noreferrer" className={itemCls(a)} onClick={() => close(false)}>{inner}</a>
                                : <Link key={a.key} role="menuitem" tabIndex={-1} href={a.href} className={itemCls(a)} onClick={() => close(false)}>{inner}</Link>;
                        }
                        return (
                            <button
                                key={a.key}
                                type="button"
                                role="menuitem"
                                tabIndex={-1}
                                aria-disabled={a.disabled || undefined}
                                className={itemCls(a)}
                                onClick={() => { if (a.disabled) return; close(true); a.onClick?.(); }}
                            >
                                {inner}
                            </button>
                        );
                    })}
                </div>,
                document.body,
            )}
        </>
    );
}

export default RowActionsMenu;
