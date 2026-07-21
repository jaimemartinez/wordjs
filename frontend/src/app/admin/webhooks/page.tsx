"use client";

import { useEffect, useState } from "react";
import { webhooksApi, Webhook, WebhookDelivery } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { PageHeader, Button, Card, EmptyState, Input, StatusBadge } from "@/components/ui";
import SecretRevealModal from "@/components/SecretRevealModal";

const FALLBACK_EVENTS = ["post.created", "post.published", "post.updated", "post.deleted", "comment.created", "comment.deleted"];

const fmtDate = (v: number | null | string | undefined) => {
    if (v == null) return "—";
    const ms = typeof v === "number" ? v * 1000 : Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toLocaleString() : "—";
};

const deliveryStatusType = (s: string) => (s === "success" ? "success" : s === "dead" ? "error" : s === "delivering" ? "info" : "warning");

export default function WebhooksPage() {
    const { confirm } = useModal();
    const { addToast } = useToast();
    const { t } = useI18n();
    const [webhooks, setWebhooks] = useState<Webhook[]>([]);
    const [catalog, setCatalog] = useState<string[]>(FALLBACK_EVENTS);
    const [loading, setLoading] = useState(true);
    const [revealed, setRevealed] = useState<string | null>(null);

    // create form
    const [name, setName] = useState("");
    const [url, setUrl] = useState("");
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [creating, setCreating] = useState(false);

    // deliveries panel
    const [expandedId, setExpandedId] = useState<number | null>(null);
    const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
    const [deliveriesLoading, setDeliveriesLoading] = useState(false);

    const load = async () => {
        try {
            const { webhooks } = await webhooksApi.list();
            setWebhooks(webhooks);
        } catch (e: any) {
            addToast(e?.message || t("webhooks.loadFailed"), "error");
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => {
        load();
        webhooksApi.events().then((r) => setCatalog(r.events)).catch(() => { /* keep fallback */ });
    }, []);

    const toggleEvent = (ev: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            next.has(ev) ? next.delete(ev) : next.add(ev);
            return next;
        });
    };

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!url.trim()) { addToast(t("webhooks.urlRequired"), "error"); return; }
        setCreating(true);
        try {
            const res = await webhooksApi.create({
                name: name.trim() || undefined,
                url: url.trim(),
                events: selected.size ? Array.from(selected) : undefined, // none selected → all events
            });
            setRevealed(res.secret);
            setName(""); setUrl(""); setSelected(new Set());
            await load();
        } catch (e: any) {
            addToast(e?.message || t("webhooks.createFailed"), "error");
        } finally {
            setCreating(false);
        }
    };

    const toggleActive = async (w: Webhook) => {
        try {
            await webhooksApi.update(w.id, { active: !w.active });
            await load();
        } catch (e: any) {
            addToast(e?.message || t("webhooks.updateFailed"), "error");
        }
    };

    const rotate = async (w: Webhook) => {
        if (!(await confirm(t("webhooks.rotateConfirm").replace("{name}", w.name), t("webhooks.rotateTitle"), true))) return;
        try {
            const res = await webhooksApi.rotateSecret(w.id);
            setRevealed(res.secret);
            await load();
        } catch (e: any) {
            addToast(e?.message || t("webhooks.rotateFailed"), "error");
        }
    };

    const remove = async (w: Webhook) => {
        if (!(await confirm(t("webhooks.deleteConfirm").replace("{name}", w.name), t("webhooks.deleteTitle"), true))) return;
        try {
            await webhooksApi.remove(w.id);
            addToast(t("webhooks.deleted"), "success");
            if (expandedId === w.id) setExpandedId(null);
            await load();
        } catch (e: any) {
            addToast(e?.message || t("webhooks.deleteFailed"), "error");
        }
    };

    const openDeliveries = async (w: Webhook) => {
        if (expandedId === w.id) { setExpandedId(null); return; }
        setExpandedId(w.id);
        setDeliveriesLoading(true);
        try {
            const { deliveries } = await webhooksApi.deliveries(w.id);
            setDeliveries(deliveries);
        } catch (e: any) {
            addToast(e?.message || t("webhooks.deliveriesLoadFailed"), "error");
        } finally {
            setDeliveriesLoading(false);
        }
    };

    const redeliver = async (d: WebhookDelivery, w: Webhook) => {
        try {
            await webhooksApi.redeliver(d.id);
            addToast(t("webhooks.redelivered"), "success");
            const { deliveries } = await webhooksApi.deliveries(w.id);
            setDeliveries(deliveries);
        } catch (e: any) {
            addToast(e?.message || t("webhooks.redeliverFailed"), "error");
        }
    };

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title={t("webhooks.title")}
                subtitle={t("webhooks.subtitle")}
                icon="fa-bolt"
            />

            {/* Create */}
            <Card variant="default" padding="lg" className="mb-8">
                <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-6 flex items-center gap-2">
                    <i className="fa-solid fa-plus-circle text-blue-500"></i>
                    {t("webhooks.newWebhook")}
                </h2>
                <form onSubmit={handleCreate} className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <Input label={t("webhooks.name")} icon="fa-tag" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("webhooks.namePlaceholder")} />
                        <Input label={t("webhooks.payloadUrl")} icon="fa-link" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhook" type="url" required />
                    </div>
                    <div>
                        <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3">
                            {t("webhooks.events")} <span className="text-gray-300 normal-case tracking-normal font-medium">{t("webhooks.eventsHint")}</span>
                        </label>
                        <div className="flex flex-wrap gap-2">
                            {catalog.map((ev) => {
                                const on = selected.has(ev);
                                return (
                                    <button
                                        key={ev}
                                        type="button"
                                        onClick={() => toggleEvent(ev)}
                                        className={`text-xs font-bold px-3 py-2 rounded-xl border-2 transition-all ${on ? "bg-blue-500 border-blue-500 text-white shadow-sm" : "bg-white border-gray-100 text-gray-500 hover:border-blue-200"}`}
                                    >
                                        <i className={`fa-solid ${on ? "fa-check" : "fa-plus"} mr-1.5 text-[10px]`}></i>
                                        {ev}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <Button type="submit" icon="fa-plus" loading={creating}>{t("webhooks.createWebhook")}</Button>
                </form>
            </Card>

            {/* List */}
            <Card variant="default" padding="none">
                {loading ? (
                    <div className="p-20 text-center">
                        <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t("common.loading")}</p>
                    </div>
                ) : webhooks.length === 0 ? (
                    <EmptyState icon="fa-bolt" title={t("webhooks.emptyTitle")} description={t("webhooks.emptyDescription")} />
                ) : (
                    <div className="divide-y divide-gray-50">
                        {webhooks.map((w) => (
                            <div key={w.id}>
                                <div className="p-6 md:p-8 group hover:bg-blue-50/5 transition-colors">
                                    <div className="flex items-start justify-between gap-4 flex-wrap">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-3 mb-1">
                                                <span className="text-lg font-bold text-gray-700 italic tracking-tight truncate">{w.name}</span>
                                                {w.active ? <StatusBadge status="success" label={t("webhooks.statusActive")} /> : <StatusBadge status="neutral" label={t("webhooks.statusPaused")} />}
                                                {w.failureCount > 0 && <StatusBadge status="warning" label={t("webhooks.failsBadge").replace("{count}", String(w.failureCount))} />}
                                            </div>
                                            <code className="text-xs font-mono text-gray-400 break-all">{w.url}</code>
                                            <div className="flex flex-wrap gap-1 mt-3">
                                                {(w.events.includes("*") ? [t("webhooks.allEvents")] : w.events).map((ev) => (
                                                    <span key={ev} className="text-[10px] font-black uppercase tracking-wider text-indigo-600 bg-indigo-50 px-2 py-1 rounded-md">{ev}</span>
                                                ))}
                                            </div>
                                            <div className="text-xs text-gray-400 mt-3">
                                                <i className="fa-solid fa-key mr-1"></i><code className="font-mono">{w.secretPrefix}…</code>
                                                <span className="mx-2">·</span>
                                                {t("webhooks.lastDelivery")} {fmtDate(w.lastDeliveryAt)}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            <button onClick={() => openDeliveries(w)} title={t("webhooks.deliveries")} className="w-10 h-10 rounded-xl bg-gray-50 text-gray-500 hover:bg-gray-200 flex items-center justify-center transition-all">
                                                <i className={`fa-solid ${expandedId === w.id ? "fa-chevron-up" : "fa-list"} text-xs`}></i>
                                            </button>
                                            <button onClick={() => toggleActive(w)} title={w.active ? t("webhooks.pause") : t("webhooks.resume")} className="w-10 h-10 rounded-xl bg-gray-50 text-gray-500 hover:bg-gray-200 flex items-center justify-center transition-all">
                                                <i className={`fa-solid ${w.active ? "fa-pause" : "fa-play"} text-xs`}></i>
                                            </button>
                                            <button onClick={() => rotate(w)} title={t("webhooks.rotateTitle")} className="w-10 h-10 rounded-xl bg-gray-50 text-gray-500 hover:bg-amber-500 hover:text-white flex items-center justify-center transition-all">
                                                <i className="fa-solid fa-rotate text-xs"></i>
                                            </button>
                                            <button onClick={() => remove(w)} title={t("common.delete")} className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-red-600 hover:text-white flex items-center justify-center transition-all">
                                                <i className="fa-solid fa-trash text-xs"></i>
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {expandedId === w.id && (
                                    <div className="bg-gray-50/60 px-6 md:px-8 py-6 border-t border-gray-100">
                                        <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-4">{t("webhooks.recentDeliveries")}</h3>
                                        {deliveriesLoading ? (
                                            <p className="text-xs text-gray-400">{t("common.loading")}</p>
                                        ) : deliveries.length === 0 ? (
                                            <p className="text-xs text-gray-400">{t("webhooks.noDeliveries")}</p>
                                        ) : (
                                            <div className="space-y-2">
                                                {deliveries.map((d) => (
                                                    <div key={d.id} className="flex items-center justify-between gap-4 bg-white rounded-xl px-4 py-3 flex-wrap">
                                                        <div className="flex items-center gap-3 min-w-0">
                                                            <StatusBadge status={deliveryStatusType(d.status)} label={d.status} size="sm" />
                                                            <span className="text-xs font-bold text-gray-600">{d.event}</span>
                                                            <span className="text-xs text-gray-400">
                                                                {d.responseStatus != null ? `HTTP ${d.responseStatus}` : (d.error || "—")}
                                                                {d.attempts > 1 && ` · ${d.attempts} ${t("webhooks.attempts")}`}
                                                            </span>
                                                        </div>
                                                        <div className="flex items-center gap-3">
                                                            <span className="text-[11px] text-gray-400">{fmtDate(d.createdAt)}</span>
                                                            {(d.status === "success" || d.status === "dead") && (
                                                                <button onClick={() => redeliver(d, w)} title={t("webhooks.redeliver")} className="text-xs font-bold text-blue-600 hover:text-blue-800">
                                                                    <i className="fa-solid fa-paper-plane mr-1"></i>{t("webhooks.redeliver")}
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </Card>

            <SecretRevealModal
                secret={revealed}
                title={t("webhooks.secretTitle")}
                description={t("webhooks.secretDescription")}
                onClose={() => setRevealed(null)}
            />
        </div>
    );
}
