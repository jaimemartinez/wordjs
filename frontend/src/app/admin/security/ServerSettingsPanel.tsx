"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPut } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";

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

    const input = "w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none text-gray-800";
    return (
        <form onSubmit={save} className="space-y-6" data-testid="server-settings">
            <div className="space-y-2">
                <label htmlFor="server-trust" className="text-sm font-bold text-gray-700 uppercase tracking-wide">{t("server.trust.label")}</label>
                <select id="server-trust" value={choice} onChange={(e) => setChoice(e.target.value)} className={input}>
                    {PRESETS.map((p) => <option key={p.value} value={p.value}>{t(p.key)}</option>)}
                </select>
                {choice === "custom" && (
                    <input aria-label={t("server.trust.custom")} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="10.0.0.0/8, 192.168.1.5" className={`${input} font-mono`} />
                )}
                <p className="text-xs text-gray-500">{t("server.trust.help")}</p>
                {data.trustProxy.appliesToGateway && <p className="text-xs text-amber-700">{t("server.trust.split")}</p>}
                {data.trustProxy.fromEnvironment && <p className="text-xs text-amber-700">{t("server.trust.env")}</p>}
            </div>
            <div className="space-y-2">
                <label htmlFor="server-log-level" className="text-sm font-bold text-gray-700 uppercase tracking-wide">{t("server.log.label")}</label>
                <select id="server-log-level" value={level} onChange={(e) => setLevel(e.target.value)} className={input} disabled={data.logLevel.fromEnvironment}>
                    <option value="">{t("server.log.default")}</option>
                    <option value="error">error</option>
                    <option value="warn">warn</option>
                    <option value="info">info</option>
                    <option value="debug">debug</option>
                </select>
                <p className="text-xs text-gray-500">{data.logLevel.fromEnvironment ? t("server.log.env").replace("{level}", data.logLevel.inForce) : t("server.log.help")}</p>
            </div>
            <div className="space-y-2 md:w-80">
                <label htmlFor="server-password" className="text-sm font-bold text-gray-700 uppercase tracking-wide">{t("network.currentPassword")}</label>
                <input id="server-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} required />
            </div>
            {message && (
                <p role={message.kind === "error" ? "alert" : "status"} className={`text-sm ${message.kind === "error" ? "text-red-600" : "text-emerald-700"}`}>{message.text}</p>
            )}
            <div className="flex items-center justify-between gap-4 flex-wrap">
                <p className="text-xs text-gray-400">{t("server.restartNote")}</p>
                <button type="submit" disabled={busy} className="bg-gray-900 text-white font-bold px-6 py-3 rounded-xl disabled:opacity-50">
                    {busy ? <i className="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> : t("server.save")}
                </button>
            </div>
        </form>
    );
}
