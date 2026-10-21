/**
 * The text of an admin sidebar entry in the admin's language.
 * - Core entries carry a catalogue key (`nav.*`), translated with `t`.
 * - Plugin entries carry a plain `label` and, optionally, `labels` per language (`{ en, es, pt }`,
 *   registered through adminMenu.add). The exact language wins, then its base ("pt" for "pt-BR"),
 *   then `label`.
 */
export function menuLabel(
    item: { label?: unknown; labels?: unknown },
    language: string,
    t: (key: string) => string,
): string {
    const label = item.label;
    if (typeof label === "string" && label.startsWith("nav.")) return t(label);
    const labels = item.labels;
    if (labels && typeof labels === "object" && !Array.isArray(labels)) {
        const map = labels as Record<string, unknown>;
        const lang = String(language || "");
        const hit = map[lang] ?? map[lang.split("-")[0]];
        if (typeof hit === "string" && hit.trim()) return hit;
    }
    return label == null ? "" : String(label);
}
