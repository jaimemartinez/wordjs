"use client";

import { useEffect, useState } from "react";
import { networkApi, type NetworkPlugin, type NetworkQuotas, type NetworkSite } from "@/lib/api";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { formatServerTimestamp } from "@/lib/serverTimestamp";
import { PageHeader, Button, Card, EmptyState, Input, StatusBadge } from "@/components/ui";
import { fmtBytes, fromMbField, toMbField } from "@/lib/networkQuota";

/**
 * Admin → Network (multisite). The sites of the network: create one, suspend or resume it. Shown in the
 * menu to NETWORK administrators only, on the main site; the API enforces the same (backend
 * routes/network.ts), so this page only decides what to draw. Every write asks for the current
 * password, like Settings → Site address: creating a site publishes a new address.
 *
 * A new site gets its own database, uploads, users and settings; its first administrator is created
 * here and signs in on the site's own address.
 *
 * Plugins (phase 2): their code is installed once, network-wide. The "Plugins for the sites" card offers a
 * plugin to the other sites with a grant CEILING — the most a site administrator may grant it — or stops
 * offering it (it is then deactivated on every other site). The server enforces the ceiling on every
 * write and every check (core/plugin-permissions); this card only records it.
 *
 * Media quotas: each site other than the main one can be capped in how much media it stores (its own
 * quota, else the network default; empty = no limit). Shown and typed in MB, stored in bytes; the server
 * enforces it on every upload (core/site-upload-quota).
 */

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const fmtDate = formatServerTimestamp;

const EMPTY_FORM = { slug: "", url: "", title: "", adminUsername: "", adminEmail: "", adminPassword: "", currentPassword: "" };

export default function NetworkPage() {
    const { addToast } = useToast();
    const { t } = useI18n();
    const [allowed, setAllowed] = useState<boolean | null>(null);
    const [sites, setSites] = useState<NetworkSite[]>([]);
    const [loading, setLoading] = useState(true);
    const [form, setForm] = useState(EMPTY_FORM);
    const [creating, setCreating] = useState(false);
    // Why the last create failed ("" when the server gave no reason); null when there is nothing to show.
    const [createError, setCreateError] = useState<string | null>(null);
    const [actionPassword, setActionPassword] = useState("");
    const [busyId, setBusyId] = useState<number | null>(null);
    const [netPlugins, setNetPlugins] = useState<NetworkPlugin[]>([]);
    const [ceilingDraft, setCeilingDraft] = useState<Record<string, string[]>>({});
    const [busyPlugin, setBusyPlugin] = useState<string | null>(null);
    const [quotas, setQuotas] = useState<NetworkQuotas | null>(null);
    const [quotaDraft, setQuotaDraft] = useState<Record<string, string>>({});
    const [busyQuota, setBusyQuota] = useState<string | null>(null);

    const load = async () => {
        try {
            const [{ sites }, { plugins }, q] = await Promise.all([networkApi.sites(), networkApi.plugins(), networkApi.quotas()]);
            setSites(sites);
            setQuotas(q);
            setQuotaDraft({
                default: toMbField(q.defaultQuota),
                ...Object.fromEntries(q.sites.map((s) => [String(s.id), toMbField(s.quota)])),
            });
            setNetPlugins(plugins);
            setCeilingDraft(Object.fromEntries(plugins.map((p) => [p.slug, p.ceiling ?? p.requestedPermissions])));
        } catch (e: any) {
            addToast(e?.message || t("network.loadFailed"), "error");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        networkApi.status()
            .then((s) => {
                const ok = s.enabled && s.networkAdmin;
                setAllowed(ok);
                if (ok) load(); else setLoading(false);
            })
            .catch(() => { setAllowed(false); setLoading(false); });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const set = (key: keyof typeof EMPTY_FORM) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        setCreateError(null);
        if (!SLUG_RE.test(form.slug)) {
            addToast(t("network.slugInvalid"), "error");
            return;
        }
        setCreating(true);
        try {
            const { site } = await networkApi.create(form);
            addToast(t("network.created").replace("{url}", site.url), "success");
            setForm(EMPTY_FORM);
            await load();
        } catch (err: any) {
            // Also kept on the form: a toast alone was easy to miss on a long form, and a failed create
            // that leaves the form unchanged otherwise looks like nothing happened.
            setCreateError(err?.message || "");
            addToast(err?.message || t("network.createFailed"), "error");
        } finally {
            setCreating(false);
        }
    };

    // Deleting a site: the slug is typed again in a field that opens under the site (never a one-click action).
    const [deleting, setDeleting] = useState<{ id: number; slug: string } | null>(null);
    const removeSite = async (site: NetworkSite) => {
        if (!actionPassword) {
            addToast(t("network.passwordRequired"), "error");
            return;
        }
        if (!deleting || deleting.id !== site.id || deleting.slug !== site.slug) {
            addToast(t("network.deleteConfirmMismatch"), "error");
            return;
        }
        setBusyId(site.id);
        try {
            await networkApi.remove(site.id, deleting.slug, actionPassword);
            addToast(t("network.deleted").replace("{host}", site.host), "success");
            setDeleting(null);
            await load();
        } catch (err: any) {
            addToast(err?.message || t("network.deleteFailed"), "error");
        } finally {
            setBusyId(null);
        }
    };

    const changeStatus = async (site: NetworkSite, to: "suspend" | "resume") => {
        if (!actionPassword) {
            addToast(t("network.passwordRequired"), "error");
            return;
        }
        setBusyId(site.id);
        try {
            await (to === "suspend" ? networkApi.suspend(site.id, actionPassword) : networkApi.resume(site.id, actionPassword));
            addToast(t(to === "suspend" ? "network.suspended" : "network.resumed").replace("{host}", site.host), "success");
            await load();
        } catch (err: any) {
            addToast(err?.message || t("network.actionFailed"), "error");
        } finally {
            setBusyId(null);
        }
    };

    /** Save the default ('default') or one site's quota (its id) from its MB field. */
    const saveQuota = async (key: string, site?: NetworkSite) => {
        if (!actionPassword) {
            addToast(t("network.passwordRequired"), "error");
            return;
        }
        const bytes = fromMbField(quotaDraft[key] || "");
        if (bytes === undefined) {
            addToast(t("network.quotaInvalid"), "error");
            return;
        }
        setBusyQuota(key);
        try {
            if (site) {
                await networkApi.setSiteQuota(site.id, bytes, actionPassword);
                addToast(t("network.quotaSaved").replace("{host}", site.host), "success");
            } else {
                await networkApi.setDefaultQuota(bytes, actionPassword);
                addToast(t("network.quotaDefaultSaved"), "success");
            }
            await load();
        } catch (err: any) {
            addToast(err?.message || t("network.actionFailed"), "error");
        } finally {
            setBusyQuota(null);
        }
    };

    const quotaFor = (id: number) => quotas?.sites.find((s) => s.id === id) || null;

    const toggleCeiling = (slug: string, token: string) => setCeilingDraft((d) => {
        const cur = new Set(d[slug] || []);
        if (cur.has(token)) cur.delete(token); else cur.add(token);
        return { ...d, [slug]: Array.from(cur) };
    });

    const offerPlugin = async (plugin: NetworkPlugin) => {
        if (!actionPassword) {
            addToast(t("network.passwordRequired"), "error");
            return;
        }
        setBusyPlugin(plugin.slug);
        try {
            await networkApi.offerPlugin(plugin.slug, ceilingDraft[plugin.slug] || [], actionPassword);
            addToast(t("network.offeredToast").replace("{slug}", plugin.name), "success");
            await load();
        } catch (err: any) {
            addToast(err?.message || t("network.pluginActionFailed"), "error");
        } finally {
            setBusyPlugin(null);
        }
    };

    const withdrawPlugin = async (plugin: NetworkPlugin) => {
        if (!actionPassword) {
            addToast(t("network.passwordRequired"), "error");
            return;
        }
        setBusyPlugin(plugin.slug);
        try {
            const r = await networkApi.withdrawPlugin(plugin.slug, actionPassword);
            addToast(t("network.withdrawnToast").replace("{slug}", plugin.name).replace("{count}", String(r.deactivatedOn.length)), "success");
            await load();
        } catch (err: any) {
            addToast(err?.message || t("network.pluginActionFailed"), "error");
        } finally {
            setBusyPlugin(null);
        }
    };

    if (allowed === false) {
        return (
            <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full">
                <PageHeader title={t("network.title")} subtitle={t("network.subtitle")} icon="fa-sitemap" />
                <Card variant="default" padding="none">
                    <EmptyState icon="fa-lock" title={t("network.notAllowedTitle")} description={t("network.notAllowedDescription")} />
                </Card>
            </div>
        );
    }

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader title={t("network.title")} subtitle={t("network.subtitle")} icon="fa-sitemap" />

            <Card variant="default" padding="lg" className="mb-8">
                <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-6 flex items-center gap-2">
                    <i className="fa-solid fa-plus-circle text-blue-500"></i>
                    {t("network.newSite")}
                </h2>
                <form onSubmit={handleCreate} className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <Input label={t("network.address")} icon="fa-globe" value={form.url} onChange={set("url")} placeholder="https://blog.example.com" type="url" required />
                        <Input label={t("network.slug")} icon="fa-tag" value={form.slug} onChange={set("slug")} placeholder="blog" required />
                        <Input label={t("network.siteTitle")} icon="fa-heading" value={form.title} onChange={set("title")} required />
                    </div>
                    <p className="text-xs text-gray-500">{t("network.addressHint")}</p>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <Input label={t("network.adminUsername")} icon="fa-user" value={form.adminUsername} onChange={set("adminUsername")} autoComplete="off" required />
                        <Input label={t("network.adminEmail")} icon="fa-envelope" value={form.adminEmail} onChange={set("adminEmail")} type="email" autoComplete="off" required />
                        <Input label={t("network.adminPassword")} icon="fa-key" value={form.adminPassword} onChange={set("adminPassword")} type="password" autoComplete="new-password" minLength={8} required />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-end">
                        <Input label={t("network.currentPassword")} icon="fa-lock" value={form.currentPassword} onChange={set("currentPassword")} type="password" autoComplete="current-password" required />
                        <div>
                            <Button type="submit" icon="fa-plus" loading={creating}>{t("network.createSite")}</Button>
                        </div>
                    </div>
                    {createError !== null && (
                        <div role="alert" data-testid="network-create-error" className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
                            <p className="font-bold"><i className="fa-solid fa-triangle-exclamation mr-2" aria-hidden="true"></i>{t("network.createFailed")}</p>
                            {createError && <p className="mt-1 break-words">{createError}</p>}
                        </div>
                    )}
                </form>
            </Card>

            <Card variant="default" padding="none">
                <div className="p-6 md:p-8 border-b border-gray-50 flex flex-wrap items-end justify-between gap-4">
                    <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 flex items-center gap-2">
                        <i className="fa-solid fa-sitemap text-blue-500"></i>
                        {t("network.sites")}
                    </h2>
                    <div className="w-full md:w-80">
                        <Input label={t("network.actionPassword")} icon="fa-lock" value={actionPassword} onChange={(e) => setActionPassword(e.target.value)} type="password" autoComplete="current-password" />
                    </div>
                </div>
                {quotas && (
                    <div className="px-6 md:px-8 py-5 border-b border-gray-50 flex flex-wrap items-end gap-4" data-testid="network-default-quota">
                        <div className="w-full md:w-72">
                            <Input label={t("network.quotaDefault")} icon="fa-hard-drive" value={quotaDraft.default ?? ""} onChange={(e) => setQuotaDraft((d) => ({ ...d, default: e.target.value }))} inputMode="decimal" placeholder={t("network.quotaUnlimited")} />
                        </div>
                        <Button variant="secondary" icon="fa-check" loading={busyQuota === "default"} onClick={() => saveQuota("default")}>{t("network.quotaSave")}</Button>
                        <p className="text-xs text-gray-500 w-full">{t("network.quotaDefaultHint")}</p>
                    </div>
                )}
                {loading || allowed === null ? (
                    <div className="p-20 text-center">
                        <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t("common.loading")}</p>
                    </div>
                ) : sites.length === 0 ? (
                    <EmptyState icon="fa-sitemap" title={t("network.emptyTitle")} description={t("network.emptyDescription")} />
                ) : (
                    <ul className="divide-y divide-gray-50">
                        {sites.map((site) => (
                            <li key={site.id} className="p-6 md:p-8 flex items-start justify-between gap-4 flex-wrap">
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-3 mb-1 flex-wrap">
                                        <a href={site.url} target="_blank" rel="noopener noreferrer" className="text-lg font-bold text-gray-700 tracking-tight break-all hover:text-blue-600">{site.host}</a>
                                        {site.main && <StatusBadge status="info" label={t("network.mainSite")} />}
                                        {site.status === "active"
                                            ? <StatusBadge status="success" label={t("network.statusActive")} />
                                            : <StatusBadge status="warning" label={t("network.statusSuspended")} />}
                                    </div>
                                    <div className="text-xs text-gray-400">
                                        <code className="font-mono">{site.slug}</code>
                                        <span className="mx-2">·</span>
                                        {t("network.createdAt")} {fmtDate(site.createdAt)}
                                    </div>
                                    {(() => {
                                        const q = quotaFor(site.id);
                                        if (!q) return null;
                                        const over = q.effectiveQuota !== null && q.used !== null && q.used >= q.effectiveQuota;
                                        return (
                                            <div className={`text-xs mt-2 ${over ? "text-red-600 font-bold" : "text-gray-500"}`} data-site-usage={site.id}>
                                                {q.used === null
                                                    ? t("network.quotaUnknown")
                                                    : q.effectiveQuota === null
                                                        ? t("network.quotaUsageUnlimited").replace("{used}", fmtBytes(q.used))
                                                        : t("network.quotaUsage").replace("{used}", fmtBytes(q.used)).replace("{quota}", fmtBytes(q.effectiveQuota))}
                                            </div>
                                        );
                                    })()}
                                    {!site.main && quotas && (
                                        <div className="mt-3 flex flex-wrap items-end gap-3" data-site-quota={site.id}>
                                            <div className="w-full sm:w-56">
                                                <Input label={t("network.quotaSite")} icon="fa-hard-drive" value={quotaDraft[String(site.id)] ?? ""} onChange={(e) => setQuotaDraft((d) => ({ ...d, [String(site.id)]: e.target.value }))} inputMode="decimal" placeholder={t("network.quotaFollowsDefault")} />
                                            </div>
                                            <Button variant="secondary" icon="fa-check" loading={busyQuota === String(site.id)} onClick={() => saveQuota(String(site.id), site)}>{t("network.quotaSave")}</Button>
                                        </div>
                                    )}
                                </div>
                                {!site.main && (
                                    <div className="shrink-0 flex flex-col items-end gap-2">
                                        {site.status === "active" ? (
                                            <Button variant="secondary" icon="fa-pause" loading={busyId === site.id} onClick={() => changeStatus(site, "suspend")}>{t("network.suspend")}</Button>
                                        ) : (
                                            <div className="flex flex-wrap gap-2 justify-end">
                                                <Button variant="secondary" icon="fa-play" loading={busyId === site.id} onClick={() => changeStatus(site, "resume")}>{t("network.resume")}</Button>
                                                {deleting?.id !== site.id && (
                                                    <Button variant="danger" icon="fa-trash" onClick={() => setDeleting({ id: site.id, slug: "" })} data-delete-site={site.id}>{t("network.delete")}</Button>
                                                )}
                                            </div>
                                        )}
                                        {site.status !== "active" && deleting?.id === site.id && (
                                            <div className="w-full sm:w-72 rounded-xl border border-red-100 bg-red-50 p-3 text-left" data-delete-confirm={site.id}>
                                                <p className="text-xs text-red-700 mb-2">{t("network.deleteWarning").replace("{slug}", site.slug)}</p>
                                                <Input label={t("network.deleteConfirmLabel")} icon="fa-keyboard" value={deleting.slug} onChange={(e) => setDeleting({ id: site.id, slug: e.target.value })} autoComplete="off" />
                                                <div className="mt-2 flex gap-2 justify-end">
                                                    <Button variant="secondary" onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
                                                    <Button variant="danger" icon="fa-trash" loading={busyId === site.id} disabled={deleting.slug !== site.slug} onClick={() => removeSite(site)}>{t("network.deleteConfirm")}</Button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </Card>

            <Card variant="default" padding="none" className="mt-8">
                <div className="p-6 md:p-8 border-b border-gray-50">
                    <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 flex items-center gap-2 mb-2">
                        <i className="fa-solid fa-plug text-blue-500"></i>
                        {t("network.plugins")}
                    </h2>
                    <p className="text-xs text-gray-500">{t("network.pluginsHint")}</p>
                </div>
                {!loading && netPlugins.length === 0 ? (
                    <EmptyState icon="fa-plug" title={t("network.pluginsEmpty")} description="" />
                ) : (
                    <ul className="divide-y divide-gray-50">
                        {netPlugins.map((plugin) => {
                            const offered = plugin.ceiling !== null;
                            const draft = new Set(ceilingDraft[plugin.slug] || []);
                            return (
                                <li key={plugin.slug} className="p-6 md:p-8" data-network-plugin={plugin.slug}>
                                    <div className="flex items-start justify-between gap-4 flex-wrap mb-3">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-3 flex-wrap">
                                                <span className="text-base font-bold text-gray-700 break-all">{plugin.name}</span>
                                                <code className="text-xs text-gray-400 font-mono">{plugin.slug}{plugin.version ? ` · v${plugin.version}` : ""}</code>
                                                {offered
                                                    ? <StatusBadge status="success" label={t("network.pluginOffered")} />
                                                    : <StatusBadge status="info" label={t("network.pluginMainOnly")} />}
                                            </div>
                                        </div>
                                        <div className="flex gap-2 shrink-0 flex-wrap">
                                            <Button variant="secondary" icon="fa-check" loading={busyPlugin === plugin.slug} onClick={() => offerPlugin(plugin)}>
                                                {offered ? t("network.saveCeiling") : t("network.offer")}
                                            </Button>
                                            {offered && (
                                                <Button variant="secondary" icon="fa-ban" loading={busyPlugin === plugin.slug} onClick={() => withdrawPlugin(plugin)}>{t("network.withdraw")}</Button>
                                            )}
                                        </div>
                                    </div>
                                    <div className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-2">{t("network.pluginCeiling")}</div>
                                    {plugin.requestedPermissions.length === 0 ? (
                                        <p className="text-xs text-gray-500">{t("network.pluginNoPermissions")}</p>
                                    ) : (
                                        <div className="flex flex-wrap gap-2">
                                            {plugin.requestedPermissions.map((token) => (
                                                <label key={token} className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-mono cursor-pointer ${draft.has(token) ? "bg-blue-50 border-blue-200 text-blue-700" : "bg-gray-50 border-gray-200 text-gray-500"}`}>
                                                    <input type="checkbox" checked={draft.has(token)} onChange={() => toggleCeiling(plugin.slug, token)} data-ceiling-token={token} />
                                                    {token}
                                                </label>
                                            ))}
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </Card>
        </div>
    );
}
