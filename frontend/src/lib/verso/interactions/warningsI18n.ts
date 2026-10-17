/**
 * The interaction compiler (compile.ts) reports its warnings as finished Spanish sentences — they
 * also feed logs and tests, so they stay that way. The panel shows them under "Avisos de la
 * interacción" in the admin language: a warning that interpolates values is matched against its
 * template here and re-rendered with trFmt; any other warning is a whole-sentence trStr lookup.
 * The templates and the fixed sentences live in the editor dictionary (editorI18nVerso.ts).
 */
import { trFmt, trStr } from "@/lib/editorI18n";
import type { Language } from "@/lib/i18n";

/** Spanish templates of the compile.ts warnings that carry values ({list}, {n}). */
export const IX_WARNING_TEMPLATES: readonly string[] = [
    "el puntero POSICIONA la animación (no la reproduce): {list} se ignoran — la sensación se ajusta con el suavizado",
    "un disparador de scroll ignora {list}: el progreso lo marca la posición, no el reloj",
    "tiempo total: exacto donde hay `sibling-count()`; el fallback reparte como si hubiera {n} hermanos",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const MATCHERS = IX_WARNING_TEMPLATES.map((template) => {
    const names: string[] = [];
    const source = template
        .split(/(\{\w+\})/)
        .map((part) => {
            const m = /^\{(\w+)\}$/.exec(part);
            if (!m) return escape(part);
            names.push(m[1]);
            return "(.+?)";
        })
        .join("");
    return { template, names, re: new RegExp(`^${source}$`) };
});

/** One compile.ts warning in `lang`. Unknown text is returned unchanged. */
export function localizeIxWarning(warning: string, lang: Language): string {
    for (const { template, names, re } of MATCHERS) {
        const m = re.exec(warning);
        if (m) return trFmt(template, lang, Object.fromEntries(names.map((n, i) => [n, m[i + 1]])));
    }
    return trStr(warning, lang);
}
