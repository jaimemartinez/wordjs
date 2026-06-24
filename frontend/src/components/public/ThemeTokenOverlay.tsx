// Server component: emits an inline `:root { --wjs-*: … }` block built from the active theme's saved
// token overrides (set by the admin Theme Customizer, persisted in the `active_theme_mods` option and
// read here via getSettings). It is SSR'd AFTER the framework + theme stylesheets, so the overrides win
// at equal specificity with no flash-of-unstyled-content and no hydration mismatch (deterministic from
// server data). Empty/absent overrides render nothing — zero visual change for any theme.
//
// SECURITY: this emits CSS into the page, so it is strictly sanitized — only keys matching `--wjs-…`
// and values made of safe CSS characters (no `;{}:<>` that could break out of the declaration block)
// are emitted; everything else is dropped.
const KEY_RE = /^--wjs-[a-z0-9-]+$/;
const VALUE_RE = /^[#a-zA-Z0-9 ,.%()/_'"-]+$/;

export default function ThemeTokenOverlay({ mods }: { mods?: string | Record<string, unknown> | null }) {
    let obj: Record<string, unknown> | null = null;
    if (typeof mods === "string" && mods.trim()) {
        try { obj = JSON.parse(mods); } catch { obj = null; }
    } else if (mods && typeof mods === "object") {
        obj = mods as Record<string, unknown>;
    }
    if (!obj) return null;

    const decls = Object.entries(obj)
        .filter(([k, v]) => KEY_RE.test(k) && typeof v === "string" && v.length > 0 && v.length <= 120 && VALUE_RE.test(v))
        .map(([k, v]) => `${k}:${v as string}`)
        .join(";");
    if (!decls) return null;

    return <style id="wjs-theme-mods" dangerouslySetInnerHTML={{ __html: `:root{${decls}}` }} />;
}
