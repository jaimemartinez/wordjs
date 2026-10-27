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
import { PageHeader, Card, EmptyState, DataTable, Pagination } from "@/components/ui";
import AuditSettingsPanel from "./AuditSettingsPanel";
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
        "audit.appendOnly": "El registro no se puede editar: se escribe solo y solo se añade. Los eventos más antiguos que el periodo elegido se borran automáticamente una vez al día.",
        "audit.retention.label": "Conservar registros",
        "audit.retention.d90": "90 días",
        "audit.retention.d180": "6 meses",
        "audit.retention.d365": "1 año",
        "audit.retention.d730": "2 años",
        "audit.retention.forever": "Para siempre",
        "audit.retention.saved": "Periodo de conservación guardado",
        "audit.retention.failed": "No se pudo guardar el periodo de conservación",
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
        "audit.appendOnly": "The log cannot be edited: it writes itself and only ever appends. Events older than the chosen period are deleted automatically once a day.",
        "audit.retention.label": "Keep events for",
        "audit.retention.d90": "90 days",
        "audit.retention.d180": "6 months",
        "audit.retention.d365": "1 year",
        "audit.retention.d730": "2 years",
        "audit.retention.forever": "Forever",
        "audit.retention.saved": "Retention period saved",
        "audit.retention.failed": "Could not save the retention period",
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
        "audit.appendOnly": "O registro não pode ser editado: ele se escreve sozinho e apenas adiciona. Eventos mais antigos que o período escolhido são excluídos automaticamente uma vez por dia.",
        "audit.retention.label": "Manter registros por",
        "audit.retention.d90": "90 dias",
        "audit.retention.d180": "6 meses",
        "audit.retention.d365": "1 ano",
        "audit.retention.d730": "2 anos",
        "audit.retention.forever": "Para sempre",
        "audit.retention.saved": "Período de retenção salvo",
        "audit.retention.failed": "Não foi possível salvar o período de retenção",
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
            const users = (await usersApi.listPaged({ perPage: 100 })).data;
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
            <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
                <PageHeader title={t("audit.title")} subtitle={t("audit.subtitle")} icon="fa-clipboard-list" />
                <Card variant="default" padding="none">
                    <EmptyState icon="fa-lock" title={t("audit.forbiddenTitle")} description={t("audit.forbiddenDescription")} />
                </Card>
            </div>
        );
    }

    const range = auditPageRange(page, PER_PAGE, total);

    return (
        <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title={t("audit.title")}
                subtitle={`${t("audit.subtitle")} · ${total} ${t("audit.entries")}`}
                icon="fa-clipboard-list"
            />

            <p className="mb-6 text-xs text-gray-400 flex items-center gap-2">
                <i className="fa-solid fa-lock text-gray-300"></i>
                {t("audit.appendOnly")}
            </p>

            {/* Integrity (hash chain), retention and the external copy: AuditSettingsPanel (routes/audit.ts). */}
            <AuditSettingsPanel />

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
                        <DataTable
                            rows={entries}
                            rowKey={(entry) => entry.id}
                            caption={t("audit.title")}
                            rowLabel={(entry) => `${formatAuditDate(entry.createdAt)} ${entry.action}`}
                            actionsLabel={t("audit.detail")}
                            stackBelow="lg"
                            density="compact"
                            columns={[
                                {
                                    key: "date",
                                    header: t("audit.column.date"),
                                    className: "lg:whitespace-nowrap",
                                    cell: (entry) => <span className="text-sm text-gray-500">{formatAuditDate(entry.createdAt)}</span>,
                                },
                                {
                                    key: "actor",
                                    header: t("audit.column.actor"),
                                    cell: (entry) => {
                                        const actor = auditActorLabel(entry.actorId, actorNames);
                                        return actor.kind === "system" ? (
                                            <span className="text-[11px] font-black uppercase tracking-wider text-gray-500 bg-gray-100 px-2 py-1 rounded-md">
                                                {t("audit.actor.system")}
                                            </span>
                                        ) : (
                                            <span className={`text-sm ${actor.kind === "named" ? "text-gray-700 font-medium break-words" : "text-gray-500 font-mono break-all"}`}>
                                                {actor.text}
                                            </span>
                                        );
                                    },
                                },
                                {
                                    key: "action",
                                    header: t("audit.column.action"),
                                    primary: true,
                                    cell: (entry) => {
                                        const actionKey = auditActionKey(entry.action);
                                        // Known action → translated label; unknown → the raw identifier AS TEXT.
                                        return (
                                            <span className={`inline-block max-w-full text-[11px] font-black uppercase tracking-wider px-2 py-1 rounded-md wrap-anywhere ${TONE_CLASS[auditTone(entry.action)]}`}>
                                                {actionKey ? t(actionKey) : entry.action}
                                            </span>
                                        );
                                    },
                                },
                                {
                                    key: "target",
                                    header: t("audit.column.target"),
                                    cell: (entry) => (
                                        <span className="inline-flex items-center gap-2 max-w-full min-w-0 break-all lg:break-normal text-sm text-gray-600 lg:whitespace-nowrap">
                                            <i className={`fa-solid ${auditTargetIcon(entry.targetType)} text-gray-300`} aria-hidden="true"></i>
                                            {auditTargetLabel(entry)}
                                        </span>
                                    ),
                                },
                                {
                                    key: "detail",
                                    header: t("audit.column.detail"),
                                    showFrom: "xl",
                                    cell: (entry) => {
                                        const summary = auditDetailSummary(entry.detail);
                                        return summary.pairs.length === 0 ? (
                                            <span className="text-gray-300">—</span>
                                        ) : (
                                            <div className="flex flex-wrap justify-end lg:justify-start gap-x-4 gap-y-1 text-sm text-gray-700">
                                                {summary.pairs.map((pair) => (
                                                    <span key={pair.key} className="min-w-0 max-w-full break-words">
                                                        <span className="text-xs font-bold text-gray-500">{pair.key}:</span> {pair.value}
                                                    </span>
                                                ))}
                                                {summary.rest > 0 && (
                                                    <span className="text-xs text-gray-500 font-bold">+{summary.rest}</span>
                                                )}
                                            </div>
                                        );
                                    },
                                },
                            ]}
                            actions={(entry) => {
                                const expanded = expandedId === entry.id;
                                return [{
                                    key: "toggle",
                                    label: expanded ? t("audit.detailHide") : t("audit.detailShow"),
                                    icon: expanded ? "fa-chevron-up" : "fa-chevron-down",
                                    onClick: () => setExpandedId(expanded ? null : entry.id),
                                }];
                            }}
                            expandedRow={(entry) => {
                                if (expandedId !== entry.id) return null;
                                const pairs = auditDetailPairs(entry.detail);
                                return pairs.length === 0 ? (
                                    <p className="text-sm text-gray-500">{t("audit.detailEmpty")}</p>
                                ) : (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
                                        {pairs.map((pair) => (
                                            <div key={pair.key} className="bg-white rounded-xl px-4 py-3">
                                                <div className="text-[11px] font-black uppercase tracking-widest text-gray-500 mb-1 break-all">
                                                    {pair.key}
                                                </div>
                                                <div className="text-sm text-gray-700 whitespace-pre-wrap break-words">{pair.value}</div>
                                            </div>
                                        ))}
                                    </div>
                                );
                            }}
                        />

                        <Pagination
                            page={page}
                            totalPages={totalPages}
                            onChange={setPage}
                            label={t("audit.range").replace("{from}", String(range.from)).replace("{to}", String(range.to)).replace("{total}", String(total))}
                        />
                    </>
                )}
            </Card>
        </div>
    );
}
