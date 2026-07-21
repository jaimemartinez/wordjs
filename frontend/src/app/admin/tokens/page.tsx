"use client";

import { useEffect, useState } from "react";
import { tokensApi, ApiToken } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { PageHeader, Button, Card, EmptyState, Input, Select, StatusBadge } from "@/components/ui";
import SecretRevealModal from "@/components/SecretRevealModal";

const fmtDate = (v: number | null | string | undefined) => {
    if (v == null) return "—";
    const ms = typeof v === "number" ? v * 1000 : Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toLocaleDateString() : "—";
};

// Resources a token can be confined to (the URL segment after /api/v1). The backend accepts any resource
// slug, but these are the common ones a headless client scopes against; picking per-resource read/write
// yields a least-privilege token that can touch nothing else.
type ResAction = "none" | "read" | "write";
const RESOURCES: { slug: string; labelKey: string; icon: string }[] = [
    { slug: "posts", labelKey: "nav.posts", icon: "fa-newspaper" },
    { slug: "media", labelKey: "nav.media", icon: "fa-image" },
    { slug: "comments", labelKey: "nav.comments", icon: "fa-comments" },
    { slug: "categories", labelKey: "nav.categories", icon: "fa-folder" },
    { slug: "tags", labelKey: "posts.tags", icon: "fa-tags" },
    { slug: "menus", labelKey: "nav.menus", icon: "fa-bars" },
    { slug: "users", labelKey: "nav.users", icon: "fa-users" },
    { slug: "settings", labelKey: "nav.settings", icon: "fa-gear" },
];

const isExpired = (t: ApiToken) => t.expiresAt != null && t.expiresAt * 1000 <= Date.now();

export default function TokensPage() {
    const { confirm } = useModal();
    const { addToast } = useToast();
    const { t } = useI18n();
    const [tokens, setTokens] = useState<ApiToken[]>([]);
    const [loading, setLoading] = useState(true);
    const [name, setName] = useState("");
    const [scopeMode, setScopeMode] = useState<"read" | "write" | "custom">("read");
    const [resourceScopes, setResourceScopes] = useState<Record<string, ResAction>>({});
    const [expiry, setExpiry] = useState("");
    const [creating, setCreating] = useState(false);
    const [revealed, setRevealed] = useState<string | null>(null);

    const load = async () => {
        try {
            const { tokens } = await tokensApi.list();
            setTokens(tokens);
        } catch (e: any) {
            addToast(e?.message || t("tokens.loadFailed"), "error");
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => { load(); }, []);

    const setResScope = (slug: string, val: ResAction) =>
        setResourceScopes((prev) => ({ ...prev, [slug]: val }));

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        // Build the scope string: a global 'read'/'write', or a comma list of <resource>:<action> pairs.
        let scopes: string;
        if (scopeMode === "custom") {
            const parts = RESOURCES
                .map((r) => r.slug)
                .filter((slug) => resourceScopes[slug] && resourceScopes[slug] !== "none")
                .map((slug) => `${slug}:${resourceScopes[slug]}`);
            if (parts.length === 0) {
                addToast(t("tokens.customScopeRequired"), "error");
                return;
            }
            scopes = parts.join(",");
        } else {
            scopes = scopeMode;
        }
        setCreating(true);
        try {
            const res = await tokensApi.create({
                name: name.trim() || t("tokens.defaultName"),
                scopes,
                expiresInDays: expiry ? Number(expiry) : null,
            });
            setRevealed(res.token);
            setName("");
            setScopeMode("read");
            setResourceScopes({});
            setExpiry("");
            await load();
        } catch (e: any) {
            addToast(e?.message || t("tokens.createFailed"), "error");
        } finally {
            setCreating(false);
        }
    };

    const handleRevoke = async (tok: ApiToken) => {
        if (!(await confirm(t("tokens.revokeConfirm").replace("{name}", tok.name), t("tokens.revokeTitle"), true))) return;
        try {
            await tokensApi.revoke(tok.id);
            addToast(t("tokens.revoked"), "success");
            await load();
        } catch (e: any) {
            addToast(e?.message || t("tokens.revokeFailed"), "error");
        }
    };

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title={t("tokens.title")}
                subtitle={t("tokens.subtitle")}
                icon="fa-key"
            />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Create */}
                <Card variant="default" padding="lg" className="h-fit">
                    <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-6 flex items-center gap-2">
                        <i className="fa-solid fa-plus-circle text-blue-500"></i>
                        {t("tokens.newToken")}
                    </h2>
                    <form onSubmit={handleCreate} className="space-y-5">
                        <Input label={t("tokens.name")} icon="fa-tag" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("tokens.namePlaceholder")} />
                        <div>
                            <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">{t("tokens.scope")}</label>
                            <Select
                                value={scopeMode}
                                onChange={(v) => setScopeMode(v as "read" | "write" | "custom")}
                                options={[
                                    { value: "read", label: t("tokens.scopeReadAll") },
                                    { value: "write", label: t("tokens.scopeWriteAll") },
                                    { value: "custom", label: t("tokens.scopeCustom") },
                                ]}
                            />
                            {scopeMode === "custom" && (
                                <div className="mt-3 rounded-2xl border border-gray-100 bg-gray-50/40 p-3 space-y-1.5 max-h-64 overflow-auto">
                                    <p className="text-[10px] text-gray-400 leading-relaxed mb-1.5">
                                        {t("tokens.customHelp.pre")}<span className="font-bold">{t("tokens.customHelp.nothing")}</span>{t("tokens.customHelp.post")}
                                    </p>
                                    {RESOURCES.map((r) => {
                                        const cur = resourceScopes[r.slug] || "none";
                                        return (
                                            <div key={r.slug} className="flex items-center justify-between gap-2">
                                                <span className="text-xs font-bold text-gray-600 flex items-center gap-2">
                                                    <i className={`fa-solid ${r.icon} text-gray-300 w-4 text-center`}></i>{t(r.labelKey)}
                                                </span>
                                                <div className="flex rounded-lg overflow-hidden border border-gray-200 text-[10px] font-black uppercase tracking-wider">
                                                    {(["none", "read", "write"] as const).map((opt) => (
                                                        <button
                                                            type="button"
                                                            key={opt}
                                                            onClick={() => setResScope(r.slug, opt)}
                                                            aria-pressed={cur === opt}
                                                            className={`px-2.5 py-1 transition-colors ${cur === opt
                                                                ? opt === "write" ? "bg-blue-600 text-white"
                                                                    : opt === "read" ? "bg-blue-100 text-blue-700"
                                                                        : "bg-gray-200 text-gray-500"
                                                                : "bg-white text-gray-400 hover:bg-gray-50"}`}
                                                        >
                                                            {opt === "none" ? "—" : opt === "read" ? t("tokens.optRead") : t("tokens.optWrite")}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">{t("tokens.expires")}</label>
                            <Select
                                value={expiry}
                                onChange={setExpiry}
                                options={[
                                    { value: "", label: t("tokens.expiryNever") },
                                    { value: "30", label: t("tokens.expiry30") },
                                    { value: "90", label: t("tokens.expiry90") },
                                    { value: "365", label: t("tokens.expiry365") },
                                ]}
                            />
                        </div>
                        <Button type="submit" icon="fa-plus" className="w-full" loading={creating}>
                            {t("tokens.createToken")}
                        </Button>
                    </form>
                </Card>

                {/* List */}
                <div className="lg:col-span-2">
                    <Card variant="default" padding="none">
                        {loading ? (
                            <div className="p-20 text-center">
                                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                                <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t("common.loading")}</p>
                            </div>
                        ) : tokens.length === 0 ? (
                            <EmptyState icon="fa-key" title={t("tokens.emptyTitle")} description={t("tokens.emptyDescription")} />
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead>
                                        <tr className="border-b border-gray-100/50 bg-gray-50/30">
                                            {[
                                                { key: "token", label: t("tokens.colToken") },
                                                { key: "scopes", label: t("tokens.colScopes") },
                                                { key: "lastUsed", label: t("tokens.colLastUsed") },
                                                { key: "expires", label: t("tokens.colExpires") },
                                                { key: "status", label: t("tokens.colStatus") },
                                                { key: "actions", label: t("actions") },
                                            ].map((h, i) => (
                                                <th key={h.key} className={`px-6 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest ${i === 5 ? "text-right" : "text-left"}`}>{h.label}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-50">
                                        {tokens.map((tok) => {
                                            const expired = isExpired(tok);
                                            return (
                                                <tr key={tok.id} className="group hover:bg-blue-50/5 transition-colors">
                                                    <td className="px-6 py-5">
                                                        <div className="font-bold text-gray-700 italic tracking-tight">{tok.name}</div>
                                                        <code className="text-xs font-mono text-gray-400">{tok.tokenPrefix}…</code>
                                                    </td>
                                                    <td className="px-6 py-5">
                                                        <div className="flex flex-wrap gap-1">
                                                            {tok.scopes.map((s) => (
                                                                <span key={s} className="text-[10px] font-black uppercase tracking-wider text-blue-600 bg-blue-50 px-2 py-1 rounded-md">{s}</span>
                                                            ))}
                                                        </div>
                                                    </td>
                                                    <td className="px-6 py-5 text-sm text-gray-500">{fmtDate(tok.lastUsedAt)}</td>
                                                    <td className="px-6 py-5 text-sm text-gray-500">{tok.expiresAt == null ? t("tokens.expiryNever") : fmtDate(tok.expiresAt)}</td>
                                                    <td className="px-6 py-5">
                                                        {tok.revoked ? <StatusBadge status="error" label={t("tokens.statusRevoked")} />
                                                            : expired ? <StatusBadge status="neutral" label={t("tokens.statusExpired")} />
                                                                : <StatusBadge status="success" label={t("tokens.statusActive")} />}
                                                    </td>
                                                    <td className="px-6 py-5 text-right">
                                                        {!tok.revoked && (
                                                            <button
                                                                onClick={() => handleRevoke(tok)}
                                                                title={t("tokens.revoke")}
                                                                className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-red-600 hover:text-white flex items-center justify-center transition-all shadow-sm opacity-0 group-hover:opacity-100"
                                                            >
                                                                <i className="fa-solid fa-ban text-xs"></i>
                                                            </button>
                                                        )}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Card>
                </div>
            </div>

            <SecretRevealModal
                secret={revealed}
                title={t("tokens.secretTitle")}
                description={t("tokens.secretDescription")}
                onClose={() => setRevealed(null)}
            />
        </div>
    );
}
