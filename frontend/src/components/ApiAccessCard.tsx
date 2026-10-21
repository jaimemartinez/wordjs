"use client";

/**
 * Where a developer finds the API from the panel: the REST reference (Swagger UI), the GraphQL endpoint
 * and — for an administrator — the GraphQL introspection switch. Introspection could only be turned on
 * with `PUT /settings {graphql_introspection}` and nothing in the panel mentioned GraphQL or the docs.
 */

import { useEffect, useState } from "react";
import { settingsApi } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { Card } from "@/components/ui";
import { optionEnabled } from "@/lib/optionFlags";
import { withServerReason } from "@/lib/errorText";

const API_PREFIX = "/api/v1";

export default function ApiAccessCard() {
    const { t } = useI18n();
    const { can } = useAuth();
    const { addToast } = useToast();
    const isAdmin = can("manage_options");
    // null until read; `undefined` stored value = the default (on in development, off in production).
    const [introspection, setIntrospection] = useState<boolean | null>(null);
    const [explicit, setExplicit] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!isAdmin) return;
        settingsApi.getAll()
            .then((s) => {
                const raw = (s as Record<string, unknown>).graphql_introspection;
                setExplicit(raw !== undefined && raw !== null && raw !== "");
                setIntrospection(optionEnabled(raw, false));
            })
            .catch(() => setIntrospection(false));
    }, [isAdmin]);

    const toggle = async () => {
        if (introspection === null) return;
        const next = !introspection;
        setSaving(true);
        try {
            await settingsApi.update({ graphql_introspection: next ? "1" : "0" });
            setIntrospection(next);
            setExplicit(true);
            addToast(t("apiAccess.saved"), "success");
        } catch (e: unknown) {
            addToast(withServerReason(t("apiAccess.saveFailed"), e), "error");
        } finally {
            setSaving(false);
        }
    };

    return (
        <Card variant="default" padding="lg" className="h-fit">
            <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2">
                <i className="fa-solid fa-code text-blue-500" aria-hidden="true"></i>
                {t("apiAccess.title")}
            </h2>
            <ul className="space-y-3 text-sm">
                <li className="flex items-start gap-3">
                    <i className="fa-solid fa-book text-gray-300 w-4 text-center mt-1 shrink-0" aria-hidden="true"></i>
                    <span className="min-w-0">
                        <a href={`${API_PREFIX}/docs`} target="_blank" rel="noopener noreferrer" className="font-bold text-blue-600 hover:underline">
                            {t("apiAccess.restDocs")}
                        </a>
                        <span className="block text-xs text-gray-500">{t("apiAccess.restDocsHelp")}</span>
                    </span>
                </li>
                <li className="flex items-start gap-3">
                    <i className="fa-solid fa-diagram-project text-gray-300 w-4 text-center mt-1 shrink-0" aria-hidden="true"></i>
                    <span className="min-w-0">
                        <span className="font-bold text-gray-700">{t("apiAccess.graphql")}</span>{" "}
                        <code className="text-xs font-mono text-gray-500 break-all">{API_PREFIX}/graphql</code>
                        <span className="block text-xs text-gray-500">{t("apiAccess.graphqlHelp")}</span>
                    </span>
                </li>
            </ul>
            {isAdmin && (
                <div className="mt-5 border-t border-gray-100 pt-4 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <p className="text-sm font-bold text-gray-700">{t("apiAccess.introspection")}</p>
                        <p className="text-xs text-gray-500 leading-relaxed">
                            {t("apiAccess.introspectionHelp")}
                            {!explicit && introspection !== null && <> {t("apiAccess.introspectionDefault")}</>}
                        </p>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={!!introspection}
                        aria-label={t("apiAccess.introspection")}
                        disabled={saving || introspection === null}
                        onClick={toggle}
                        className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-60 ${introspection ? "bg-blue-600" : "bg-gray-200"}`}
                    >
                        <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform duration-200 ease-in-out ${introspection ? "translate-x-6" : "translate-x-1"}`} />
                    </button>
                </div>
            )}
        </Card>
    );
}
