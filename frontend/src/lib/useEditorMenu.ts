"use client";

import React from "react";
import { menusApi } from "@/lib/api";
import type { ChromeMenuItem } from "@/lib/chromeData";

/**
 * EDITOR-CANVAS resolver for the NavMenu block (mirrors useEditorPosts for the post listings).
 *
 * On the public site the SSR pass (resolveDynamicBlocks) injects `resolvedMenu` before the block
 * renders, so the nav shows the real, bound menu. The editor canvas has no server pass — without this
 * the block would fall through to its empty/authoring notice even when the referenced menu is full.
 * This hook fetches the referenced menu ONCE per editor session (one shared promise per distinct
 * reference, however many NavMenu blocks name it) straight from the same nav_menu store the block
 * binds to, so author preview and published page can never drift.
 *
 * Inert outside the editor: when `resolvedMenu` was injected (public site) or `editing` is false it
 * returns the injected value untouched and never fetches.
 */

export interface MenuRef {
    source?: string;
    location?: string;
    menuId?: number | string;
}

/** Stable key for a reference — equal refs share one fetch; the key drives the refetch on repoint. */
function refKey(ref: MenuRef): string {
    if (String(ref?.source) === "menu") {
        const id = Number(ref?.menuId);
        return `menu:${Number.isFinite(id) && id > 0 ? id : 0}`;
    }
    return `location:${String(ref?.location || "header")}`;
}

// One in-flight/settled promise per reference key, shared across every NavMenu block in the session.
const menuCache = new Map<string, Promise<ChromeMenuItem[]>>();

function fetchMenu(ref: MenuRef): Promise<ChromeMenuItem[]> {
    const key = refKey(ref);
    let promise = menuCache.get(key);
    if (!promise) {
        const source = String(ref?.source) === "menu" ? "menu" : "location";
        const request: Promise<unknown> = source === "menu"
            ? ((): Promise<unknown> => {
                const id = Number(ref?.menuId);
                return Number.isFinite(id) && id > 0 ? menusApi.get(id) : Promise.resolve(null);
            })()
            : menusApi.getByLocation(String(ref?.location || "header"));
        promise = request
            .then((menu) => {
                const items = (menu as { items?: unknown } | null)?.items;
                return Array.isArray(items) ? (items as ChromeMenuItem[]) : [];
            })
            .catch(() => {
                menuCache.delete(key); // a failed fetch may retry on the next mount
                return [] as ChromeMenuItem[];
            });
        menuCache.set(key, promise);
    }
    return promise;
}

export function useEditorMenu(
    editing: boolean,
    injected: ChromeMenuItem[] | undefined,
    ref: MenuRef,
): ChromeMenuItem[] {
    const hasInjected = Array.isArray(injected) && injected.length > 0;
    // Recreated each render otherwise; memoize on the primitive fields so the effect only re-runs when
    // the author actually repoints the block, not on every keystroke elsewhere.
    const stableRef = React.useMemo<MenuRef>(
        () => ({ source: ref?.source, location: ref?.location, menuId: ref?.menuId }),
        [ref?.source, ref?.location, ref?.menuId],
    );
    const [items, setItems] = React.useState<ChromeMenuItem[] | null>(null);

    React.useEffect(() => {
        if (!editing || hasInjected) return;
        let dead = false;
        fetchMenu(stableRef).then((menu) => { if (!dead) setItems(menu); });
        return () => { dead = true; };
    }, [editing, hasInjected, stableRef]);

    if (hasInjected) return injected as ChromeMenuItem[];
    if (!editing || !items) return [];
    return items;
}
