"use client";

/**
 * REGISTRO DE AUDITORÍA (/admin/audit) — visor de SOLO LECTURA del log append-only.
 *
 * Backend: GET /api/v1/audit (backend/src/routes/audit.ts) — `authenticate + isAdmin`, paginado,
 * más nuevo primero, y con el `detail` ya saneado de secretos por core/audit.sanitizeDetail. NO hay
 * ruta de escritura, actualización ni borrado, y esta pantalla no inventa ninguna: no lleva un solo
 * botón que mute nada, a propósito.
 *
 * Los nombres de los actores se resuelven contra /users (mismo permiso de administración) solo para
 * que la tabla se lea; si esa llamada falla, la fila sigue enseñando el id, que es lo que el log
 * guarda de verdad. La presentación (etiquetas, iconos, tonos) sale de ./auditLogic, con listas
 * blancas: un `action` desconocido se enseña como texto crudo y nunca elige clases ni estructura.
 */

import React, { useEffect, useState } from "react";
import { auditApi, usersApi, AuditEntry } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useI18n } from "@/contexts/I18nContext";
import { registerTranslations } from "@/lib/i18n";
import { PageHeader, Card, EmptyState } from "@/components/ui";
import {
    AuditTone,
    auditActionKey,
    auditActorLabel,
    auditDetailPairs,
    auditDetailSummary,
    auditPageRange,
    auditTargetIcon,
    auditTargetLabel,
    auditTone,
    formatAuditDate,
} from "./auditLogic";

registerTranslations({
    es: {
        "audit.title": "Auditoría",
        "audit.subtitle": "Registro de cambios sensibles (solo lectura)",
        "audit.entries": "eventos",
        "audit.column.date": "Fecha",
        "audit.column.actor": "Autor",
        "audit.column.action": "Acción",
        "audit.column.target": "Objetivo",
        "audit.column.detail": "Detalle",
        "audit.actor.system": "Sistema",
        "audit.detailShow": "Ver detalle",
        "audit.detailHide": "Ocultar detalle",
        "audit.detailEmpty": "Sin detalle registrado",
        "audit.emptyTitle": "Sin eventos registrados",
        "audit.emptyDescription": "Aquí aparecerán los cambios de usuarios, ajustes, temas y plugins en cuanto ocurran.",
        "audit.loadFailed": "No se pudo cargar el registro",
        "audit.forbiddenTitle": "Acceso restringido",
        "audit.forbiddenDescription": "El registro de auditoría es exclusivo de administradores.",
        "audit.range": "{from}–{to} de {total}",
        "audit.appendOnly": "El registro no se puede editar ni borrar: se escribe solo, y solo se añade.",
        "audit.action.user.create": "Usuario creado",
        "audit.action.user.role_change": "Rol cambiado",
        "audit.action.user.delete": "Usuario eliminado",
        "audit.action.settings.update": "Ajustes actualizados",
        "audit.action.plugin.activate": "Plugin activado",
        "audit.action.plugin.deactivate": "Plugin desactivado",
        "audit.action.theme.activate": "Tema activado",
        "audit.action.theme.mods.import": "Personalización de tema importada",
    },
    en: {
        "audit.title": "Audit trail",
        "audit.subtitle": "Log of sensitive changes (read-only)",
        "audit.entries": "events",
        "audit.column.date": "Date",
        "audit.column.actor": "Actor",
        "audit.column.action": "Action",
        "audit.column.target": "Target",
        "audit.column.detail": "Detail",
        "audit.actor.system": "System",
        "audit.detailShow": "View detail",
        "audit.detailHide": "Hide detail",
        "audit.detailEmpty": "No detail recorded",
        "audit.emptyTitle": "No events recorded",
        "audit.emptyDescription": "Changes to users, settings, themes and plugins will show up here as they happen.",
        "audit.loadFailed": "Could not load the log",
        "audit.forbiddenTitle": "Access restricted",
        "audit.forbiddenDescription": "The audit trail is administrators-only.",
        "audit.range": "{from}–{to} of {total}",
        "audit.appendOnly": "The log cannot be edited or deleted: it writes itself, and only ever appends.",
        "audit.action.user.create": "User created",
        "audit.action.user.role_change": "Role changed",
        "audit.action.user.delete": "User deleted",
        "audit.action.settings.update": "Settings updated",
        "audit.action.plugin.activate": "Plugin activated",
        "audit.action.plugin.deactivate": "Plugin deactivated",
        "audit.action.theme.activate": "Theme activated",
        "audit.action.theme.mods.import": "Theme customization imported",
    },
    pt: {
        "audit.title": "Auditoria",
        "audit.subtitle": "Registro de alterações sensíveis (somente leitura)",
        "audit.entries": "eventos",
        "audit.column.date": "Data",
        "audit.column.actor": "Autor",
        "audit.column.action": "Ação",
        "audit.column.target": "Alvo",
        "audit.column.detail": "Detalhe",
        "audit.actor.system": "Sistema",
        "audit.detailShow": "Ver detalhe",
        "audit.detailHide": "Ocultar detalhe",
        "audit.detailEmpty": "Sem detalhe registrado",
        "audit.emptyTitle": "Sem eventos registrados",
        "audit.emptyDescription": "As alterações de usuários, ajustes, temas e plugins aparecerão aqui assim que ocorrerem.",
        "audit.loadFailed": "Não foi possível carregar o registro",
        "audit.forbiddenTitle": "Acesso restrito",
        "audit.forbiddenDescription": "O registro de auditoria é exclusivo de administradores.",
        "audit.range": "{from}–{to} de {total}",
        "audit.appendOnly": "O registro não pode ser editado nem excluído: ele se escreve sozinho e apenas adiciona.",
        "audit.action.user.create": "Usuário criado",
        "audit.action.user.role_change": "Função alterada",
        "audit.action.user.delete": "Usuário excluído",
        "audit.action.settings.update": "Ajustes atualizados",
        "audit.action.plugin.activate": "Plugin ativado",
        "audit.action.plugin.deactivate": "Plugin desativado",
        "audit.action.theme.activate": "Tema ativado",
        "audit.action.theme.mods.import": "Personalização de tema importada",
    },
});

const PER_PAGE = 50;

/** Tono → clases. El token viene de un mapa CERRADO en auditLogic, así que aquí no entra nada libre. */
const TONE_CLASS: Record<AuditTone, string> = {
    danger: "text-red-600 bg-red-50",
    warn: "text-amber-600 bg-amber-50",
    info: "text-blue-600 bg-blue-50",
    neutral: "text-gray-500 bg-gray-100",
};

export default function AuditPage() {
    const { t } = useI18n();
    const { user } = useAuth();

    const [entries, setEntries] = useState<AuditEntry[]>([]);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(1);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expandedId, setExpandedId] = useState<number | null>(null);
    const [actorNames, setActorNames] = useState<Map<number, string>>(new Map());

    // El MISMO gate que el backend (middleware/permissions.isAdmin mira el rol, no una capability):
    // mientras `user` es null seguimos cargando, así que no se decide nada todavía.
    const forbidden = !!user && user.role !== "administrator";

    // Nombres de los actores: puro adorno legible. Un fallo aquí NO es un fallo de la pantalla — la
    // tabla sigue enseñando el id, que es el dato que el log guarda.
    const loadActors = async () => {
        try {
            const users = await usersApi.list();
            setActorNames(new Map(users.map((u) => [u.id, u.displayName || u.username])));
        } catch {
            /* silencio deliberado: ver arriba */
        }
    };

    const loadEntries = async (pageNum: number) => {
        setLoading(true);
        setError(null);
        try {
            const res = await auditApi.list({ page: pageNum, perPage: PER_PAGE });
            setEntries(res.data.entries || []);
            setTotal(res.data.total ?? res.total);
            setTotalPages(res.totalPages);
        } catch (e: any) {
            // El 403 lo evita el gate por rol de arriba; lo que llegue aquí es un fallo de verdad y se
            // enseña tal cual (apiGetPaged no adjunta .status, así que adivinarlo por el texto del
            // mensaje sería inventárselo).
            setError(e?.message || t("audit.loadFailed"));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (forbidden) return;
        loadActors();
    }, [forbidden]);

    useEffect(() => {
        if (forbidden) return;
        setExpandedId(null);
        loadEntries(page);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page, forbidden]);

    if (forbidden) {
        return (
            <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
                <PageHeader title={t("audit.title")} subtitle={t("audit.subtitle")} icon="fa-clipboard-list" />
                <Card variant="default" padding="none">
                    <EmptyState icon="fa-lock" title={t("audit.forbiddenTitle")} description={t("audit.forbiddenDescription")} />
                </Card>
            </div>
        );
    }

    const range = auditPageRange(page, PER_PAGE, total);

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title={t("audit.title")}
                subtitle={`${t("audit.subtitle")} · ${total} ${t("audit.entries")}`}
                icon="fa-clipboard-list"
            />

            <p className="mb-6 text-xs text-gray-400 flex items-center gap-2">
                <i className="fa-solid fa-lock text-gray-300"></i>
                {t("audit.appendOnly")}
            </p>

            <Card variant="default" padding="none">
                {loading ? (
                    <div className="p-20 text-center">
                        <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t("common.loading")}</p>
                    </div>
                ) : error ? (
                    <div className="p-20 text-center">
                        <i className="fa-solid fa-triangle-exclamation text-3xl text-amber-400 mb-4"></i>
                        <p className="text-gray-500 text-sm font-bold mb-2">{t("audit.loadFailed")}</p>
                        <p className="text-gray-400 text-xs">{error}</p>
                    </div>
                ) : entries.length === 0 ? (
                    <EmptyState icon="fa-clipboard-list" title={t("audit.emptyTitle")} description={t("audit.emptyDescription")} />
                ) : (
                    <>
                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-gray-200">
                                <thead className="bg-gray-50">
                                    <tr>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-44">
                                            {t("audit.column.date")}
                                        </th>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-40">
                                            {t("audit.column.actor")}
                                        </th>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-56">
                                            {t("audit.column.action")}
                                        </th>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-48">
                                            {t("audit.column.target")}
                                        </th>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                            {t("audit.column.detail")}
                                        </th>
                                        <th className="px-6 py-3 w-16"></th>
                                    </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                    {entries.map((entry) => {
                                        const actor = auditActorLabel(entry.actorId, actorNames);
                                        const actionKey = auditActionKey(entry.action);
                                        const tone = auditTone(entry.action);
                                        const summary = auditDetailSummary(entry.detail);
                                        const expanded = expandedId === entry.id;
                                        const pairs = expanded ? auditDetailPairs(entry.detail) : [];
                                        return (
                                            <React.Fragment key={entry.id}>
                                                <tr className="group hover:bg-blue-50/5 transition-colors align-top">
                                                    <td className="px-6 py-4 text-sm text-gray-500 whitespace-nowrap">
                                                        {formatAuditDate(entry.createdAt)}
                                                    </td>
                                                    <td className="px-6 py-4 text-sm">
                                                        {actor.kind === "system" ? (
                                                            <span className="text-[10px] font-black uppercase tracking-wider text-gray-500 bg-gray-100 px-2 py-1 rounded-md">
                                                                {t("audit.actor.system")}
                                                            </span>
                                                        ) : (
                                                            <span className={actor.kind === "named" ? "text-gray-700 font-medium break-words" : "text-gray-400 font-mono"}>
                                                                {actor.text}
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        {/* Acción conocida → etiqueta traducida; desconocida → identificador crudo COMO TEXTO. */}
                                                        <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-md ${TONE_CLASS[tone]}`}>
                                                            {actionKey ? t(actionKey) : entry.action}
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-4 text-sm text-gray-600">
                                                        <span className="inline-flex items-center gap-2 break-all">
                                                            <i className={`fa-solid ${auditTargetIcon(entry.targetType)} text-gray-300`}></i>
                                                            {auditTargetLabel(entry)}
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-4 text-sm text-gray-700">
                                                        {summary.pairs.length === 0 ? (
                                                            <span className="text-gray-300">—</span>
                                                        ) : (
                                                            <div className="flex flex-wrap gap-x-4 gap-y-1">
                                                                {summary.pairs.map((pair) => (
                                                                    <span key={pair.key} className="break-all">
                                                                        <span className="text-xs font-bold text-gray-400">{pair.key}:</span> {pair.value}
                                                                    </span>
                                                                ))}
                                                                {summary.rest > 0 && (
                                                                    <span className="text-xs text-gray-400 font-bold">+{summary.rest}</span>
                                                                )}
                                                            </div>
                                                        )}
                                                    </td>
                                                    <td className="px-6 py-4 text-right">
                                                        <button
                                                            onClick={() => setExpandedId(expanded ? null : entry.id)}
                                                            title={expanded ? t("audit.detailHide") : t("audit.detailShow")}
                                                            aria-label={expanded ? t("audit.detailHide") : t("audit.detailShow")}
                                                            aria-expanded={expanded}
                                                            className="w-9 h-9 rounded-xl bg-gray-50 text-gray-500 hover:bg-gray-200 flex items-center justify-center transition-all"
                                                        >
                                                            <i className={`fa-solid ${expanded ? "fa-chevron-up" : "fa-chevron-down"} text-xs`}></i>
                                                        </button>
                                                    </td>
                                                </tr>

                                                {expanded && (
                                                    <tr className="bg-gray-50/60">
                                                        <td colSpan={6} className="px-6 md:px-8 py-6 border-t border-gray-100">
                                                            {pairs.length === 0 ? (
                                                                <p className="text-sm text-gray-400">{t("audit.detailEmpty")}</p>
                                                            ) : (
                                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
                                                                    {pairs.map((pair) => (
                                                                        <div key={pair.key} className="bg-white rounded-xl px-4 py-3">
                                                                            <div className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1 break-all">
                                                                                {pair.key}
                                                                            </div>
                                                                            <div className="text-sm text-gray-700 whitespace-pre-wrap break-words">{pair.value}</div>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </td>
                                                    </tr>
                                                )}
                                            </React.Fragment>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        <div className="px-8 py-5 border-t border-gray-100/50 bg-gray-50/30 flex items-center justify-between gap-4">
                            <button
                                onClick={() => setPage((p) => Math.max(1, p - 1))}
                                disabled={page <= 1}
                                className="px-4 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-40 transition-all"
                            >
                                <i className="fa-solid fa-chevron-left mr-2"></i>
                                {t("table.previous")}
                            </button>
                            <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest text-center">
                                {t("audit.range")
                                    .replace("{from}", String(range.from))
                                    .replace("{to}", String(range.to))
                                    .replace("{total}", String(total))}
                            </span>
                            <button
                                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                                disabled={page >= totalPages}
                                className="px-4 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-40 transition-all"
                            >
                                {t("table.next")}
                                <i className="fa-solid fa-chevron-right ml-2"></i>
                            </button>
                        </div>
                    </>
                )}
            </Card>
        </div>
    );
}
