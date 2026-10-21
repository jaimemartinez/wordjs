"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPut, accountBoundSessionAddress } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import { useToast } from "@/contexts/ToastContext";
import { useModal } from "@/contexts/ModalContext";
import { PageHeader, Button, Card, Input } from "@/components/ui";

/**
 * Admin → Servers (backend routes/cluster.ts → the gateway's /cluster*): the panel path for
 * `npm run cluster -- token | tokens | revoke-tokens | info` and `npm run node:join`. Shows every node the
 * gateway knows with its health, mints a short-lived join token for a new machine (password + two-factor
 * code) with the command to run there, revokes outstanding tokens, and takes a node out of the cluster.
 */

interface Node { url: string; role: string | null; routes: string[]; status: "up" | "down" | "unknown"; latencyMs?: number | null; lastError?: string | null; certExpiresAt?: string | null }
interface ClusterState {
    mode: "monolith" | "split" | "separate";
    initialized: boolean;
    /** This session was started at an address other than the main one: the writes below are refused. */
    boundSession?: boolean;
    mainAddress?: string | null;
    gateway?: { advertiseHost: string | null; port: number; serving: "https" | "http" | "mixed" | null; certExpiresAt: string | null; caExpiresAt: string | null };
    advertiseHost?: string | null;
    enrollPort?: number;
    caFingerprint?: string;
    nodes: Node[];
    tokens: Array<{ role: string; host: string | null; expiresAt: string }>;
    removed: string[];
    /** TCP ports the gateway forwards to the backend node, as listening now (gateway/src/tcp-forward.js). */
    forwards?: Forward[];
}

export default function ClusterPage() {
    const { t } = useI18n();
    const { addToast } = useToast();
    const { confirm } = useModal();
    const [state, setState] = useState<ClusterState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [role, setRole] = useState<"backend" | "frontend">("backend");
    const [host, setHost] = useState("");
    const [ttl, setTtl] = useState("15");
    const [password, setPassword] = useState("");
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [minted, setMinted] = useState<{ command: string; expiresAt: string } | null>(null);
    // The forwards being edited; null while the list shows what the gateway reported.
    const [forwardDraft, setForwardDraft] = useState<Forward[] | null>(null);

    /** A refused write, in words: a session from a secondary address says where to sign in (QA X1-06). */
    const failure = (err: any, fallback: string) => {
        const main = accountBoundSessionAddress(err);
        if (main !== null) return main ? t("cluster.boundSession").replace("{url}", () => main) : t("cluster.boundSessionNoUrl");
        return err?.message || t(fallback);
    };
    const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString() : "?");

    const load = async () => {
        try { setState(await apiGet<ClusterState>("/system/cluster")); setError(null); }
        catch (e: any) { setError(e?.message || t("cluster.loadFailed")); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { load(); const id = setInterval(load, 30000); return () => clearInterval(id); }, []);

    const mint = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy("mint");
        try {
            const r = await apiPost<{ command: string; expiresAt: string }>("/system/cluster/token", { role, host: host.trim() || undefined, ttlMinutes: Number(ttl) || 15, currentPassword: password, mfaCode: code.trim() });
            setMinted({ command: r.command, expiresAt: r.expiresAt });
            setPassword(""); setCode("");
            await load();
        } catch (err: any) { addToast(failure(err, "cluster.mintFailed"), "error"); }
        finally { setBusy(null); }
    };

    const remove = async (node: Node) => {
        if (!password || !code.trim()) { addToast(t("cluster.needCredentials"), "error"); return; }
        if (!(await confirm(t("cluster.removeConfirm").replace("{url}", node.url), t("cluster.removeTitle"), true))) return;
        setBusy(node.url);
        try {
            await apiPost("/system/cluster/nodes/remove", { url: node.url, currentPassword: password, mfaCode: code.trim() });
            addToast(t("cluster.removed").replace("{url}", node.url), "success");
            setPassword(""); setCode("");
            await load();
        } catch (err: any) { addToast(failure(err, "cluster.removeFailed"), "error"); }
        finally { setBusy(null); }
    };

    /** Replace the forwarded ports (password only, like revoking: nothing new is admitted to the cluster). */
    const saveForwards = async () => {
        if (!forwardDraft) return;
        if (!password) { addToast(t("network.passwordRequired"), "error"); return; }
        setBusy("forwards");
        try {
            const r = await apiPut<{ forwards: Forward[] }>("/system/cluster/forwards", {
                currentPassword: password,
                forwards: forwardDraft.map((f) => ({ port: Number(f.port), targetPort: Number(f.targetPort), proxyProtocol: f.proxyProtocol })),
            });
            setPassword("");
            setForwardDraft(null);
            const failed = r.forwards.filter((f) => !f.listening);
            addToast(failed.length ? t("cluster.forwardsSavedWithErrors").replace("{n}", String(failed.length)) : t("cluster.forwardsSaved"), failed.length ? "warning" : "success");
            await load();
        } catch (err: any) { addToast(failure(err, "cluster.forwardsFailed"), "error"); }
        finally { setBusy(null); }
    };

    const revoke = async () => {
        if (!password) { addToast(t("network.passwordRequired"), "error"); return; }
        setBusy("revoke");
        try { await apiPost("/system/cluster/tokens/revoke", { currentPassword: password }); setPassword(""); addToast(t("cluster.revoked"), "success"); await load(); }
        catch (err: any) { addToast(failure(err, "cluster.revokeFailed"), "error"); }
        finally { setBusy(null); }
    };

    const copy = async (text: string) => {
        try { await navigator.clipboard.writeText(text); addToast(t("cluster.copied"), "success"); } catch { /* the text is selectable */ }
    };

    const shell = (children: React.ReactNode) => (
        <div className="p-4 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full">
            <PageHeader title={t("cluster.title")} subtitle={t("cluster.subtitle")} icon="fa-server" />
            <div className="max-w-5xl space-y-6">{error && <div role="alert" className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}{children}</div>
        </div>
    );
    if (!state) return shell(<Card variant="default" padding="lg"><p className="text-sm text-gray-500">{t("loading")}</p></Card>);
    if (state.mode === "monolith") return shell(
        <Card variant="default" padding="lg"><div data-testid="cluster-monolith" className="text-sm text-gray-600 space-y-2"><p className="font-bold text-gray-900">{t("cluster.monolithTitle")}</p><p>{t("cluster.monolithHelp")}</p></div></Card>
    );

    const credentials = (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input label={t("network.currentPassword")} icon="fa-lock" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <Input label={t("networkSetup.mfaCode")} icon="fa-shield-halved" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
    );

    return shell(<>
        {state.boundSession && (
            <div role="status" data-testid="cluster-bound-session" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                {state.mainAddress
                    ? <>{t("cluster.boundSession").replace("{url}", state.mainAddress)} <a className="font-bold underline" href={`${state.mainAddress}/admin/cluster`}>{t("cluster.openMain")}</a></>
                    : t("cluster.boundSessionNoUrl")}
            </div>
        )}
        <Card variant="default" padding="lg">
            <p className="text-sm text-gray-500 mb-4">{t("cluster.credentialsHelp")}</p>
            {credentials}
        </Card>

        <Card variant="default" padding="lg">
            <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-4">{t("cluster.nodes")}</h2>
            {state.gateway && (
                <div className="py-3 border-b border-gray-100" data-testid="cluster-gateway">
                    <p className="font-mono text-sm text-gray-900 break-all">{t("cluster.gatewayRow")}{state.gateway.advertiseHost ? ` · ${state.gateway.advertiseHost}` : ""}:{state.gateway.port}</p>
                    <p className="text-xs text-gray-500">
                        {state.gateway.serving === "https" ? "HTTPS" : state.gateway.serving === "http" ? "HTTP" : "…"}
                        {state.gateway.certExpiresAt ? ` · ${t("cluster.certExpires").replace("{date}", fmtDate(state.gateway.certExpiresAt))}` : ""}
                        {state.gateway.caExpiresAt ? ` · ${t("cluster.caExpires").replace("{date}", fmtDate(state.gateway.caExpiresAt))}` : ""}
                    </p>
                </div>
            )}
            {state.nodes.length === 0 ? <p className="text-sm text-gray-500">{t("cluster.noNodes")}</p> : (
                <ul className="divide-y divide-gray-100" data-testid="cluster-nodes">
                    {state.nodes.map((n) => (
                        <li key={n.url} data-status={n.status} className="flex flex-wrap items-center justify-between gap-3 py-3">
                            <div className="min-w-0">
                                <p className="font-mono text-sm text-gray-900 break-all">{n.url}</p>
                                <p className="text-xs text-gray-500">
                                    <span className={`font-bold ${n.status === "up" ? "text-emerald-600" : n.status === "down" ? "text-red-600" : "text-gray-400"}`}>{t(`cluster.status.${n.status}`)}</span>
                                    {" · "}{n.role || "?"}{" · "}{n.routes.join(", ")}{typeof n.latencyMs === "number" ? ` · ${n.latencyMs} ms` : ""}
                                </p>
                                {n.certExpiresAt && <p className="text-xs text-gray-400">{t("cluster.certExpires").replace("{date}", fmtDate(n.certExpiresAt))}</p>}
                                {n.lastError && <p className="text-xs text-red-600 break-words">{n.lastError}</p>}
                            </div>
                            <Button variant="danger" size="sm" icon="fa-right-from-bracket" loading={busy === n.url} onClick={() => remove(n)}>{t("cluster.remove")}</Button>
                        </li>
                    ))}
                </ul>
            )}
            {state.removed.length > 0 && <p className="mt-4 text-xs text-gray-500">{t("cluster.removedList").replace("{list}", state.removed.join(", "))}</p>}
        </Card>

        {!state.initialized ? (
            <Card variant="default" padding="lg">
                <div className="text-sm text-gray-600 space-y-2" data-testid="cluster-not-initialized">
                    <p className="font-bold text-gray-900">{t("cluster.notInitTitle")}</p>
                    <p>{t("cluster.notInitHelp")}</p>
                    <pre className="overflow-x-auto rounded-lg bg-gray-900 px-3 py-2 text-xs text-gray-100">npm run cluster -- init --host &lt;this-machine-ip&gt;</pre>
                </div>
            </Card>
        ) : (
            <Card variant="default" padding="lg">
                <form onSubmit={mint} className="space-y-4">
                    <h2 className="text-xs font-black uppercase tracking-widest text-gray-400">{t("cluster.addTitle")}</h2>
                    <p className="text-sm text-gray-500">{t("cluster.addHelp")}</p>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="space-y-1">
                            <label htmlFor="cluster-role" className="text-xs font-bold uppercase tracking-wide text-gray-600">{t("cluster.role")}</label>
                            <select id="cluster-role" value={role} onChange={(e) => setRole(e.target.value as any)} className="w-full px-4 py-3 rounded-xl border border-gray-200 bg-gray-50 text-sm">
                                <option value="backend">{t("cluster.role.backend")}</option>
                                <option value="frontend">{t("cluster.role.frontend")}</option>
                            </select>
                        </div>
                        <Input label={t("cluster.host")} icon="fa-network-wired" value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.7" />
                        <Input label={t("cluster.ttl")} icon="fa-clock" type="number" min={1} max={60} value={ttl} onChange={(e) => setTtl(e.target.value)} />
                    </div>
                    <Button type="submit" icon="fa-ticket" loading={busy === "mint"} data-testid="cluster-mint">{t("cluster.mint")}</Button>
                </form>
                {minted && (
                    <div className="mt-6 space-y-2" data-testid="cluster-minted">
                        <p className="text-sm text-gray-700">{t("cluster.runThis").replace("{at}", new Date(minted.expiresAt).toLocaleTimeString())}</p>
                        <pre className="overflow-x-auto rounded-lg bg-gray-900 px-3 py-2 text-xs text-gray-100 whitespace-pre-wrap break-all">{minted.command}</pre>
                        <Button variant="secondary" size="sm" icon="fa-copy" onClick={() => copy(minted.command)}>{t("cluster.copy")}</Button>
                    </div>
                )}
                <div className="mt-6 border-t border-gray-100 pt-4 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-gray-600">{t("cluster.outstanding").replace("{n}", String(state.tokens.length))}</p>
                    {state.tokens.length > 0 && <Button variant="secondary" size="sm" loading={busy === "revoke"} onClick={revoke}>{t("cluster.revoke")}</Button>}
                </div>
                {state.tokens.length > 0 && (
                    <ul className="mt-2 space-y-1 text-xs text-gray-500" data-testid="cluster-tokens">
                        {state.tokens.map((tok, i) => (
                            <li key={i}>
                                {t(`cluster.role.${tok.role === "frontend" ? "frontend" : "backend"}`)}
                                {" · "}{tok.host ? t("cluster.tokenPinned").replace("{host}", tok.host) : t("cluster.tokenUnpinned")}
                                {" · "}{t("cluster.tokenExpires").replace("{at}", new Date(tok.expiresAt).toLocaleString())}
                            </li>
                        ))}
                    </ul>
                )}
                <p className="mt-2 text-xs text-gray-400">{t("cluster.rotateHint")}</p>
                {state.caFingerprint && <p className="mt-2 text-xs text-gray-400 break-all">{t("cluster.fingerprint")}: {state.caFingerprint}</p>}
            </Card>
        )}

        {Array.isArray(state.forwards) && (
            <Card variant="default" padding="lg">
                <div data-testid="cluster-forwards" className="space-y-4">
                    <h2 className="text-xs font-black uppercase tracking-widest text-gray-400">{t("cluster.forwardsTitle")}</h2>
                    <p className="text-sm text-gray-500">
                        {t("cluster.forwardsHelp").replace("{gateway}", state.gateway?.advertiseHost || state.advertiseHost || t("cluster.gatewayRow"))}
                    </p>
                    {forwardDraft === null ? (
                        <>
                            {state.forwards.length === 0 ? <p className="text-sm text-gray-500">{t("cluster.forwardsNone")}</p> : (
                                <ul className="divide-y divide-gray-100">
                                    {state.forwards.map((f) => (
                                        <li key={f.port} className="py-2 text-sm">
                                            <span className="font-mono text-gray-900">:{f.port} → backend:{f.targetPort}</span>
                                            <span className="text-xs text-gray-500">{f.proxyProtocol ? ` · ${t("cluster.forwardProxy")}` : ""}</span>
                                            {" · "}
                                            {f.listening
                                                ? <span className="text-xs font-bold text-emerald-600">{t("cluster.forwardListening")}</span>
                                                : <span className="text-xs font-bold text-red-600">{f.error || t("cluster.forwardNotListening")}</span>}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <Button variant="secondary" size="sm" icon="fa-pen" onClick={() => setForwardDraft(state.forwards!.map((f) => ({ port: f.port, targetPort: f.targetPort, proxyProtocol: f.proxyProtocol })))} data-testid="cluster-forwards-edit">{t("cluster.forwardsEdit")}</Button>
                        </>
                    ) : (
                        <div className="space-y-3">
                            {forwardDraft.map((f, i) => (
                                <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-3 items-end">
                                    <Input label={t("cluster.forwardPort")} type="number" min={1} max={65535} value={String(f.port ?? "")} onChange={(e) => setForwardDraft(forwardDraft.map((x, j) => (j === i ? { ...x, port: e.target.value as any } : x)))} />
                                    <Input label={t("cluster.forwardTargetPort")} type="number" min={1} max={65535} value={String(f.targetPort ?? "")} onChange={(e) => setForwardDraft(forwardDraft.map((x, j) => (j === i ? { ...x, targetPort: e.target.value as any } : x)))} />
                                    <label className="flex items-center gap-2 text-sm text-gray-700 pb-3">
                                        <input type="checkbox" checked={f.proxyProtocol} onChange={(e) => setForwardDraft(forwardDraft.map((x, j) => (j === i ? { ...x, proxyProtocol: e.target.checked } : x)))} />
                                        {t("cluster.forwardProxy")}
                                    </label>
                                    <Button variant="ghost" size="sm" icon="fa-trash" onClick={() => setForwardDraft(forwardDraft.filter((_, j) => j !== i))}>{t("cluster.forwardRemove")}</Button>
                                </div>
                            ))}
                            <div className="flex flex-wrap gap-2">
                                <Button variant="secondary" size="sm" icon="fa-plus" onClick={() => setForwardDraft([...forwardDraft, { port: 25, targetPort: 2525, proxyProtocol: true }])}>{t("cluster.forwardAdd")}</Button>
                                <Button variant="secondary" size="sm" onClick={() => setForwardDraft(null)}>{t("common.cancel")}</Button>
                                <Button variant="primary" size="sm" icon="fa-check" loading={busy === "forwards"} onClick={saveForwards} data-testid="cluster-forwards-save">{t("cluster.forwardsSave")}</Button>
                            </div>
                        </div>
                    )}
                </div>
            </Card>
        )}
    </>);
}

interface Forward { port: number; targetPort: number; proxyProtocol: boolean; listening?: boolean; error?: string | null }
