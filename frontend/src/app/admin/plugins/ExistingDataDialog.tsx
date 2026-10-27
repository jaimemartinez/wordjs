"use client";

/**
 * "A previous installation of <plugin> left data behind — keep it or start clean?"
 *
 * Uninstalling a plugin while keeping its data leaves plugins/<slug>/data/ and its wjp_<slug>_* tables.
 * Uploading a zip with the same slug no longer reconnects to them silently: the backend answers
 * 409 `existing_plugin_data` with what it found, and this dialog asks the administrator which it is —
 * keep the data and reconnect the plugin to it, or discard it and install clean. The page then sends the
 * same zip again with that choice (`existingData`).
 */
import DialogLayer from "@/components/DialogLayer";
import { Button } from "@/components/ui";
import { FaDatabase } from "react-icons/fa";

export type ExistingDataChoice = "adopt" | "discard";

export interface ExistingDataPrompt {
    slug: string;
    dataDir: boolean;
    tables: string[];
}

/** The leftovers a 409 `existing_plugin_data` refusal reports, or null for any other error. */
export function existingDataFrom(error: unknown): ExistingDataPrompt | null {
    const e = error as { status?: number; code?: string; data?: Record<string, unknown> } | null;
    if (!e || e.status !== 409 || e.code !== "existing_plugin_data") return null;
    const data = e.data || {};
    const slug = typeof data.slug === "string" ? data.slug : "";
    if (!slug) return null;
    const tables = Array.isArray(data.tables) ? data.tables.filter((x): x is string => typeof x === "string") : [];
    return { slug, dataDir: data.dataDir === true, tables };
}

/** How many table names the dialog lists before summarising the rest as "+N". */
const SHOWN_TABLES = 8;

export default function ExistingDataDialog({ prompt, pending, onChoose, onCancel, t }: {
    prompt: ExistingDataPrompt;
    pending: ExistingDataChoice | null;
    onChoose: (choice: ExistingDataChoice) => void;
    onCancel: () => void;
    t: (key: string) => string;
}) {
    const shown = prompt.tables.slice(0, SHOWN_TABLES);
    const more = prompt.tables.length - shown.length;
    const busy = pending !== null;
    return (
        <DialogLayer className="bg-slate-950/40 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-300">
            <div role="dialog" aria-modal="true" aria-labelledby="existing-data-title" className="bg-white/95 backdrop-blur-lg rounded-[32px] p-8 max-w-md w-full shadow-[0_32px_64px_-16px_rgba(0,0,0,0.12)] border border-slate-200/50">
                <div className="flex items-center gap-4 mb-6">
                    <div className="w-14 h-14 rounded-2xl bg-amber-50 border border-amber-100 flex items-center justify-center flex-shrink-0 text-amber-600 shadow-sm">
                        <FaDatabase className="text-xl" />
                    </div>
                    <h3 id="existing-data-title" className="text-xl font-extrabold text-slate-900 min-w-0 break-words">
                        {t('plugins.existingData.title')}
                    </h3>
                </div>

                <div className="mb-6 text-slate-500 leading-relaxed space-y-3.5 text-xs font-semibold">
                    <p>{t('plugins.existingData.body').split('{slug}').join(prompt.slug)}</p>
                    <ul className="list-disc pl-5 space-y-1 text-slate-700">
                        {prompt.dataDir && <li>{t('plugins.existingData.dataDir')}</li>}
                        {prompt.tables.length > 0 && (
                            <li>
                                {t('plugins.existingData.tables').split('{count}').join(String(prompt.tables.length))}
                                <div className="mt-1 flex flex-wrap gap-1">
                                    {shown.map((name) => (
                                        <code key={name} className="text-[11px] font-mono bg-slate-100 px-1 py-0.5 rounded break-all">{name}</code>
                                    ))}
                                    {more > 0 && <span className="text-slate-500">+{more}</span>}
                                </div>
                            </li>
                        )}
                    </ul>
                    <p className="p-4 rounded-2xl border border-amber-200 bg-amber-50/50 text-amber-800 shadow-sm">
                        {t('plugins.existingData.warning')}
                    </p>
                </div>

                <div className="flex flex-wrap justify-end gap-3 pt-2">
                    <Button variant="ghost" size="md" onClick={onCancel} disabled={busy}>
                        {t('cancel')}
                    </Button>
                    <Button variant="danger" size="md" icon="fa-trash" onClick={() => onChoose('discard')}
                        disabled={busy && pending !== 'discard'} pending={pending === 'discard'} pendingLabel={t('plugins.existingData.working')}>
                        {t('plugins.existingData.discard')}
                    </Button>
                    <Button size="md" icon="fa-link" onClick={() => onChoose('adopt')}
                        disabled={busy && pending !== 'adopt'} pending={pending === 'adopt'} pendingLabel={t('plugins.existingData.working')}>
                        {t('plugins.existingData.adopt')}
                    </Button>
                </div>
            </div>
        </DialogLayer>
    );
}
