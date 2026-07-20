"use client";

import { useEffect, useState } from "react";
import { tokensApi, ApiToken } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useToast } from "@/contexts/ToastContext";
import { PageHeader, Button, Card, EmptyState, Input, Select, StatusBadge } from "@/components/ui";
import SecretRevealModal from "@/components/SecretRevealModal";

const fmtDate = (v: number | null | string | undefined) => {
    if (v == null) return "—";
    const ms = typeof v === "number" ? v * 1000 : Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toLocaleDateString() : "—";
};

const isExpired = (t: ApiToken) => t.expiresAt != null && t.expiresAt * 1000 <= Date.now();

export default function TokensPage() {
    const { confirm } = useModal();
    const { addToast } = useToast();
    const [tokens, setTokens] = useState<ApiToken[]>([]);
    const [loading, setLoading] = useState(true);
    const [name, setName] = useState("");
    const [scopes, setScopes] = useState("read");
    const [expiry, setExpiry] = useState("");
    const [creating, setCreating] = useState(false);
    const [revealed, setRevealed] = useState<string | null>(null);

    const load = async () => {
        try {
            const { tokens } = await tokensApi.list();
            setTokens(tokens);
        } catch (e: any) {
            addToast(e?.message || "Failed to load tokens", "error");
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => { load(); }, []);

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        setCreating(true);
        try {
            const res = await tokensApi.create({
                name: name.trim() || "API token",
                scopes,
                expiresInDays: expiry ? Number(expiry) : null,
            });
            setRevealed(res.token);
            setName("");
            setScopes("read");
            setExpiry("");
            await load();
        } catch (e: any) {
            addToast(e?.message || "Failed to create token", "error");
        } finally {
            setCreating(false);
        }
    };

    const handleRevoke = async (t: ApiToken) => {
        if (!(await confirm(`Revoke "${t.name}"? Any client using this token will immediately lose access.`, "Revoke token", true))) return;
        try {
            await tokensApi.revoke(t.id);
            addToast("Token revoked", "success");
            await load();
        } catch (e: any) {
            addToast(e?.message || "Failed to revoke token", "error");
        }
    };

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title="API Tokens"
                subtitle="Personal access tokens for headless clients (CI, JAMstack, automation). A token acts with your permissions on the Authorization: Bearer path."
                icon="fa-key"
            />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Create */}
                <Card variant="default" padding="lg" className="h-fit">
                    <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-6 flex items-center gap-2">
                        <i className="fa-solid fa-plus-circle text-blue-500"></i>
                        New token
                    </h2>
                    <form onSubmit={handleCreate} className="space-y-5">
                        <Input label="Name" icon="fa-tag" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CI deploy key" />
                        <div>
                            <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Scope</label>
                            <Select
                                value={scopes}
                                onChange={setScopes}
                                options={[
                                    { value: "read", label: "Read-only (GET)" },
                                    { value: "write", label: "Read & write" },
                                ]}
                            />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Expires</label>
                            <Select
                                value={expiry}
                                onChange={setExpiry}
                                options={[
                                    { value: "", label: "Never" },
                                    { value: "30", label: "In 30 days" },
                                    { value: "90", label: "In 90 days" },
                                    { value: "365", label: "In 1 year" },
                                ]}
                            />
                        </div>
                        <Button type="submit" icon="fa-plus" className="w-full" loading={creating}>
                            Create token
                        </Button>
                    </form>
                </Card>

                {/* List */}
                <div className="lg:col-span-2">
                    <Card variant="default" padding="none">
                        {loading ? (
                            <div className="p-20 text-center">
                                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                                <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">Loading</p>
                            </div>
                        ) : tokens.length === 0 ? (
                            <EmptyState icon="fa-key" title="No tokens yet" description="Create a token to call the REST API from a script or service." />
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead>
                                        <tr className="border-b border-gray-100/50 bg-gray-50/30">
                                            {["Token", "Scopes", "Last used", "Expires", "Status", "Actions"].map((h, i) => (
                                                <th key={h} className={`px-6 py-5 text-[10px] font-black text-gray-400 uppercase tracking-widest ${i === 5 ? "text-right" : "text-left"}`}>{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-50">
                                        {tokens.map((t) => {
                                            const expired = isExpired(t);
                                            return (
                                                <tr key={t.id} className="group hover:bg-blue-50/5 transition-colors">
                                                    <td className="px-6 py-5">
                                                        <div className="font-bold text-gray-700 italic tracking-tight">{t.name}</div>
                                                        <code className="text-xs font-mono text-gray-400">{t.tokenPrefix}…</code>
                                                    </td>
                                                    <td className="px-6 py-5">
                                                        <div className="flex flex-wrap gap-1">
                                                            {t.scopes.map((s) => (
                                                                <span key={s} className="text-[10px] font-black uppercase tracking-wider text-blue-600 bg-blue-50 px-2 py-1 rounded-md">{s}</span>
                                                            ))}
                                                        </div>
                                                    </td>
                                                    <td className="px-6 py-5 text-sm text-gray-500">{fmtDate(t.lastUsedAt)}</td>
                                                    <td className="px-6 py-5 text-sm text-gray-500">{t.expiresAt == null ? "Never" : fmtDate(t.expiresAt)}</td>
                                                    <td className="px-6 py-5">
                                                        {t.revoked ? <StatusBadge status="error" label="Revoked" />
                                                            : expired ? <StatusBadge status="neutral" label="Expired" />
                                                                : <StatusBadge status="success" label="Active" />}
                                                    </td>
                                                    <td className="px-6 py-5 text-right">
                                                        {!t.revoked && (
                                                            <button
                                                                onClick={() => handleRevoke(t)}
                                                                title="Revoke"
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
                title="Your new API token"
                description="Use it as a Bearer credential: Authorization: Bearer <token>. It bypasses the cookie/CSRF flow, so it's ideal for scripts and CI."
                onClose={() => setRevealed(null)}
            />
        </div>
    );
}
