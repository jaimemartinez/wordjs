// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client". The copyright line with live tokens: {year} is the current year and {site} the site
// title, so "© {year} {site}" never goes stale on January 1st. Plain text — rendered escaped.
import { applyChromeTokens } from "@/lib/chromeTokens";

export const DEFAULT_COPYRIGHT = "© {year} {site}";

export interface ChromeCopyrightViewProps {
    text?: string;
    // Resolved bindings
    siteTitle?: string;
}

export default function ChromeCopyright({ text, siteTitle }: ChromeCopyrightViewProps) {
    const value = applyChromeTokens(typeof text === "string" && text.trim() ? text : DEFAULT_COPYRIGHT, { site: siteTitle || "" }).trim();
    if (!value) return null;
    return <p className="wjs-chrome-copyright text-sm m-0 opacity-80">{value}</p>;
}
