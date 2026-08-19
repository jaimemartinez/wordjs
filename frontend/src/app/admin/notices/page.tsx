"use client";

/**
 * ADMIN NOTICES (/admin/notices) — the screen that was missing.
 *
 * Backend: GET /api/v1/notices and DELETE /api/v1/notices/:id (backend/src/routes/notices.ts),
 * both `authenticate + isAdmin`.
 *
 * WHY IT EXISTS (audit 2026-08-18 #30). The plugin CrashGuard writes an `admin_notices` entry when a
 * plugin is auto-disabled after three consecutive boot crashes — and nothing in the product ever read
 * it. The list endpoint was shadowed by `GET /settings/:key` (a permanent 403), and no page in
 * frontend/src called it in any case, so the feature never worked end to end. The administrator saw
 * their plugin disappear from the active list and never learned why; the option, autoloaded on every
 * boot, grew forever because the ids DELETE needs were unknowable. This closes both halves: the
 * explanation is readable, and each row is prunable.
 *
 * Messages are rendered as TEXT (see noticesLogic.noticeText). CrashGuard stores HTML in them and one
 * of the interpolated values is a plugin directory name — dangerouslySetInnerHTML here would be a
 * stored-XSS sink in the most privileged screen in the product.
 */

import React, { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useI18n } from "@/contexts/I18nContext";
import { registerTranslations } from "@/lib/i18n";
import { PageHeader, Card, EmptyState } from "@/components/ui";
import {
    AdminNotice,
    NoticeTone,
    formatNoticeDate,
    noticeTone,
    normalizeNotices,
} from "./noticesLogic";

registerTranslations({
    es: {
        "notices.title": "Avisos",
        "notices.subtitle": "Mensajes persistentes del sistema",
        "notices.count": "avisos",
        "notices.dismiss": "Descartar",
        "notices.dismissing": "Descartando…",
        "notices.emptyTitle": "No hay avisos",
        "notices.emptyDescription": "Aquí aparecerá, por ejemplo, la explicación de por qué un plugin se desactivó solo tras fallar tres arranques seguidos.",
        "notices.loadFailed": "No se pudieron cargar los avisos",
        "notices.dismissFailed": "No se pudo descartar el aviso",
        "notices.forbiddenTitle": "Acceso restringido",
        "notices.forbiddenDescription": "Los avisos del sistema son exclusivos de administradores.",
        "notices.explanation": "Descartar un aviso lo borra para todos los administradores: es un mensaje del sitio, no una notificación personal.",
    },
    en: {
        "notices.title": "Notices",
        "notices.subtitle": "Persistent system messages",
        "notices.count": "notices",
        "notices.dismiss": "Dismiss",
        "notices.dismissing": "Dismissing…",
        "notices.emptyTitle": "No notices",
        "notices.emptyDescription": "This is where you will find, for example, why a plugin disabled itself after three failed boots in a row.",
        "notices.loadFailed": "Could not load the notices",
        "notices.dismissFailed": "Could not dismiss the notice",
        "notices.forbiddenTitle": "Access restricted",
        "notices.forbiddenDescription": "System notices are administrators-only.",
        "notices.explanation": "Dismissing a notice removes it for every administrator: it is a site message, not a personal notification.",
    },
    pt: {
        "notices.title": "Avisos",
        "notices.subtitle": "Mensagens persistentes do sistema",
        "notices.count": "avisos",
        "notices.dismiss": "Descartar",
        "notices.dismissing": "Descartando…",
        "notices.emptyTitle": "Sem avisos",
        "notices.emptyDescription": "Aqui aparecerá, por exemplo, a explicação de por que um plugin se desativou sozinho após três inicializações com falha.",
        "notices.loadFailed": "Não foi possível carregar os avisos",
        "notices.dismissFailed": "Não foi possível descartar o aviso",
        "notices.forbiddenTitle": "Acesso restrito",
        "notices.forbiddenDescription": "Os avisos do sistema são exclusivos de administradores.",
        "notices.explanation": "Descartar um aviso o remove para todos os administradores: é uma mensagem do site, não uma notificação pessoal.",
    },
});

/** Tone → classes. The token comes from a CLOSED map in noticesLogic, so nothing free-form gets here. */
const TONE_CLASS: Record<NoticeTone, { border: string; icon: string; chip: string; glyph: string }> = {
    danger: { border: "border-l-4 border-red-500", icon: "text-red-500", chip: "bg-red-50 text-red-600", glyph: "fa-circle-exclamation" },
    warn: { border: "border-l-4 border-amber-500", icon: "text-amber-500", chip: "bg-amber-50 text-amber-600", glyph: "fa-triangle-exclamation" },
    info: { border: "border-l-4 border-blue-500", icon: "text-blue-500", chip: "bg-blue-50 text-blue-600", glyph: "fa-circle-info" },
    neutral: { border: "border-l-4 border-gray-300", icon: "text-gray-400", chip: "bg-gray-100 text-gray-500", glyph: "fa-bell" },
};

export default function NoticesPage() {
    const { t } = useI18n();
    const { user } = useAuth();

    const [notices, setNotices] = useState<AdminNotice[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [dismissingId, setDismissingId] = useState<string | null>(null);

    // The SAME gate the backend applies (middleware/permissions.isAdmin looks at the ROLE, not a
    // capability). While `user` is still null nothing has been decided, so we keep loading.
    const forbidden = !!user && user.role !== "administrator";

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const raw = await apiGet<unknown>("/notices");
            setNotices(normalizeNotices(raw));
        } catch (e: any) {
            setError(e?.message || t("notices.loadFailed"));
        } finally {
            setLoading(false);
        }
    }, [t]);

    useEffect(() => {
        if (forbidden) return;
        load();
    }, [forbidden, load]);

    const dismiss = async (id: string) => {
        setDismissingId(id);
        setError(null);
        try {
            await apiDelete(`/notices/${encodeURIComponent(id)}`);
            // Drop it locally instead of refetching: the DELETE is idempotent and already told us it
            // succeeded, and a refetch would make a dismissal feel slower than it is.
            setNotices((prev) => prev.filter((n) => n.id !== id));
        } catch (e: any) {
            setError(e?.message || t("notices.dismissFailed"));
        } finally {
            setDismissingId(null);
        }
    };

    if (forbidden) {
        return (
            <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
                <PageHeader title={t("notices.title")} subtitle={t("notices.subtitle")} icon="fa-bell" />
                <Card variant="default" padding="none">
                    <EmptyState icon="fa-lock" title={t("notices.forbiddenTitle")} description={t("notices.forbiddenDescription")} />
                </Card>
            </div>
        );
    }

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title={t("notices.title")}
                subtitle={`${t("notices.subtitle")} · ${notices.length} ${t("notices.count")}`}
                icon="fa-bell"
            />

            <p className="mb-6 text-xs text-gray-400 flex items-center gap-2">
                <i className="fa-solid fa-users text-gray-300"></i>
                {t("notices.explanation")}
            </p>

            {error && (
                <div className="mb-6 rounded-2xl bg-amber-50 border border-amber-200 px-5 py-4 text-sm text-amber-700" role="alert">
                    <i className="fa-solid fa-triangle-exclamation mr-2"></i>
                    {error}
                </div>
            )}

            <Card variant="default" padding="none">
                {loading ? (
                    <div className="p-20 text-center">
                        <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t("common.loading")}</p>
                    </div>
                ) : notices.length === 0 ? (
                    <EmptyState icon="fa-bell-slash" title={t("notices.emptyTitle")} description={t("notices.emptyDescription")} />
                ) : (
                    <ul className="divide-y divide-gray-100">
                        {notices.map((notice) => {
                            const tone = TONE_CLASS[noticeTone(notice.type)];
                            const when = formatNoticeDate(notice.timestamp);
                            return (
                                <li key={notice.id} className={`flex items-start gap-4 px-6 py-5 ${tone.border}`}>
                                    <i className={`fa-solid ${tone.glyph} ${tone.icon} mt-1`} aria-hidden="true"></i>
                                    <div className="flex-1 min-w-0">
                                        {/* TEXT node, deliberately: see the file header. */}
                                        <p className="text-sm text-gray-700 leading-relaxed break-words">{notice.message}</p>
                                        <div className="mt-2 flex items-center gap-3 text-xs text-gray-400">
                                            <span className={`px-2 py-0.5 rounded-full font-semibold ${tone.chip}`}>{notice.type}</span>
                                            {when && <span>{when}</span>}
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => dismiss(notice.id)}
                                        disabled={dismissingId === notice.id}
                                        className="shrink-0 text-xs font-semibold text-gray-400 hover:text-gray-700 disabled:opacity-50 transition-colors"
                                    >
                                        <i className="fa-solid fa-xmark mr-1"></i>
                                        {dismissingId === notice.id ? t("notices.dismissing") : t("notices.dismiss")}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </Card>
        </div>
    );
}
