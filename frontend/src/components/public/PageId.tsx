"use client";
import { useEffect } from "react";

/**
 * Publishes the current page's id as `window.__WJS_PAGE_ID` (read lazily by FormBlock when it stamps
 * a submission).
 *
 * This used to be an inline `<script>` in PostContent, and that was a real bug wearing a React
 * warning: an inline script executes only while the browser parses the server-rendered document. On a
 * SOFT navigation React inserts the element and never runs it, so the global kept the PREVIOUS
 * page's id and a form submitted after client-side navigation was stamped against the wrong page.
 * An effect keyed on the id runs on mount and on every soft-nav remount, so the global always
 * matches the page actually on screen.
 */
export default function PageId({ id }: { id: number }) {
    useEffect(() => {
        (window as unknown as { __WJS_PAGE_ID?: number }).__WJS_PAGE_ID = id;
    }, [id]);
    return null;
}
