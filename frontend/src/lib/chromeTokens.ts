// Text tokens the chrome expands at render: {year} → the current year, {site} → the site title.
// Pure, DOM-free and shared by the public blocks (ChromeCopyright, ChromeRichText) and the editor
// canvas, so a token reads the same in both. Unknown {words} are left untouched.

export function applyChromeTokens(text: string, values: { site?: string; year?: number | string } = {}): string {
    const year = String(values.year ?? new Date().getFullYear());
    const site = values.site ?? "";
    return String(text).replace(/\{(year|site)\}/g, (_m, token: string) => (token === "year" ? year : site));
}

/** HTML-escape a value before it is spliced into markup (the {site} token inside ChromeRichText). */
export function escapeChromeText(value: string): string {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
