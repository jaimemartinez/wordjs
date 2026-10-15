"use client";
/**
 * Verso — the excerpt and meta-description fields with a "Suggest with AI" button underneath.
 *
 * `withAiSuggestions(fields)` swaps those two root fields (when present and still plain textareas) for a
 * `custom` field that renders the SAME textarea control (localized exactly as PropertiesPanel localizes
 * built-in fields, since `custom` fields pass through untouched) plus <AiSuggestion>. The suggestion reads
 * the live document at click time through the panel's editor handle (versoPanelHandleContext), so it
 * summarises what is on the canvas now, unsaved edits included. Accepting goes through the field's own
 * onChange — undo, autosave and the normal save path apply. The registry modules stay React-free.
 */
import type { VersoField, TextareaVersoField } from "@/lib/verso/registry";
import VersoFieldControl from "./VersoFieldControl";
import { useVersoPanelHandle } from "./versoPanelHandleContext";
import { localizeField } from "@/lib/editorI18n";
import { useI18n } from "@/contexts/I18nContext";
import AiSuggestion from "@/components/AiSuggest";
import type { AiSuggestTask } from "@/lib/api";

const AI_FIELDS: Record<string, AiSuggestTask> = {
    excerpt: "excerpt",
    seo_description: "seo_description",
};

/** Body text sent with the request is capped client-side too (the server cuts at 20k characters). */
const MAX_CONTENT_CHARS = 200_000;

function AiTextarea({ field, name, value, onChange, readOnly, task }: {
    field: TextareaVersoField;
    name: string;
    value: unknown;
    onChange: (v: unknown) => void;
    readOnly?: boolean;
    task: AiSuggestTask;
}) {
    const { language } = useI18n();
    const handle = useVersoPanelHandle();
    const getInput = () => {
        if (!handle) return {};
        const doc = handle.getState().doc;
        const rootProps = (doc.root && (doc.root.props as Record<string, unknown>)) || {};
        const ordered = [
            ...doc.rootChildren.map((id) => doc.nodes[id]).filter(Boolean),
            ...Object.values(doc.nodes).filter((n) => !doc.rootChildren.includes(n.id)),
        ].map((n) => n.props);
        return {
            title: typeof rootProps.title === "string" ? rootProps.title : "",
            content: JSON.stringify(ordered).slice(0, MAX_CONTENT_CHARS),
        };
    };
    return (
        <>
            <VersoFieldControl field={localizeField(field, language)} name={name} value={value} onChange={onChange} readOnly={readOnly} />
            {!readOnly && <AiSuggestion task={task} getInput={getInput} onAccept={(s) => onChange(s)} />}
        </>
    );
}

export function withAiSuggestions(fields: Record<string, VersoField>): Record<string, VersoField> {
    const out: Record<string, VersoField> = {};
    for (const [key, field] of Object.entries(fields)) {
        const task = AI_FIELDS[key];
        if (!task || field.type !== "textarea") { out[key] = field; continue; }
        const textarea = field as TextareaVersoField;
        out[key] = {
            type: "custom",
            label: textarea.label,
            render: ({ name, value, onChange, readOnly }) => (
                <AiTextarea field={textarea} name={name} value={value} onChange={onChange} readOnly={readOnly} task={task} />
            ),
        };
    }
    return out;
}
