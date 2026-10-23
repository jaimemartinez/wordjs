"use client";

import { useEffect, useState } from "react";
import { aiApi, AiSuggestTask } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import { UnstyledButton } from "@/components/ui";

/**
 * "Suggest with AI" — the editor's first-party use of the AI provider layer (backend routes/ai.ts).
 *
 * A suggestion is only ever a PROPOSAL: it appears under the field with Use / Try again / Dismiss, and
 * nothing changes until the user clicks Use (which goes through the field's own onChange, so the normal
 * save path, autosave and undo apply). The button does not render at all when no provider is configured.
 */

let statusPromise: Promise<boolean> | null = null;
/** Whether AI suggestions are available — asked once per page load and shared by every button. */
export function useAiEnabled(): boolean {
    const [enabled, setEnabled] = useState(false);
    useEffect(() => {
        let alive = true;
        if (!statusPromise) statusPromise = aiApi.status().then((s) => !!s.enabled).catch(() => false);
        statusPromise.then((v) => { if (alive) setEnabled(v); });
        return () => { alive = false; };
    }, []);
    return enabled;
}

/**
 * The i18n key for a failed suggestion's error code: the code's own key when it has a translation (a
 * timeout, a model without vision, an unknown model…), the generic provider message for any other
 * `ai_provider_*` code, and "" when there is no code. `has` says whether a key is translated.
 */
export function aiErrorKey(code: string, has: (key: string) => boolean): string {
    const own = code ? `ai.err.${code}` : "";
    if (own && has(own)) return own;
    return code.startsWith("ai_provider") ? "ai.err.provider" : own;
}

/** Forget the cached answer (the AI settings screen calls it after saving). */
export function resetAiStatusCache(): void {
    statusPromise = null;
}

type Tone = "editor" | "admin";

const BTN: Record<Tone, string> = {
    editor: "inline-flex items-center gap-1 rounded border border-[var(--ed-outline-variant)] px-2 py-1 text-xs text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] disabled:opacity-40",
    admin: "inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1 text-[11px] font-bold text-violet-700 hover:bg-violet-100 disabled:opacity-40",
};
const BOX: Record<Tone, string> = {
    editor: "mt-1.5 rounded border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container)] p-2 text-sm text-[var(--ed-on-surface)]",
    admin: "mt-2 rounded-xl border border-violet-100 bg-violet-50/60 p-3 text-sm text-gray-700",
};

export default function AiSuggestion({
    task,
    getInput,
    onAccept,
    tone = "editor",
}: {
    task: AiSuggestTask;
    /** What to send: the draft's title/content, or the media id for alt text. Read at click time. */
    getInput: () => { title?: string; content?: string; mediaId?: number };
    onAccept: (suggestion: string) => void;
    tone?: Tone;
}) {
    const { t, language } = useI18n();
    const enabled = useAiEnabled();
    const [busy, setBusy] = useState(false);
    const [suggestion, setSuggestion] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    if (!enabled) return null;

    const run = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await aiApi.suggest({ task, language, ...getInput() });
            setSuggestion(res.suggestion);
        } catch (e: any) {
            setSuggestion(null);
            // Known refusals have their own wording in the admin's language; anything else keeps the
            // server's (already key-free) message.
            const code = typeof e?.code === "string" ? e.code : "";
            const key = aiErrorKey(code, (k) => t(k) !== k);
            const localized = key ? t(key) : "";
            setError(localized && localized !== key ? localized : e?.message || t("ai.suggestFailed"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="mb-3" data-ai-suggest={task}>
            <UnstyledButton type="button" className={BTN[tone]} onClick={run} disabled={busy} aria-busy={busy}>
                <i className={`fa-solid ${busy ? "fa-spinner fa-spin" : "fa-wand-magic-sparkles"}`} aria-hidden="true"></i>
                {busy ? t("ai.suggesting") : t("ai.suggest")}
            </UnstyledButton>
            {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
            {suggestion !== null && (
                <div className={BOX[tone]} role="status" aria-live="polite">
                    <p className="text-[11px] font-bold uppercase tracking-wider opacity-60 mb-1">{t("ai.suggestionLabel")}</p>
                    <p className="whitespace-pre-wrap break-words">{suggestion}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                        <UnstyledButton type="button" className={BTN[tone]} onClick={() => { onAccept(suggestion); setSuggestion(null); }}>
                            <i className="fa-solid fa-check" aria-hidden="true"></i>{t("ai.use")}
                        </UnstyledButton>
                        <UnstyledButton type="button" className={BTN[tone]} onClick={run} disabled={busy}>
                            <i className="fa-solid fa-rotate" aria-hidden="true"></i>{t("ai.retry")}
                        </UnstyledButton>
                        <UnstyledButton type="button" className={BTN[tone]} onClick={() => setSuggestion(null)}>
                            <i className="fa-solid fa-xmark" aria-hidden="true"></i>{t("ai.dismiss")}
                        </UnstyledButton>
                    </div>
                </div>
            )}
        </div>
    );
}
