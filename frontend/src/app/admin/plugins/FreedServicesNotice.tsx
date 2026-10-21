"use client";

/**
 * "Postfix was turned off so that <plugin> could use port 25 — turn it back on?"
 *
 * Freeing a claimed port (Plugins → a plugin's "Free port 25") disables the system mail service for good,
 * so it does not take the port back at boot. Once that plugin is deactivated or deleted nothing listens
 * on the port any more and the machine stops receiving mail with the system service still off. The
 * backend records each liberation (core/port-conflicts); this notice lists the ones whose plugin is no
 * longer active and turns the service back on after an explicit confirmation.
 */
import { useEffect, useState } from "react";
import { pluginsApi } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { Button } from "@/components/ui";

type Freed = { slug: string; port: number; service: string; label: string; at: string; pluginActive: boolean };

export default function FreedServicesNotice({ refreshKey }: { refreshKey?: unknown }) {
    const { t } = useI18n();
    const { confirm } = useModal();
    const { addToast } = useToast();
    const [items, setItems] = useState<Freed[]>([]);
    const [busy, setBusy] = useState<string | null>(null);

    const load = () => {
        if (typeof pluginsApi.freedServices !== 'function') return;
        pluginsApi.freedServices()
            .then((r) => setItems((r && r.services) || []))
            .catch(() => setItems([]));
    };
    useEffect(load, [refreshKey]);

    const waiting = items.filter((i) => !i.pluginActive);
    if (waiting.length === 0) return null;

    const restore = async (it: Freed) => {
        const fill = (s: string) => s.replace("{service}", it.label).replace("{plugin}", it.slug).replace("{port}", String(it.port));
        if (!(await confirm(fill(t("plugins.freed.confirm")), fill(t("plugins.freed.confirmTitle"))))) return;
        setBusy(it.service);
        try {
            await pluginsApi.restoreFreedService(it.service);
            addToast(fill(t("plugins.freed.done")), "success");
            load();
        } catch (e: any) {
            addToast(e?.message || fill(t("plugins.freed.failed")), "error");
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="mb-6 space-y-2" data-testid="freed-services-notice">
            {waiting.map((it) => {
                const fill = (s: string) => s.replace("{service}", it.label).replace("{plugin}", it.slug).replace("{port}", String(it.port));
                return (
                    <div key={it.service} className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 sm:flex-row sm:items-center">
                        <i className="fa-solid fa-plug-circle-exclamation text-amber-500 text-lg" aria-hidden="true"></i>
                        <p className="flex-1 text-sm text-amber-900 leading-relaxed">{fill(t("plugins.freed.notice"))}</p>
                        <Button size="sm" variant="secondary" icon="fa-power-off" loading={busy === it.service} onClick={() => restore(it)}>
                            {fill(t("plugins.freed.action"))}
                        </Button>
                    </div>
                );
            })}
        </div>
    );
}
