"use client";

/**
 * In-page links into author content.
 *
 * Every id an author writes is stored and rendered as `user-content-<id>` (lib/sanitize.ts and the
 * backend sanitizer — an unprefixed author id could clobber a property the page itself uses). A link to
 * `#intro`, in the content or from another page, must still land on `user-content-intro`: when the
 * fragment names no element but its prefixed form does, this scrolls there and moves focus to it, on
 * load and on every hash change. A fragment that matches a real id (a block's own anchor, the page's
 * chrome) is left to the browser.
 */
import { useEffect } from "react";

// The prefix lib/sanitize.ts gives every author id (kept here so this root island does not pull the
// sanitizer and DOMPurify into every page's bundle).
const USER_CONTENT_PREFIX = "user-content-";

/** The element an unresolved fragment means, or null when the browser already handles it. */
export function userContentTarget(hash: string, doc: Document): HTMLElement | null {
    let id = "";
    try { id = decodeURIComponent(String(hash || "").replace(/^#/, "")); } catch { return null; }
    if (!id || id.startsWith(USER_CONTENT_PREFIX) || doc.getElementById(id)) return null;
    return doc.getElementById(USER_CONTENT_PREFIX + id);
}

export default function UserContentAnchors() {
    useEffect(() => {
        const go = () => {
            const target = userContentTarget(window.location.hash, document);
            if (!target) return;
            target.scrollIntoView();
            if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
            target.focus({ preventScroll: true });
        };
        // Clicking a link to the fragment already in the URL fires no hashchange: resolve after the click.
        const onClick = (e: MouseEvent) => {
            const a = (e.target as Element | null)?.closest?.('a[href^="#"]');
            if (a) setTimeout(go, 0);
        };
        // On load the router settles the scroll position after this island mounts, so the first answer can
        // be undone: resolve again once things are quiet, unless the reader has already moved.
        go();
        const start = window.scrollY;
        const timers = [150, 600].map((ms) => window.setTimeout(() => {
            if (window.scrollY === start || window.scrollY === 0) go();
        }, ms));
        window.addEventListener("hashchange", go);
        document.addEventListener("click", onClick);
        return () => {
            timers.forEach((t) => window.clearTimeout(t));
            window.removeEventListener("hashchange", go);
            document.removeEventListener("click", onClick);
        };
    }, []);
    return null;
}
