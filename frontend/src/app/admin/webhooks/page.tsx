"use client";

import { useEffect, useState } from "react";
import { webhooksApi, Webhook, WebhookDelivery, WebhookEventGroup } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { formatServerTimestamp } from "@/lib/serverTimestamp";
import { PageHeader, Button, Card, EmptyState, Input, StatusBadge } from "@/components/ui";
import SecretRevealModal from "@/components/SecretRevealModal";

const FALLBACK_EVENTS = ["post.created", "post.published", "post.updated", "post.deleted", "comment.created", "comment.deleted"];

// Icon per entity of the catalogue (GET /webhooks/events → groups). An entity this list does not know
// still renders, with a generic icon, so a newer backend never breaks the picker.
const GROUP_ICONS: Record<string, string> = {
    post: "fa-file-lines",
    comment: "fa-comments",
    user: "fa-user",
    media: "fa-image",
    term: "fa-tags",
    menu: "fa-bars",
    plugin: "fa-plug",
    theme: "fa-palette",
    settings: "fa-gear",
};

/** Group a flat event list by its `entity.` prefix (fallback for a backend that sends no groups). */
const groupEvents = (events: string[]): WebhookEventGroup[] => {
    const out: WebhookEventGroup[] = [];
    for (const ev of events) {
        const entity = ev.split(".")[0];
        const g = out.find((x) => x.entity === entity);
        if (g) g.events.push(ev); else out.push({ entity, events: [ev] });
    }
    return out;
};

// Delivery rows carry SQL UTC text, the webhook's last delivery epoch seconds: both in local time.
const fmtDate = formatServerTimestamp;

const deliveryStatusType = (s: string) => (s === "success" ? "success" : s === "dead" ? "error" : s === "delivering" ? "info" : "warning");

export default function WebhooksPage() {
    const { confirm } = useModal();
    const { addToast } = useToast();
    const { t } = useI18n();
    const [webhooks, setWebhooks] = useState<Webhook[]>([]);
    const [groups, setGroups] = useState<WebhookEventGroup[]>(() => groupEvents(FALLBACK_EVENTS));
    const [optIn, setOptIn] = useState<string[]>([]);
    const [pinging, setPinging] = useState<number | null>(null);
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
        webhooksApi.events().then((r) => {
            setGroups(r.groups && r.groups.length ? r.groups : groupEvents(r.events));
            setOptIn(r.optIn || []);
        }).catch(() => { /* keep fallback */ });
    }, []);

    const toggleEvent = (ev: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            next.has(ev) ? next.delete(ev) : next.add(ev);
            return next;
        });
    };

    // "All of this entity" = the family wildcard (`post.*`). It replaces the family's individual picks,
    // which it already covers — except an opt-in event, which no wildcard includes and stays separate.
    const toggleFamily = (g: WebhookEventGroup) => {
        const wildcard = `${g.entity}.*`;
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(wildcard)) next.delete(wildcard);
            else {
                next.add(wildcard);
                for (const ev of g.events) if (!optIn.includes(ev)) next.delete(ev);
            }
            return next;
        });
    };

    const eventLabel = (ev: string) => {
        if (ev.endsWith(".*")) return `${t(`webhooks.group.${ev.slice(0, -2)}`)} · ${t("webhooks.allInGroup")}`;
        return ev;
    };

    const sendTest = async (w: Webhook) => {
        setPinging(w.id);
        try {
            const { delivered, delivery } = await webhooksApi.ping(w.id);
            if (delivered) {
                addToast(t("webhooks.testDelivered").replace("{status}", String(delivery?.responseStatus ?? "")), "success");
            } else {
                const reason = delivery?.responseStatus != null ? `HTTP ${delivery.responseStatus}` : (delivery?.error || "—");
                addToast(t("webhooks.testFailed").replace("{reason}", reason), "error");
            }
            await load();
            if (expandedId === w.id) {
                const { deliveries } = await webhooksApi.deliveries(w.id);
                setDeliveries(deliveries);
            }
        } catch (e: any) {
            addToast(e?.message || t("webhooks.testFailed").replace("{reason}", "—"), "error");
        } finally {
            setPinging(null);
        }
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
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                            {groups.map((g) => {
                                const familyOn = selected.has(`${g.entity}.*`);
                                return (
                                    <div key={g.entity} role="group" aria-label={t(`webhooks.group.${g.entity}`)} className="rounded-2xl border border-gray-100 bg-white p-4 min-w-0">
                                        <div className="flex items-center justify-between gap-2 mb-3">
                                            <span className="text-[11px] font-black uppercase tracking-widest text-gray-500 flex items-center gap-2">
                                                <i className={`fa-solid ${GROUP_ICONS[g.entity] || "fa-bolt"} text-blue-500`}></i>
                                                {t(`webhooks.group.${g.entity}`)}
                                            </span>
                                            {g.events.length > 1 && (
                                                <button
                                                    type="button"
                                                    onClick={() => toggleFamily(g)}
                                                    aria-pressed={familyOn}
                                                    aria-label={eventLabel(g.entity + ".*")}
                                                    title={`${g.entity}.*`}
                                                    className={`text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-lg transition-all ${familyOn ? "bg-blue-500 text-white" : "bg-gray-50 text-gray-400 hover:text-blue-600"}`}
                                                >
                                                    {t("webhooks.allInGroup")}
                                                </button>
                                            )}
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                            {g.events.map((ev) => {
                                                const isOptIn = optIn.includes(ev);
                                                const covered = familyOn && !isOptIn;
                                                const on = covered || selected.has(ev);
                                                return (
                                                    <button
                                                        key={ev}
                                                        type="button"
                                                        onClick={() => { if (!covered) toggleEvent(ev); }}
                                                        aria-pressed={on}
                                                        aria-label={isOptIn ? ev + " (" + t("webhooks.optIn") + ")" : ev}
                                                        disabled={covered}
                                                        title={isOptIn ? t("webhooks.optInHint") : ev}
                                                        className={`text-xs font-bold px-3 py-2 rounded-xl border-2 transition-all ${on ? "bg-blue-500 border-blue-500 text-white shadow-sm" : "bg-white border-gray-100 text-gray-500 hover:border-blue-200"} ${covered ? "opacity-70 cursor-default" : ""}`}
                                                    >
                                                        <i className={`fa-solid ${on ? "fa-check" : "fa-plus"} mr-1.5 text-[10px]`}></i>
                                                        {ev.slice(g.entity.length + 1) || ev}
                                                        {isOptIn && <span className={`ml-1.5 text-[9px] font-black uppercase tracking-wider ${on ? "text-blue-100" : "text-amber-500"}`}>{t("webhooks.optIn")}</span>}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
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
                                                    <span key={ev} title={ev} className="text-[10px] font-black uppercase tracking-wider text-indigo-600 bg-indigo-50 px-2 py-1 rounded-md">{eventLabel(ev)}</span>
                                                ))}
                                            </div>
                                            <div className="text-xs text-gray-400 mt-3">
                                                <i className="fa-solid fa-key mr-1"></i><code className="font-mono">{w.secretPrefix}…</code>
                                                <span className="mx-2">·</span>
                                                {t("webhooks.lastDelivery")} {fmtDate(w.lastDeliveryAt)}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            <button onClick={() => sendTest(w)} disabled={!w.active || pinging === w.id} title={w.active ? t("webhooks.sendTest") : t("webhooks.testPaused")} aria-label={t("webhooks.sendTest")} className="h-10 shrink-0 px-3 rounded-xl bg-gray-50 text-gray-500 hover:bg-blue-600 hover:text-white disabled:opacity-40 disabled:hover:bg-gray-50 disabled:hover:text-gray-500 flex items-center gap-2 text-xs font-bold transition-all">
                                                <i className={`fa-solid ${pinging === w.id ? "fa-spinner fa-spin" : "fa-paper-plane"} text-xs`}></i>
                                                <span className="hidden sm:inline">{t("webhooks.sendTest")}</span>
                                            </button>
                                            <button onClick={() => openDeliveries(w)} title={t("webhooks.deliveries")} className="w-10 h-10 shrink-0 rounded-xl bg-gray-50 text-gray-500 hover:bg-gray-200 flex items-center justify-center transition-all">
                                                <i className={`fa-solid ${expandedId === w.id ? "fa-chevron-up" : "fa-list"} text-xs`}></i>
                                            </button>
                                            <button onClick={() => toggleActive(w)} title={w.active ? t("webhooks.pause") : t("webhooks.resume")} className="w-10 h-10 shrink-0 rounded-xl bg-gray-50 text-gray-500 hover:bg-gray-200 flex items-center justify-center transition-all">
                                                <i className={`fa-solid ${w.active ? "fa-pause" : "fa-play"} text-xs`}></i>
                                            </button>
                                            <button onClick={() => rotate(w)} title={t("webhooks.rotateTitle")} className="w-10 h-10 shrink-0 rounded-xl bg-gray-50 text-gray-500 hover:bg-amber-500 hover:text-white flex items-center justify-center transition-all">
                                                <i className="fa-solid fa-rotate text-xs"></i>
                                            </button>
                                            <button onClick={() => remove(w)} title={t("common.delete")} className="w-10 h-10 shrink-0 rounded-xl bg-gray-50 text-gray-400 hover:bg-red-600 hover:text-white flex items-center justify-center transition-all">
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
