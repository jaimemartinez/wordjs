"use client";

import { useEffect, useState } from "react";
import DialogLayer from "@/components/DialogLayer";
import { themesApi, type ThemeDoctorReport } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";

/**
 * Themes → Check theme: the panel path for `node backend/cli/wordjs.js doctor <slug>`. Runs the theme
 * doctor (backend core/theme-doctor, GET /themes/:slug/doctor) and lists what it found: errors that
 * break the theme, warnings — among them every text/background pair below WCAG AA — and notes.
 */
export default function ThemeCheckDialog({ slug, name, onClose }: { slug: string; name: string; onClose: () => void }) {
    const { t } = useI18n();
    const [report, setReport] = useState<ThemeDoctorReport | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        themesApi.doctor(slug).then(setReport).catch((e: any) => setError(e?.message || t("themes.check.failed")));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slug]);

    const section = (title: string, icon: string, tone: string, items: ThemeDoctorReport["errors"]) => items.length > 0 && (
        <div>
            <p className={`text-xs font-bold uppercase tracking-wide ${tone}`}><i className={`fa-solid ${icon} mr-2`} aria-hidden="true"></i>{title} ({items.length})</p>
            <ul className="mt-2 space-y-1 text-sm text-gray-700">
                {items.map((f, i) => <li key={`${f.code}-${i}`} className="break-words"><span className="font-mono text-xs text-gray-400 mr-2">{f.code}</span>{f.message}</li>)}
            </ul>
        </div>
    );

    return (
        <DialogLayer className="bg-slate-950/40 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-300">
            <div role="dialog" aria-modal="true" aria-labelledby="theme-check-title" data-testid="theme-check-dialog"
                className="bg-white rounded-[32px] max-w-2xl w-full shadow-2xl border border-slate-200/50 p-6 sm:p-8 space-y-5 max-h-[85dvh] overflow-y-auto">
                <h2 id="theme-check-title" className="text-xl font-bold text-gray-900 flex items-center gap-3">
                    <i className="fa-solid fa-stethoscope text-blue-600" aria-hidden="true"></i>{t("themes.check.title").replace("{name}", name)}
                </h2>
                {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
                {!report && !error && <p className="text-sm text-gray-500">{t("loading")}</p>}
                {report && !report.available && <p className="text-sm text-gray-600">{t("themes.check.unavailable")}</p>}
                {report && report.available && (
                    <>
                        {report.errors.length === 0 && report.warnings.length === 0 ? (
                            <p className="text-sm font-bold text-emerald-700" data-testid="theme-check-clean"><i className="fa-solid fa-circle-check mr-2" aria-hidden="true"></i>{t("themes.check.clean")}</p>
                        ) : (
                            <p className="text-sm text-gray-600">{t("themes.check.summary").replace("{errors}", String(report.errors.length)).replace("{warnings}", String(report.warnings.length))}</p>
                        )}
                        {section(t("themes.check.errors"), "fa-circle-xmark", "text-red-600", report.errors)}
                        {section(t("themes.check.warnings"), "fa-triangle-exclamation", "text-amber-600", report.warnings)}
                        {section(t("themes.check.notes"), "fa-circle-info", "text-gray-500", report.info)}
                    </>
                )}
                <div className="flex justify-end">
                    <button type="button" onClick={onClose} className="px-5 py-3 rounded-xl bg-gray-900 text-white font-bold text-sm">{t("close")}</button>
                </div>
            </div>
        </DialogLayer>
    );
}
