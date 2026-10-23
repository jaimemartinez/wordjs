"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";

/**
 * Settings → Performance: the Redis server the object cache and the cluster bus use (QA M2-09). It used to
 * be settable only in wordjs-config.json or REDIS_* variables, while the cache switch said «Redis is active»
 * with no server at all. This panel shows the REAL state of the connection, tries a server before saving,
 * and saves it (password, audited); the backend then restarts itself to connect (backend
 * routes/redis-settings.ts). It sits inside the settings page's form, so it has buttons, not a form.
 */

interface RedisState {
    enabled: boolean;
    host: string;
    port: number;
    db: number;
    passwordSet: boolean;
    fromEnvironment: boolean;
    inForce: { configured: boolean; connected: boolean; host: string | null; port: number | null };
    restart: unknown;
}

type Message = { kind: "error" | "ok" | "info"; text: string } | null;

export default function RedisServerPanel({ cacheOn }: { cacheOn: boolean }) {
    const { t } = useI18n();
    const [data, setData] = useState<RedisState | null>(null);
    const [hidden, setHidden] = useState(false);
    const [enabled, setEnabled] = useState(false);
    const [host, setHost] = useState("127.0.0.1");
    const [port, setPort] = useState("6379");
    const [db, setDb] = useState("0");
    const [password, setPassword] = useState("");
    const [removePassword, setRemovePassword] = useState(false);
    const [currentPassword, setCurrentPassword] = useState("");
    const [busy, setBusy] = useState<"" | "test" | "save">("");
    const [message, setMessage] = useState<Message>(null);

    useEffect(() => {
        apiGet<RedisState>("/system/redis")
            .then((d) => {
                setData(d);
                setEnabled(d.enabled);
                setHost(d.host);
                setPort(String(d.port));
                setDb(String(d.db));
            })
            // Not an administrator of the main site: the switch above still works; this panel is not theirs.
            .catch(() => setHidden(true));
    }, []);

    if (hidden || !data) return null;

    const target = () => ({
        host: host.trim(),
        port: Number(port) || 6379,
        db: Number(db) || 0,
        ...(removePassword ? { password: "" } : password ? { password } : {}),
    });

    const test = async () => {
        setMessage(null);
        setBusy("test");
        try {
            const r = await apiPost<{ ok: boolean; reason?: string }>("/system/redis/test", target());
            setMessage(r.ok
                ? { kind: "ok", text: t("settings.redisServer.testOk") }
                : { kind: "error", text: t(`settings.redisServer.reason.${r.reason || "failed"}`) });
        } catch (e: any) {
            setMessage({ kind: "error", text: e?.message || t("settings.redisServer.reason.failed") });
        } finally {
            setBusy("");
        }
    };

    const save = async () => {
        setMessage(null);
        setBusy("save");
        try {
            const r = await apiPut<RedisState & { restart: string | null }>("/system/redis", { enabled, ...target(), currentPassword });
            setCurrentPassword("");
            setPassword("");
            setRemovePassword(false);
            if (r.restart === null) { setData(r); setMessage({ kind: "info", text: t("settings.redisServer.unchanged") }); return; }
            if (r.restart === "manual") { setData(r); setMessage({ kind: "ok", text: t("server.savedManual") }); return; }
            setMessage({ kind: "ok", text: t("server.restarting") });
            await new Promise((res) => setTimeout(res, 3000));
            for (let i = 0; i < 120; i++) {
                try { await apiGet("/system/redis"); break; } catch { await new Promise((res) => setTimeout(res, 1000)); }
            }
            window.location.reload();
        } catch (e: any) {
            setMessage({ kind: "error", text: e?.message || t("server.saveFailed") });
        } finally {
            setBusy("");
        }
    };

    const where = data.inForce.host ? `${data.inForce.host}:${data.inForce.port}` : "";
    const status = data.inForce.connected
        ? { tone: "bg-emerald-50 border-emerald-100 text-emerald-800", icon: "fa-circle-check text-emerald-500", text: t("settings.redisServer.connected").replace("{where}", where) }
        : data.inForce.configured
            ? { tone: "bg-amber-50 border-amber-100 text-amber-800", icon: "fa-triangle-exclamation text-amber-500", text: t("settings.redisServer.down").replace("{where}", where) }
            : { tone: "bg-gray-50 border-gray-200 text-gray-700", icon: "fa-circle-info text-gray-400", text: t(cacheOn ? "settings.redisServer.noneCacheOn" : "settings.redisServer.none") };

    const input = "w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none text-gray-800 disabled:opacity-60";
    const label = "text-xs font-bold text-gray-600 uppercase tracking-wide block mb-1.5";

    return (
        <div className="space-y-5" data-testid="redis-server">
            <div role="status" className={`p-4 rounded-xl border flex items-start gap-3 ${status.tone}`}>
                <i className={`fa-solid ${status.icon} mt-0.5`} aria-hidden="true"></i>
                <p className="text-xs leading-relaxed">{status.text}</p>
            </div>
            {data.fromEnvironment && <p className="text-xs text-amber-700">{t("settings.redisServer.env")}</p>}

            <label className="flex items-start gap-3 cursor-pointer min-h-11">
                <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                <span>
                    <span className="text-sm font-bold text-gray-800">{t("settings.redisServer.use")}</span>
                    <span className="block text-xs text-gray-500 mt-0.5">{t("settings.redisServer.useHelp")}</span>
                </span>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="sm:col-span-2">
                    <label htmlFor="redis-host" className={label}>{t("settings.redisServer.host")}</label>
                    <input id="redis-host" className={`${input} font-mono`} value={host} disabled={!enabled} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" />
                </div>
                <div>
                    <label htmlFor="redis-port" className={label}>{t("settings.redisServer.port")}</label>
                    <input id="redis-port" type="number" min={1} max={65535} inputMode="numeric" className={input} value={port} disabled={!enabled} onChange={(e) => setPort(e.target.value)} />
                </div>
                <div>
                    <label htmlFor="redis-db" className={label}>{t("settings.redisServer.db")}</label>
                    <input id="redis-db" type="number" min={0} max={255} inputMode="numeric" className={input} value={db} disabled={!enabled} onChange={(e) => setDb(e.target.value)} />
                </div>
                <div className="sm:col-span-2">
                    <label htmlFor="redis-password" className={label}>{t("settings.redisServer.password")}</label>
                    <input
                        id="redis-password"
                        type="password"
                        autoComplete="new-password"
                        className={input}
                        value={password}
                        disabled={!enabled || removePassword}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={data.passwordSet ? t("settings.redisServer.passwordKept") : t("settings.redisServer.passwordNone")}
                    />
                    {data.passwordSet && (
                        <label className="mt-2 flex items-center gap-2 text-xs text-gray-600 min-h-8">
                            <input type="checkbox" checked={removePassword} disabled={!enabled} onChange={(e) => setRemovePassword(e.target.checked)} />
                            {t("settings.redisServer.removePassword")}
                        </label>
                    )}
                </div>
            </div>

            <div className="flex flex-wrap items-end gap-4">
                <button type="button" onClick={test} disabled={!enabled || !!busy || !host.trim()} className="min-h-11 px-5 rounded-xl border border-gray-200 bg-white font-bold text-sm text-gray-800 hover:bg-gray-50 disabled:opacity-50">
                    {busy === "test" ? <i className="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> : t("settings.redisServer.test")}
                </button>
                <div className="flex-1 min-w-[12rem] max-w-xs">
                    <label htmlFor="redis-current-password" className={label}>{t("network.currentPassword")}</label>
                    <input id="redis-current-password" type="password" autoComplete="current-password" className={input} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
                </div>
                <button type="button" onClick={save} disabled={!!busy || !currentPassword} className="min-h-11 px-5 rounded-xl bg-gray-900 text-white font-bold text-sm disabled:opacity-50">
                    {busy === "save" ? <i className="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> : t("settings.redisServer.save")}
                </button>
            </div>
            {message && (
                <p role={message.kind === "error" ? "alert" : "status"} className={`text-sm ${message.kind === "error" ? "text-red-600" : message.kind === "ok" ? "text-emerald-700" : "text-gray-600"}`}>{message.text}</p>
            )}
            <p className="text-xs text-gray-400">{t("settings.redisServer.restartNote")}</p>
        </div>
    );
}
