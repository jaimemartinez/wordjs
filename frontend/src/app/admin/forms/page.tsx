"use client";

/**
 * Admin viewer for public form submissions (Webflow "Forms + submissions" parity).
 * Backend: GET /forms/submissions (paged, X-WP-Total headers), GET /forms/names,
 * DELETE /forms/submissions/:id — all gated on `manage_options`.
 */

import React, { useEffect, useState } from "react";
import { formsApi, FormSubmission, FormName } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { registerTranslations } from "@/lib/i18n";
import { PageHeader, Card, EmptyState } from "@/components/ui";

// The core dictionary (lib/i18n.ts) has no forms.* keys; register them through the same public
// runtime API plugins use, so this page can call t() exactly like its sibling admin pages.
registerTranslations({
    es: {
        "forms.title": "Formularios",
        "forms.subtitle": "Envíos recibidos desde los formularios del sitio",
        "forms.filterAll": "Todos",
        "forms.column.date": "Fecha",
        "forms.column.form": "Formulario",
        "forms.column.summary": "Contenido",
        "forms.column.page": "Página",
        "forms.pageRef": "Página",
        "forms.emptyTitle": "Sin envíos",
        "forms.emptyDescription": "Cuando un visitante envíe un formulario del sitio, aparecerá aquí.",
        "forms.loadFailed": "No se pudieron cargar los envíos",
        "forms.forbiddenTitle": "Acceso restringido",
        "forms.forbiddenDescription": "Necesitas el permiso de administración (manage_options) para ver los envíos de formularios.",
        "forms.detailFields": "Campos",
        "forms.detailShow": "Ver detalle",
        "forms.detailHide": "Ocultar detalle",
        "forms.deleteTitle": "Eliminar envío",
        "forms.deleteConfirm": "¿Eliminar este envío de forma permanente? Esta acción no se puede deshacer.",
        "forms.deleted": "Envío eliminado",
        "forms.deleteFailed": "No se pudo eliminar el envío",
        "forms.submissionsCount": "envíos",
    },
    en: {
        "forms.title": "Forms",
        "forms.subtitle": "Submissions received from the site's forms",
        "forms.filterAll": "All",
        "forms.column.date": "Date",
        "forms.column.form": "Form",
        "forms.column.summary": "Content",
        "forms.column.page": "Page",
        "forms.pageRef": "Page",
        "forms.emptyTitle": "No submissions",
        "forms.emptyDescription": "When a visitor submits a form on the site, it will show up here.",
        "forms.loadFailed": "Could not load submissions",
        "forms.forbiddenTitle": "Access restricted",
        "forms.forbiddenDescription": "You need the administration permission (manage_options) to view form submissions.",
        "forms.detailFields": "Fields",
        "forms.detailShow": "View detail",
        "forms.detailHide": "Hide detail",
        "forms.deleteTitle": "Delete submission",
        "forms.deleteConfirm": "Permanently delete this submission? This action cannot be undone.",
        "forms.deleted": "Submission deleted",
        "forms.deleteFailed": "Could not delete the submission",
        "forms.submissionsCount": "submissions",
    },
    pt: {
        "forms.title": "Formulários",
        "forms.subtitle": "Envios recebidos dos formulários do site",
        "forms.filterAll": "Todos",
        "forms.column.date": "Data",
        "forms.column.form": "Formulário",
        "forms.column.summary": "Conteúdo",
        "forms.column.page": "Página",
        "forms.pageRef": "Página",
        "forms.emptyTitle": "Sem envios",
        "forms.emptyDescription": "Quando um visitante enviar um formulário do site, ele aparecerá aqui.",
        "forms.loadFailed": "Não foi possível carregar os envios",
        "forms.forbiddenTitle": "Acesso restrito",
        "forms.forbiddenDescription": "Você precisa da permissão de administração (manage_options) para ver os envios de formulários.",
        "forms.detailFields": "Campos",
        "forms.detailShow": "Ver detalhe",
        "forms.detailHide": "Ocultar detalhe",
        "forms.deleteTitle": "Excluir envio",
        "forms.deleteConfirm": "Excluir este envio permanentemente? Esta ação não pode ser desfeita.",
        "forms.deleted": "Envio excluído",
        "forms.deleteFailed": "Não foi possível excluir o envio",
        "forms.submissionsCount": "envios",
    },
});

const PER_PAGE = 20;
const SUMMARY_FIELDS = 3;
const SUMMARY_VALUE_LEN = 60;

// created_at arrives as the DB's "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker) — normalize so the
// browser parses it as UTC instead of local time; anything else (ISO) parses as-is.
const fmtDate = (v: string | null | undefined) => {
    if (!v) return "—";
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? new Date(ms).toLocaleString() : v;
};

const truncate = (s: string, len: number) => (s.length > len ? `${s.slice(0, len)}…` : s);

export default function FormsPage() {
    const { confirm } = useModal();
    const { addToast } = useToast();
    const { t } = useI18n();

    const [names, setNames] = useState<FormName[]>([]);
    const [filter, setFilter] = useState<string | null>(null); // null = all forms
    const [submissions, setSubmissions] = useState<FormSubmission[]>([]);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(1);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [forbidden, setForbidden] = useState(false);
    const [expandedId, setExpandedId] = useState<number | null>(null);
    const [deletingId, setDeletingId] = useState<number | null>(null);

    const loadNames = async () => {
        try {
            const { names } = await formsApi.names();
            setNames(names);
        } catch (e: any) {
            // apiGet attaches .status — a 403 here means the whole viewer is off-limits.
            if (e?.status === 403) setForbidden(true);
        }
    };

    const loadSubmissions = async (formName: string | null, pageNum: number) => {
        setLoading(true);
        setError(null);
        try {
            const res = await formsApi.listSubmissions({
                formName: formName ?? undefined,
                page: pageNum,
                perPage: PER_PAGE,
            });
            setSubmissions(res.data);
            setTotal(res.total);
            setTotalPages(res.totalPages);
        } catch (e: any) {
            if (e?.status === 403) setForbidden(true);
            else setError(e?.message || t("forms.loadFailed"));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadNames();
    }, []);

    useEffect(() => {
        loadSubmissions(filter, page);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filter, page]);

    const selectFilter = (name: string | null) => {
        setFilter(name);
        setPage(1);
        setExpandedId(null);
    };

    const remove = async (s: FormSubmission) => {
        if (!(await confirm(t("forms.deleteConfirm"), t("forms.deleteTitle"), true))) return;
        setDeletingId(s.id);
        try {
            await formsApi.removeSubmission(s.id);
            addToast(t("forms.deleted"), "success");
            if (expandedId === s.id) setExpandedId(null);
            // Deleting the last row of a later page: step back (the effect reloads); otherwise reload in place.
            if (submissions.length === 1 && page > 1) setPage((p) => p - 1);
            else await loadSubmissions(filter, page);
            loadNames(); // counts on the filter chips changed
        } catch (e: any) {
            addToast(e?.message || t("forms.deleteFailed"), "error");
        } finally {
            setDeletingId(null);
        }
    };

    const totalAll = names.reduce((sum, n) => sum + n.count, 0);

    if (forbidden) {
        return (
            <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
                <PageHeader title={t("forms.title")} subtitle={t("forms.subtitle")} icon="fa-envelope-open-text" />
                <Card variant="default" padding="none">
                    <EmptyState icon="fa-lock" title={t("forms.forbiddenTitle")} description={t("forms.forbiddenDescription")} />
                </Card>
            </div>
        );
    }

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title={t("forms.title")}
                subtitle={`${t("forms.subtitle")} · ${total} ${t("forms.submissionsCount")}`}
                icon="fa-envelope-open-text"
            />

            {/* Form filter chips (from /forms/names, with counts) */}
            <div className="flex flex-wrap gap-2 mb-8">
                <button
                    type="button"
                    onClick={() => selectFilter(null)}
                    className={`text-xs font-bold px-4 py-2.5 rounded-xl border-2 transition-all ${filter === null ? "bg-blue-500 border-blue-500 text-white shadow-sm" : "bg-white border-gray-100 text-gray-500 hover:border-blue-200"}`}
                >
                    {t("forms.filterAll")}
                    <span className={`ml-2 text-[10px] font-black px-1.5 py-0.5 rounded-md ${filter === null ? "bg-white/20" : "bg-gray-100 text-gray-400"}`}>{totalAll}</span>
                </button>
                {names.map((n) => {
                    const on = filter === n.formName;
                    return (
                        <button
                            key={n.formName}
                            type="button"
                            onClick={() => selectFilter(n.formName)}
                            className={`text-xs font-bold px-4 py-2.5 rounded-xl border-2 transition-all ${on ? "bg-blue-500 border-blue-500 text-white shadow-sm" : "bg-white border-gray-100 text-gray-500 hover:border-blue-200"}`}
                        >
                            {n.formName}
                            <span className={`ml-2 text-[10px] font-black px-1.5 py-0.5 rounded-md ${on ? "bg-white/20" : "bg-gray-100 text-gray-400"}`}>{n.count}</span>
                        </button>
                    );
                })}
            </div>

            <Card variant="default" padding="none">
                {loading ? (
                    <div className="p-20 text-center">
                        <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t("common.loading")}</p>
                    </div>
                ) : error ? (
                    <div className="p-20 text-center">
                        <i className="fa-solid fa-triangle-exclamation text-3xl text-amber-400 mb-4"></i>
                        <p className="text-gray-500 text-sm font-bold mb-2">{t("forms.loadFailed")}</p>
                        <p className="text-gray-400 text-xs">{error}</p>
                    </div>
                ) : submissions.length === 0 ? (
                    <EmptyState icon="fa-envelope-open-text" title={t("forms.emptyTitle")} description={t("forms.emptyDescription")} />
                ) : (
                    <>
                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-gray-200">
                                <thead className="bg-gray-50">
                                    <tr>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-44">{t("forms.column.date")}</th>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-44">{t("forms.column.form")}</th>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{t("forms.column.summary")}</th>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-32">{t("forms.column.page")}</th>
                                        <th className="px-6 py-3 w-28"></th>
                                    </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                    {submissions.map((s) => {
                                        const entries = Object.entries(s.fields);
                                        const expanded = expandedId === s.id;
                                        return (
                                            <React.Fragment key={s.id}>
                                                <tr className="group hover:bg-blue-50/5 transition-colors">
                                                    <td className="px-6 py-4 text-sm text-gray-500 whitespace-nowrap">{fmtDate(s.createdAt)}</td>
                                                    <td className="px-6 py-4">
                                                        <span className="text-[10px] font-black uppercase tracking-wider text-indigo-600 bg-indigo-50 px-2 py-1 rounded-md">{s.formName}</span>
                                                    </td>
                                                    <td className="px-6 py-4 text-sm text-gray-700">
                                                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                                                            {entries.slice(0, SUMMARY_FIELDS).map(([k, v]) => (
                                                                <span key={k} className="break-all">
                                                                    <span className="text-xs font-bold text-gray-400">{truncate(k, 24)}:</span>{" "}
                                                                    {truncate(v, SUMMARY_VALUE_LEN) || "—"}
                                                                </span>
                                                            ))}
                                                            {entries.length > SUMMARY_FIELDS && (
                                                                <span className="text-xs text-gray-400 font-bold">+{entries.length - SUMMARY_FIELDS}</span>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td className="px-6 py-4 text-sm">
                                                        {s.pageId != null ? (
                                                            <a href={`/admin/pages/${s.pageId}`} className="text-blue-600 hover:text-blue-800 hover:underline whitespace-nowrap">
                                                                {t("forms.pageRef")} #{s.pageId}
                                                            </a>
                                                        ) : (
                                                            <span className="text-gray-300">—</span>
                                                        )}
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <div className="flex items-center justify-end gap-2">
                                                            <button
                                                                onClick={() => setExpandedId(expanded ? null : s.id)}
                                                                title={expanded ? t("forms.detailHide") : t("forms.detailShow")}
                                                                className="w-9 h-9 rounded-xl bg-gray-50 text-gray-500 hover:bg-gray-200 flex items-center justify-center transition-all"
                                                            >
                                                                <i className={`fa-solid ${expanded ? "fa-chevron-up" : "fa-chevron-down"} text-xs`}></i>
                                                            </button>
                                                            <button
                                                                onClick={() => remove(s)}
                                                                disabled={deletingId === s.id}
                                                                title={t("common.delete")}
                                                                className="w-9 h-9 rounded-xl bg-gray-50 text-gray-400 hover:bg-red-600 hover:text-white flex items-center justify-center transition-all disabled:opacity-50"
                                                            >
                                                                <i className={`fa-solid ${deletingId === s.id ? "fa-spinner fa-spin" : "fa-trash"} text-xs`}></i>
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                                {expanded && (
                                                    <tr className="bg-gray-50/60">
                                                        <td colSpan={5} className="px-6 md:px-8 py-6 border-t border-gray-100">
                                                            <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-4">{t("forms.detailFields")}</h3>
                                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 mb-5">
                                                                {entries.map(([k, v]) => (
                                                                    <div key={k} className="bg-white rounded-xl px-4 py-3">
                                                                        <div className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1 break-all">{k}</div>
                                                                        <div className="text-sm text-gray-700 whitespace-pre-wrap break-words">{v || "—"}</div>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                            <div className="text-xs text-gray-400 flex flex-wrap gap-x-6 gap-y-1">
                                                                <span><i className="fa-solid fa-network-wired mr-1.5"></i>IP: <code className="font-mono">{s.ip || "—"}</code></span>
                                                                <span className="break-all"><i className="fa-solid fa-desktop mr-1.5"></i>User-Agent: <code className="font-mono">{s.userAgent || "—"}</code></span>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                )}
                                            </React.Fragment>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        {/* Pager (same chrome as ContentTable's) */}
                        {totalPages > 1 && (
                            <div className="px-8 py-5 border-t border-gray-100/50 bg-gray-50/30 flex items-center justify-between">
                                <button
                                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                                    disabled={page <= 1}
                                    className="px-4 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-40 transition-all"
                                >
                                    <i className="fa-solid fa-chevron-left mr-2"></i>{t("table.previous")}
                                </button>
                                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                    {t("table.pageOf").replace("{page}", String(page)).replace("{total}", String(totalPages))}
                                </span>
                                <button
                                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                                    disabled={page >= totalPages}
                                    className="px-4 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-40 transition-all"
                                >
                                    {t("table.next")}<i className="fa-solid fa-chevron-right ml-2"></i>
                                </button>
                            </div>
                        )}
                    </>
                )}
            </Card>
        </div>
    );
}
