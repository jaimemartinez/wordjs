"use client";

import { useEffect, useState } from "react";
import { agentsApi, usersApi, AgentCapability, AgentConnection, AuditEntry, User } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { PageHeader, Button, Card, EmptyState, Input, Select, StatusBadge } from "@/components/ui";
import DialogLayer from "@/components/DialogLayer";

/**
 * AI agent connections — the admin side of the MCP server (backend routes/agents.ts, routes/mcp.ts).
 *
 * The connection REQUESTS capabilities; only an administrator GRANTS them, and only a subset of the request.
 * Whatever is granted, every call runs as the bound user narrowed by the grant, so a grant beyond the
 * user's role is shown as inert (struck through) instead of promising something it cannot deliver.
 */

const CAP_ICONS: Record<AgentCapability, string> = {
    "content:read": "fa-book-open",
    "content:draft": "fa-pen-to-square",
    "content:publish": "fa-paper-plane",
    "media:upload": "fa-image",
    "taxonomy:write": "fa-tags",
    "comments:moderate": "fa-comments",
    "settings:read": "fa-circle-info",
};
const capKey = (c: string) => c.replace(":", "_");
// Mirrors the backend's IMPLIES table (core/agent-capabilities) so the form shows what will be stored.
const IMPLIES: Partial<Record<AgentCapability, AgentCapability[]>> = {
    "content:draft": ["content:read"],
    "content:publish": ["content:draft", "content:read"],
};
const withImplied = (set: Set<AgentCapability>) => {
    const out = new Set(set);
    for (const c of set) for (const i of IMPLIES[c] || []) out.add(i);
    return out;
};

const fmtDate = (v: number | string | null | undefined) => {
    if (v == null) return "—";
    const ms = typeof v === "number" ? v * 1000 : Date.parse(v.includes("T") || v.includes("Z") ? v : `${v.replace(" ", "T")}Z`);
    return Number.isFinite(ms) ? new Date(ms).toLocaleString() : "—";
};

const PLACEHOLDER = "<YOUR_wja_TOKEN>";
function claudeCodeCommand(url: string, token: string) {
    return `claude mcp add --transport http wordjs ${url} --header "Authorization: Bearer ${token}"`;
}
function jsonConfig(url: string, token: string) {
    return JSON.stringify({ mcpServers: { wordjs: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}

function CopyBlock({ label, text }: { label: string; text: string }) {
    const { t } = useI18n();
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { /* clipboard blocked — the text is selectable */ }
    };
    return (
        <div>
            <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">{label}</span>
                <button type="button" onClick={copy} className="text-[10px] font-black uppercase tracking-wider text-blue-600 hover:text-blue-800 flex items-center gap-1">
                    <i className={`fa-solid ${copied ? "fa-check" : "fa-copy"}`}></i>{copied ? t("agents.copied") : t("agents.copy")}
                </button>
            </div>
            <pre className="bg-gray-900 text-emerald-300 rounded-2xl px-4 py-3 font-mono text-xs whitespace-pre-wrap break-all select-all">{text}</pre>
        </div>
    );
}

function ConfigDialog({ url, token, title, description, onClose }: { url: string; token: string; title: string; description: string; onClose: () => void }) {
    const { t } = useI18n();
    return (
        <DialogLayer layer="dialogOver" className="flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div role="dialog" aria-modal="true" aria-label={title} className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full p-8 max-h-[90vh] overflow-auto animate-in zoom-in-95 duration-200">
                <div className="flex items-center gap-4 mb-4">
                    <div className="w-12 h-12 shrink-0 rounded-2xl bg-gradient-to-br from-violet-50 to-blue-50 flex items-center justify-center text-violet-600">
                        <i className="fa-solid fa-robot text-lg"></i>
                    </div>
                    <h2 className="text-xl font-black italic tracking-tighter text-gray-800">{title}</h2>
                </div>
                <p className="text-sm text-gray-500 mb-5 leading-relaxed">{description}</p>
                <div className="space-y-4">
                    {token !== PLACEHOLDER && <CopyBlock label="Token" text={token} />}
                    <CopyBlock label={t("agents.endpoint")} text={url} />
                    <CopyBlock label={t("agents.configClaudeCode")} text={claudeCodeCommand(url, token)} />
                    <CopyBlock label={t("agents.configJson")} text={jsonConfig(url, token)} />
                </div>
                <div className="mt-6 flex justify-end">
                    <Button onClick={onClose} icon="fa-check">{t("agents.done")}</Button>
                </div>
            </div>
        </DialogLayer>
    );
}

export default function AgentsPage() {
    const { confirm } = useModal();
    const { addToast } = useToast();
    const { t } = useI18n();
    const [connections, setConnections] = useState<AgentConnection[]>([]);
    const [vocabulary, setVocabulary] = useState<AgentCapability[]>([]);
    const [canGrant, setCanGrant] = useState(false);
    const [mcpUrl, setMcpUrl] = useState("");
    const [loading, setLoading] = useState(true);
    const [users, setUsers] = useState<User[]>([]);

    const [name, setName] = useState("");
    const [requested, setRequested] = useState<Set<AgentCapability>>(new Set(["content:read", "content:draft"]));
    const [boundUser, setBoundUser] = useState("");
    const [expiry, setExpiry] = useState("");
    const [creating, setCreating] = useState(false);
    const [reveal, setReveal] = useState<{ token: string; url: string; fresh: boolean } | null>(null);

    const [reviewing, setReviewing] = useState<number | null>(null);
    const [draftGrant, setDraftGrant] = useState<Set<AgentCapability>>(new Set());
    const [saving, setSaving] = useState(false);
    const [auditFor, setAuditFor] = useState<number | null>(null);
    const [audit, setAudit] = useState<AuditEntry[]>([]);

    const load = async () => {
        try {
            const res = await agentsApi.list();
            setConnections(res.connections);
            setVocabulary(res.capabilities);
            setCanGrant(res.canGrant);
            setMcpUrl(res.mcpUrl);
            if (res.canGrant && users.length === 0) {
                usersApi.list().then(setUsers).catch(() => { /* binding to another user stays unavailable */ });
            }
        } catch (e: any) {
            addToast(e?.message || t("agents.loadFailed"), "error");
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => { load(); }, []);

    const toggle = (set: Set<AgentCapability>, c: AgentCapability) => {
        const next = new Set(set);
        if (next.has(c)) next.delete(c); else next.add(c);
        return next;
    };

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (requested.size === 0) { addToast(t("agents.requestRequired"), "error"); return; }
        setCreating(true);
        try {
            const res = await agentsApi.create({
                name: name.trim() || "AI agent",
                requested: Array.from(requested),
                userId: boundUser ? Number(boundUser) : undefined,
                expiresInDays: expiry ? Number(expiry) : null,
            });
            setReveal({ token: res.token, url: res.mcpUrl, fresh: true });
            setName("");
            setExpiry("");
            setBoundUser("");
            await load();
            // An administrator creating a connection reviews it straight away.
            if (canGrant) startReview(res.connection);
        } catch (e: any) {
            addToast(e?.message || t("agents.createFailed"), "error");
        } finally {
            setCreating(false);
        }
    };

    const startReview = (c: AgentConnection) => {
        setReviewing(c.id);
        setDraftGrant(new Set(c.granted));
    };

    const saveGrant = async (c: AgentConnection) => {
        setSaving(true);
        try {
            await agentsApi.grant(c.id, Array.from(withImplied(draftGrant)).filter((g) => c.requested.includes(g)));
            addToast(t("agents.granted"), "success");
            setReviewing(null);
            await load();
            if (auditFor === c.id) await openAudit(c.id, true);
        } catch (e: any) {
            addToast(e?.message || t("agents.grantFailed"), "error");
        } finally {
            setSaving(false);
        }
    };

    const handleRevoke = async (c: AgentConnection) => {
        if (!(await confirm(t("agents.revokeConfirm").replace("{name}", c.name), t("agents.revokeTitle"), true))) return;
        try {
            await agentsApi.revoke(c.id);
            addToast(t("agents.revoked"), "success");
            await load();
            if (auditFor === c.id) await openAudit(c.id, true);
        } catch (e: any) {
            addToast(e?.message || t("agents.revokeFailed"), "error");
        }
    };

    const openAudit = async (id: number, keepOpen = false) => {
        if (auditFor === id && !keepOpen) { setAuditFor(null); return; }
        try {
            const res = await agentsApi.audit(id);
            setAudit(res.entries);
            setAuditFor(id);
        } catch (e: any) {
            addToast(e?.message || t("agents.auditLoadFailed"), "error");
        }
    };

    const statusOf = (c: AgentConnection) => c.status === "revoked" ? "revoked" : c.expired ? "expired" : c.status;
    const badge = (c: AgentConnection) => {
        const s = statusOf(c);
        // StatusBadge maps these names onto its colours (active → green, pending → amber, error → red).
        const kind = s === "revoked" ? "error" : s === "expired" ? "inactive" : s;
        return <StatusBadge status={kind} label={t(`agents.status.${s}`)} />;
    };

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader title={t("agents.title")} subtitle={t("agents.subtitle")} icon="fa-robot" />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <Card variant="default" padding="lg" className="h-fit">
                    <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-6 flex items-center gap-2">
                        <i className="fa-solid fa-plus-circle text-blue-500"></i>
                        {t("agents.newConnection")}
                    </h2>
                    <form onSubmit={handleCreate} className="space-y-5">
                        <Input label={t("agents.name")} icon="fa-tag" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("agents.namePlaceholder")} />
                        <fieldset>
                            <legend className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">{t("agents.requested")}</legend>
                            <p className="text-[11px] text-gray-400 leading-relaxed mb-2">{t("agents.requestedHelp")}</p>
                            <div className="space-y-1.5">
                                {vocabulary.map((c) => {
                                    const implied = !requested.has(c) && withImplied(requested).has(c);
                                    return (
                                        <label key={c} className={`flex items-start gap-3 rounded-xl border px-3 py-2 cursor-pointer transition-colors ${requested.has(c) || implied ? "border-blue-200 bg-blue-50/40" : "border-gray-100 hover:bg-gray-50"}`}>
                                            <input type="checkbox" className="mt-1" checked={requested.has(c) || implied} disabled={implied} onChange={() => setRequested(toggle(requested, c))} />
                                            <span>
                                                <span className="text-xs font-bold text-gray-700 flex items-center gap-2">
                                                    <i className={`fa-solid ${CAP_ICONS[c]} text-gray-300 w-4 text-center`}></i>{t(`agents.cap.${capKey(c)}`)}
                                                    <code className="text-[10px] font-mono text-gray-400">{c}</code>
                                                </span>
                                                <span className="block text-[11px] text-gray-400 leading-snug mt-0.5">{t(`agents.capHelp.${capKey(c)}`)}</span>
                                            </span>
                                        </label>
                                    );
                                })}
                            </div>
                        </fieldset>
                        {canGrant && users.length > 0 && (
                            <div>
                                <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">{t("agents.boundUser")}</label>
                                <Select
                                    value={boundUser}
                                    onChange={setBoundUser}
                                    options={[{ value: "", label: t("agents.boundUserSelf") }, ...users.map((u) => ({ value: String(u.id), label: `${u.displayName || u.username} (${u.role})` }))]}
                                />
                            </div>
                        )}
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
                        <Button type="submit" icon="fa-plus" className="w-full" loading={creating}>{t("agents.create")}</Button>
                    </form>
                </Card>

                <div className="lg:col-span-2 space-y-4">
                    {loading ? (
                        <Card variant="default" padding="none">
                            <div className="p-20 text-center">
                                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                                <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t("common.loading")}</p>
                            </div>
                        </Card>
                    ) : connections.length === 0 ? (
                        <Card variant="default" padding="none">
                            <EmptyState icon="fa-robot" title={t("agents.emptyTitle")} description={t("agents.emptyDescription")} />
                        </Card>
                    ) : connections.map((c) => {
                        const live = c.status !== "revoked" && !c.expired;
                        return (
                            <Card key={c.id} variant="default" padding="lg">
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-3 flex-wrap">
                                            <h3 className="font-bold text-gray-800 italic tracking-tight">{c.name}</h3>
                                            {badge(c)}
                                        </div>
                                        <div className="text-xs text-gray-400 mt-1 flex flex-wrap gap-x-4 gap-y-1">
                                            <span><i className="fa-solid fa-user mr-1"></i>{c.user ? `${c.user.displayName || c.user.login} (${c.user.role})` : "—"}</span>
                                            <code className="font-mono">{c.tokenPrefix}…</code>
                                            <span>{t("agents.colLastUsed")}: {fmtDate(c.lastUsedAt)}</span>
                                            {c.expiresAt != null && <span>{t("tokens.colExpires")}: {fmtDate(c.expiresAt)}</span>}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        {live && canGrant && reviewing !== c.id && (
                                            <Button size="sm" variant="secondary" icon="fa-shield-halved" onClick={() => startReview(c)}>{t("agents.review")}</Button>
                                        )}
                                        <Button size="sm" variant="ghost" icon="fa-clipboard-list" onClick={() => openAudit(c.id)}>{t("agents.audit")}</Button>
                                        {live && <Button size="sm" variant="ghost" icon="fa-code" onClick={() => setReveal({ token: PLACEHOLDER, url: mcpUrl, fresh: false })}>{t("agents.showConfig")}</Button>}
                                        {live && <Button size="sm" variant="danger" icon="fa-ban" onClick={() => handleRevoke(c)}>{t("agents.revoke")}</Button>}
                                    </div>
                                </div>

                                <div className="mt-4 flex flex-wrap gap-1.5" aria-label={t("agents.colCapabilities")}>
                                    {c.requested.map((cap) => {
                                        const granted = c.granted.includes(cap) && c.status === "active";
                                        const inert = granted && !c.effective.includes(cap);
                                        const cls = !granted ? "bg-gray-100 text-gray-400" : inert ? "bg-amber-50 text-amber-700 line-through" : "bg-blue-50 text-blue-700";
                                        return (
                                            <span key={cap} title={!granted ? t("agents.notGranted") : inert ? t("agents.inert") : undefined}
                                                className={`text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-md flex items-center gap-1 ${cls}`}>
                                                <i className={`fa-solid ${granted ? (inert ? "fa-triangle-exclamation" : "fa-check") : "fa-hourglass-half"}`}></i>{cap}
                                            </span>
                                        );
                                    })}
                                </div>
                                {c.status === "pending" && live && <p className="text-xs text-amber-600 mt-2"><i className="fa-solid fa-hourglass-half mr-1"></i>{t("agents.pendingHint")}</p>}

                                {reviewing === c.id && (
                                    <div className="mt-5 rounded-2xl border border-blue-100 bg-blue-50/30 p-4">
                                        <p className="text-xs text-gray-500 mb-3">{t("agents.reviewHelp")}</p>
                                        <div className="grid sm:grid-cols-2 gap-1.5">
                                            {c.requested.map((cap) => {
                                                const implied = !draftGrant.has(cap) && withImplied(draftGrant).has(cap);
                                                return (
                                                    <label key={cap} className="flex items-center gap-2 text-xs font-bold text-gray-700 bg-white rounded-xl border border-gray-100 px-3 py-2 cursor-pointer">
                                                        <input type="checkbox" checked={draftGrant.has(cap) || implied} disabled={implied} onChange={() => setDraftGrant(toggle(draftGrant, cap))} />
                                                        <i className={`fa-solid ${CAP_ICONS[cap]} text-gray-300 w-4 text-center`}></i>
                                                        {t(`agents.cap.${capKey(cap)}`)}
                                                    </label>
                                                );
                                            })}
                                        </div>
                                        <div className="mt-4 flex gap-2 justify-end">
                                            <Button size="sm" variant="ghost" onClick={() => setReviewing(null)}>{t("cancel")}</Button>
                                            <Button size="sm" icon="fa-check" loading={saving} onClick={() => saveGrant(c)}>{t("agents.grant")}</Button>
                                        </div>
                                    </div>
                                )}

                                {auditFor === c.id && (
                                    <div className="mt-5 border-t border-gray-100 pt-4">
                                        {audit.length === 0 ? <p className="text-xs text-gray-400">{t("agents.auditEmpty")}</p> : (
                                            <ol className="space-y-1.5 max-h-72 overflow-auto">
                                                {audit.map((a) => (
                                                    <li key={a.id} className="text-xs flex flex-wrap gap-x-3 gap-y-0.5 items-baseline">
                                                        <span className="text-gray-400 tabular-nums">{fmtDate(a.createdAt)}</span>
                                                        <code className={`font-mono font-bold ${a.action === "agent.denied" || a.detail?.ok === false ? "text-red-600" : "text-gray-700"}`}>{a.action}</code>
                                                        <span className="text-gray-500 break-all">
                                                            {Object.entries(a.detail || {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`).join("  ")}
                                                        </span>
                                                    </li>
                                                ))}
                                            </ol>
                                        )}
                                    </div>
                                )}
                            </Card>
                        );
                    })}
                </div>
            </div>

            {reveal && (
                <ConfigDialog
                    url={reveal.url}
                    token={reveal.token}
                    title={reveal.fresh ? t("agents.secretTitle") : t("agents.config")}
                    description={reveal.fresh ? t("agents.secretDescription") : t("agents.configHelp")}
                    onClose={() => setReveal(null)}
                />
            )}
        </div>
    );
}
