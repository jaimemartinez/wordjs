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
import { PageHeader, Card, EmptyState, DataTable, Pagination, UnstyledButton } from "@/components/ui";

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
            <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
                <PageHeader title={t("forms.title")} subtitle={t("forms.subtitle")} icon="fa-envelope-open-text" />
                <Card variant="default" padding="none">
                    <EmptyState icon="fa-lock" title={t("forms.forbiddenTitle")} description={t("forms.forbiddenDescription")} />
                </Card>
            </div>
        );
    }

    return (
        <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title={t("forms.title")}
                subtitle={`${t("forms.subtitle")} · ${total} ${t("forms.submissionsCount")}`}
                icon="fa-envelope-open-text"
            />

            {/* Form filter chips (from /forms/names, with counts) */}
            <div className="flex flex-wrap gap-2 mb-8">
                <UnstyledButton
                    type="button"
                    aria-pressed={filter === null}
                    onClick={() => selectFilter(null)}
                    className={`text-xs font-bold px-4 py-2.5 rounded-xl border-2 transition-all ${filter === null ? "bg-blue-500 border-blue-500 text-white shadow-sm" : "bg-white border-gray-100 text-gray-500 hover:border-blue-200"}`}
                >
                    {t("forms.filterAll")}
                    <span className={`ml-2 text-[11px] font-black px-1.5 py-0.5 rounded-md ${filter === null ? "bg-white/20" : "bg-gray-100 text-gray-400"}`}>{totalAll}</span>
                </UnstyledButton>
                {names.map((n) => {
                    const on = filter === n.formName;
                    return (
                        <UnstyledButton
                            key={n.formName}
                            type="button"
                            aria-pressed={on}
                            onClick={() => selectFilter(n.formName)}
                            className={`text-xs font-bold px-4 py-2.5 rounded-xl border-2 transition-all ${on ? "bg-blue-500 border-blue-500 text-white shadow-sm" : "bg-white border-gray-100 text-gray-500 hover:border-blue-200"}`}
                        >
                            {n.formName}
                            <span className={`ml-2 text-[11px] font-black px-1.5 py-0.5 rounded-md ${on ? "bg-white/20" : "bg-gray-100 text-gray-400"}`}>{n.count}</span>
                        </UnstyledButton>
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
                        <DataTable
                            rows={submissions}
                            rowKey={(s) => s.id}
                            caption={t("forms.title")}
                            rowLabel={(s) => `${s.formName} ${fmtDate(s.createdAt)}`}
                            actionsLabel={t("actions")}
                            stackBelow="lg"
                            density="compact"
                            columns={[
                                {
                                    key: "date",
                                    header: t("forms.column.date"),
                                    className: "lg:whitespace-nowrap",
                                    cell: (s) => <span className="text-sm text-gray-500">{fmtDate(s.createdAt)}</span>,
                                },
                                {
                                    key: "form",
                                    header: t("forms.column.form"),
                                    primary: true,
                                    cell: (s) => <span className="inline-block text-[11px] font-black uppercase tracking-wider text-indigo-700 bg-indigo-50 px-2 py-1 rounded-md break-all">{s.formName}</span>,
                                },
                                {
                                    key: "summary",
                                    header: t("forms.column.summary"),
                                    cell: (s) => {
                                        const entries = Object.entries(s.fields);
                                        return (
                                            <div className="flex flex-wrap justify-end lg:justify-start gap-x-4 gap-y-1 text-sm text-gray-700">
                                                {entries.slice(0, SUMMARY_FIELDS).map(([k, v]) => (
                                                    <span key={k} className="break-all">
                                                        <span className="text-xs font-bold text-gray-500">{truncate(k, 24)}:</span>{" "}
                                                        {truncate(v, SUMMARY_VALUE_LEN) || "—"}
                                                    </span>
                                                ))}
                                                {entries.length > SUMMARY_FIELDS && (
                                                    <span className="text-xs text-gray-500 font-bold">+{entries.length - SUMMARY_FIELDS}</span>
                                                )}
                                            </div>
                                        );
                                    },
                                },
                                {
                                    key: "page",
                                    header: t("forms.column.page"),
                                    cell: (s) => s.pageId != null ? (
                                        <a href={`/admin/pages/${s.pageId}`} className="inline-flex items-center pointer-coarse:min-h-11 text-sm text-blue-600 hover:text-blue-800 hover:underline whitespace-nowrap">
                                            {t("forms.pageRef")} #{s.pageId}
                                        </a>
                                    ) : (
                                        <span className="text-gray-300">—</span>
                                    ),
                                },
                            ]}
                            actions={(s) => {
                                const expanded = expandedId === s.id;
                                return [
                                    { key: "toggle", label: expanded ? t("forms.detailHide") : t("forms.detailShow"), icon: expanded ? "fa-chevron-up" : "fa-chevron-down", onClick: () => setExpandedId(expanded ? null : s.id) },
                                    { key: "delete", label: t("common.delete"), icon: deletingId === s.id ? "fa-spinner fa-spin" : "fa-trash", onClick: () => remove(s), disabled: deletingId === s.id, tone: "danger" },
                                ];
                            }}
                            expandedRow={(s) => expandedId !== s.id ? null : (
                                <>
                                    <h3 className="text-[11px] font-black uppercase tracking-widest text-gray-500 mb-4">{t("forms.detailFields")}</h3>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 mb-5">
                                        {Object.entries(s.fields).map(([k, v]) => (
                                            <div key={k} className="bg-white rounded-xl px-4 py-3">
                                                <div className="text-[11px] font-black uppercase tracking-widest text-gray-500 mb-1 break-all">{k}</div>
                                                <div className="text-sm text-gray-700 whitespace-pre-wrap break-words">{v || "—"}</div>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="text-xs text-gray-500 flex flex-wrap gap-x-6 gap-y-1">
                                        <span><i className="fa-solid fa-network-wired mr-1.5" aria-hidden="true"></i>IP: <code className="font-mono">{s.ip || "—"}</code></span>
                                        <span className="break-all"><i className="fa-solid fa-desktop mr-1.5" aria-hidden="true"></i>User-Agent: <code className="font-mono">{s.userAgent || "—"}</code></span>
                                    </div>
                                </>
                            )}
                        />

                        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
                    </>
                )}
            </Card>
        </div>
    );
}
