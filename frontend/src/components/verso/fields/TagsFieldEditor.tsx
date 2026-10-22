"use client";

/**
 * The editor's «Tags» control (QA S1-23): the assigned tags as removable chips, a select to add an
 * existing tag, and — for someone who may manage categories — a box to CREATE a new tag on the spot.
 * The editor could only pick tags that already existed («Choose a tag»), so tagging a post with a new
 * word meant leaving the editor for the Tags screen.
 *
 * The value keeps the shape the save path already sends: `[{ tag: "<term id>" }, …]` (lib/editorRootFields
 * tagsToBody). A new tag is created through POST /tags first, so every value is an id that exists.
 */
import { useId, useState } from "react";
import { tagsApi } from "@/lib/api";
import { useOptionalAuth } from "@/contexts/AuthContext";
import { trStr } from "@/lib/editorI18n";
import { useI18n } from "@/contexts/I18nContext";
import type { Language } from "@/lib/i18n";

export interface TagOption { value: string; label: string }

interface Props {
    value: unknown;
    onChange: (value: unknown) => void;
    options: TagOption[];
    readOnly?: boolean;
}

function selectedIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        const id = item && typeof item === "object" ? String((item as { tag?: unknown }).tag ?? "") : "";
        if (id && !out.includes(id)) out.push(id);
    }
    return out;
}

export default function TagsFieldEditor({ value, onChange, options, readOnly }: Props) {
    const { language } = useI18n();
    const t = (s: string) => trStr(s, language as Language);
    const auth = useOptionalAuth();
    const canCreate = !!auth?.can?.("manage_categories");
    const id = useId();
    const [extra, setExtra] = useState<TagOption[]>([]);
    const [newName, setNewName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const all = [...options.filter((o) => o.value), ...extra.filter((e) => !options.some((o) => o.value === e.value))];
    const labelOf = (v: string) => all.find((o) => o.value === v)?.label || "#" + v;
    const ids = selectedIds(value);
    const emit = (next: string[]) => onChange(next.map((tag) => ({ tag })));

    const create = async () => {
        const name = newName.trim();
        if (!name) return;
        const existing = all.find((o) => o.label.toLowerCase() === name.toLowerCase());
        if (existing) { if (!ids.includes(existing.value)) emit([...ids, existing.value]); setNewName(""); return; }
        setBusy(true);
        setError("");
        try {
            const tag = await tagsApi.create({ name });
            const option = { value: String(tag.id), label: tag.name || name };
            setExtra((x) => [...x, option]);
            emit([...ids, option.value]);
            setNewName("");
        } catch (e: unknown) {
            setError(e instanceof Error && e.message ? e.message : t("No se pudo crear la etiqueta"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-2" data-testid="verso-tags-field">
            {ids.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label={t("Etiquetas")}>
                    {ids.map((v) => (
                        <li key={v} className="inline-flex items-center gap-1 rounded-full bg-gray-100 pl-2.5 pr-1 py-0.5 text-xs text-gray-700">
                            {labelOf(v)}
                            {!readOnly && (
                                <button type="button" onClick={() => emit(ids.filter((x) => x !== v))} aria-label={t("Quitar") + " " + labelOf(v)}
                                    className="w-6 h-6 inline-flex items-center justify-center rounded-full hover:bg-gray-200">
                                    <i className="fa-solid fa-xmark text-[10px]" aria-hidden="true"></i>
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {!readOnly && (
                <select aria-label={t("Elige una etiqueta")} value="" onChange={(e) => { if (e.target.value && !ids.includes(e.target.value)) emit([...ids, e.target.value]); }}
                    className="w-full min-h-9 rounded-md border border-gray-200 bg-white px-2 text-xs">
                    <option value="">{t("Elige una etiqueta")}</option>
                    {all.filter((o) => !ids.includes(o.value)).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
            )}
            {!readOnly && canCreate && (
                <div className="flex gap-1.5">
                    <label htmlFor={id + "-new"} className="sr-only">{t("Nueva etiqueta")}</label>
                    <input id={id + "-new"} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("Nueva etiqueta")}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); create(); } }}
                        className="flex-1 min-w-0 min-h-9 rounded-md border border-gray-200 px-2 text-xs" />
                    <button type="button" onClick={create} disabled={busy || !newName.trim()}
                        className="min-h-9 px-2.5 rounded-md bg-gray-900 text-white text-xs font-semibold disabled:opacity-50">
                        {t("Añadir")}
                    </button>
                </div>
            )}
            {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
        </div>
    );
}
