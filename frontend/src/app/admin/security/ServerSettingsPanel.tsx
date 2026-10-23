"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPut } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import { Button, Input, Select } from "@/components/ui";

/**
 * Security → Server: the reverse-proxy trust and the log level, which used to need an edit of
 * wordjs-config.json (or WORDJS_TRUST_PROXY / LOG_LEVEL) and a manual restart. Saving asks for the
 * password, is audited, and the backend restarts itself (backend routes/server-settings.ts,
 * core/restart); this panel waits for it and reloads.
 */

interface ServerSettings {
    trustProxy: { value: string | null; inForce: string | null; fromEnvironment: boolean; appliesToGateway: boolean };
    logLevel: { value: string | null; inForce: string; fromEnvironment: boolean };
    restart: { mode: string; automatic: boolean } | string | null;
}

const PRESETS: Array<{ value: string; key: string }> = [
    { value: "", key: "server.trust.auto" },
    { value: "loopback", key: "server.trust.loopback" },
    { value: "loopback, uniquelocal", key: "server.trust.private" },
    { value: "custom", key: "server.trust.custom" },
];

export default function ServerSettingsPanel() {
    const { t } = useI18n();
    const [data, setData] = useState<ServerSettings | null>(null);
    const [choice, setChoice] = useState("");
    const [custom, setCustom] = useState("");
    const [level, setLevel] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ kind: "error" | "ok"; text: string } | null>(null);

    const load = async () => {
        try {
            const d = await apiGet<ServerSettings>("/system/server");
            setData(d);
            const v = d.trustProxy.value || "";
            const preset = PRESETS.find((p) => p.value === v && p.value !== "custom");
            setChoice(preset ? preset.value : "custom");
            setCustom(preset ? "" : v);
            setLevel(d.logLevel.value || "");
        } catch (e: any) {
            setMessage({ kind: "error", text: e?.message || t("server.loadFailed") });
        }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { load(); }, []);

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        setMessage(null);
        setBusy(true);
        try {
            const trustProxy = choice === "custom" ? custom.trim() : choice;
            const r = await apiPut<ServerSettings>("/system/server", { trustProxy: trustProxy || null, logLevel: level || null, currentPassword: password });
            setPassword("");
            if (r.restart === "manual") {
                setMessage({ kind: "ok", text: t("server.savedManual") });
                return;
            }
            setMessage({ kind: "ok", text: t("server.restarting") });
            await new Promise((res) => setTimeout(res, 3000));
            for (let i = 0; i < 120; i++) {
                try { await apiGet("/system/server"); break; } catch { await new Promise((res) => setTimeout(res, 1000)); }
            }
            window.location.reload();
        } catch (err: any) {
            setMessage({ kind: "error", text: err?.message || t("server.saveFailed") });
        } finally {
            setBusy(false);
        }
    };

    if (!data) return <p className="text-sm text-gray-500">{message?.text || t("loading")}</p>;

    return (
        <form onSubmit={save} className="space-y-6" data-testid="server-settings">
            <div className="space-y-2">
                <Select
                    id="server-trust"
                    label={t("server.trust.label")}
                    value={choice}
                    onChange={setChoice}
                    options={PRESETS.map((p) => ({ value: p.value, label: t(p.key) }))}
                    help={t("server.trust.help")}
                />
                {choice === "custom" && (
                    <Input size="md" aria-label={t("server.trust.custom")} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="10.0.0.0/8, 192.168.1.5" className="font-mono" />
                )}
                {data.trustProxy.appliesToGateway && <p className="text-xs text-amber-700">{t("server.trust.split")}</p>}
                {data.trustProxy.fromEnvironment && <p className="text-xs text-amber-700">{t("server.trust.env")}</p>}
            </div>
            <Select
                id="server-log-level"
                label={t("server.log.label")}
                value={level}
                onChange={setLevel}
                disabled={data.logLevel.fromEnvironment}
                options={[
                    { value: "", label: t("server.log.default") },
                    ...["error", "warn", "info", "debug"].map((l) => ({ value: l, label: l })),
                ]}
                help={data.logLevel.fromEnvironment ? t("server.log.env").replace("{level}", data.logLevel.inForce) : t("server.log.help")}
            />
            <Input
                id="server-password"
                size="md"
                type="password"
                revealable
                label={t("network.currentPassword")}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                containerClassName="md:w-80"
                required
            />
            {message && (
                <p role={message.kind === "error" ? "alert" : "status"} className={`text-sm ${message.kind === "error" ? "text-red-600" : "text-emerald-700"}`}>{message.text}</p>
            )}
            <div className="flex items-center justify-between gap-4 flex-wrap">
                <p className="text-xs text-gray-400">{t("server.restartNote")}</p>
                <Button type="submit" size="md" pending={busy}>
                    {t("server.save")}
                </Button>
            </div>
        </form>
    );
}
