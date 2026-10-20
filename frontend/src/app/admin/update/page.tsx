"use client";

import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import { useToast } from "@/contexts/ToastContext";
import { useModal } from "@/contexts/ModalContext";
import { PageHeader, Button, Card, Input } from "@/components/ui";

/**
 * Admin → Updates (backend core/updater, routes/update.ts): is a newer WordJS out, what it changes (the
 * release notes), and installing it with one click — a backup first, the official `create-wordjs
 * upgrade` (it verifies the bundle's SHA-256), a restart, and the previous version put back if anything
 * fails. Where the panel may not update (a container, a git checkout, split mode, code it cannot write),
 * the screen says what to do instead.
 */

interface Release { tag: string; version: string; name: string; publishedAt: string; notes: string; url: string; hasChecksum: boolean }
interface UpdateState { state: string; step?: string; from?: string; to?: string; error?: string; backup?: string | null; finishedAt?: string }
interface Overview {
    current: string;
    latest: Release | null;
    newer: Release[];
    environment: { canUpdate: boolean; reason: string | null; how: string };
    state: UpdateState;
    output: string[];
    running: boolean;
    error: string | null;
    checkedAt: string | null;
}

export default function UpdatePage() {
    const { t } = useI18n();
    const { addToast } = useToast();
    const { confirm } = useModal();
    const [data, setData] = useState<Overview | null>(null);
    const [password, setPassword] = useState("");
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [following, setFollowing] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    const load = async (check = false) => {
        try {
            const d = check ? await apiPost<Overview>("/system/update/check", {}) : await apiGet<Overview>("/system/update");
            if (alive.current) setData(d);
            return d;
        } catch (e: any) {
            if (alive.current && !following) setLoadError(e?.message || t("update.loadFailed"));
            return null;
        }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { load(); }, []);

    /** Follow the update through the restart: the old process reports progress, then the new one comes up. */
    const follow = async () => {
        setFollowing(true);
        for (let i = 0; i < 900 && alive.current; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const d = await load();
            if (d && !d.running && ["done", "failed", "rolled_back"].includes(d.state.state)) break;
        }
        if (alive.current) { setFollowing(false); window.location.reload(); }
    };
    // A page opened while an update runs follows it too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { if (data && (data.running || data.state.state === "running" || data.state.state === "applied") && !following) follow(); }, [data?.running, data?.state.state]);

    const install = async (rel: Release) => {
        if (!(await confirm(t("update.confirm").replace("{from}", data!.current).replace("{to}", rel.version), t("update.confirmTitle")))) return;
        setBusy(true);
        try {
            await apiPost("/system/update", { tag: rel.tag, currentPassword: password, mfaCode: code.trim() });
            setPassword(""); setCode("");
            await load();
            follow();
        } catch (e: any) {
            addToast(e?.message || t("update.failed"), "error");
        } finally { setBusy(false); }
    };

    const shell = (children: React.ReactNode) => (
        <div className="p-4 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full">
            <PageHeader title={t("update.title")} subtitle={t("update.subtitle")} icon="fa-cloud-arrow-down"
                actions={<Button variant="secondary" icon="fa-rotate" onClick={() => load(true)}>{t("update.checkNow")}</Button>} />
            <div className="max-w-4xl space-y-6">{children}</div>
        </div>
    );
    if (!data) return shell(<Card variant="default" padding="lg"><p role={loadError ? "alert" : undefined} className={`text-sm ${loadError ? "text-red-600" : "text-gray-500"}`}>{loadError || t("loading")}</p></Card>);

    const s = data.state;
    const progress = (data.running || following || s.state === "running" || s.state === "applied") && (
        <Card variant="default" padding="lg">
            <div role="status" aria-live="polite" data-testid="update-progress" className="space-y-3">
                <p className="font-bold text-gray-900 flex items-center gap-3"><i className="fa-solid fa-circle-notch fa-spin text-blue-500" aria-hidden="true"></i>{t(`update.step.${s.step || "restarting"}`).replace("{to}", s.to || "")}</p>
                <p className="text-sm text-gray-500">{t("update.keepOpen")}</p>
                {data.output.length > 0 && <pre className="max-h-64 overflow-auto rounded-lg bg-gray-900 px-3 py-2 text-xs text-gray-100 whitespace-pre-wrap">{data.output.join("\n")}</pre>}
            </div>
        </Card>
    );
    const result = !progress && ["done", "failed", "rolled_back"].includes(s.state) && s.finishedAt && (
        <Card variant="default" padding="lg">
            <div data-testid="update-result" data-state={s.state} className="flex items-start gap-3">
                <i className={`fa-solid ${s.state === "done" ? "fa-circle-check text-emerald-500" : s.state === "rolled_back" ? "fa-rotate-left text-amber-500" : "fa-circle-xmark text-red-500"} text-xl mt-0.5`} aria-hidden="true"></i>
                <div className="text-sm">
                    <p className="font-bold text-gray-900">{t(`update.result.${s.state}`).replace("{to}", s.to || "").replace("{from}", s.from || "")}</p>
                    {s.error && <p className="text-gray-600 break-words">{s.error}</p>}
                    {s.backup && <p className="text-xs text-gray-400">{t("update.backupNote").replace("{name}", s.backup)}</p>}
                </div>
            </div>
        </Card>
    );

    return shell(<>
        <Card variant="default" padding="lg">
            <div className="flex flex-wrap items-center justify-between gap-4" data-testid="update-summary">
                <div>
                    <p className="text-sm text-gray-500">{t("update.current")}</p>
                    <p className="text-2xl font-black text-gray-900">WordJS {data.current}</p>
                </div>
                <p className={`text-sm font-bold ${data.latest ? "text-blue-700" : data.error ? "text-amber-700" : "text-emerald-700"}`}>
                    {data.latest ? t("update.available").replace("{version}", data.latest.version) : data.error ? data.error : t("update.upToDate")}
                </p>
            </div>
        </Card>
        {progress}
        {result}
        {data.newer.length > 0 && !progress && (
            <Card variant="default" padding="lg">
                {!data.environment.canUpdate ? (
                    <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-800" data-testid="update-not-here">
                        <p className="font-bold">{t("update.notHere")}</p>
                        <p className="mt-1 break-words">{data.environment.how}</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Input label={t("network.currentPassword")} icon="fa-lock" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                        <Input label={t("networkSetup.mfaCode")} icon="fa-shield-halved" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
                        <p className="md:col-span-2 text-xs text-gray-500">{t("update.howItWorks")}</p>
                    </div>
                )}
                <ul className="mt-6 space-y-6">
                    {data.newer.map((r, i) => (
                        <li key={r.tag} className="border-t border-gray-100 pt-4 first:border-t-0 first:pt-0">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                    <p className="font-bold text-gray-900">{r.name || r.tag}</p>
                                    <p className="text-xs text-gray-500">{r.tag}{r.publishedAt ? ` · ${new Date(r.publishedAt).toLocaleDateString()}` : ""}{r.hasChecksum ? ` · ${t("update.verified")}` : ""} · <a href={r.url} target="_blank" rel="noopener noreferrer" className="underline">GitHub</a></p>
                                </div>
                                {data.environment.canUpdate && i === 0 && (
                                    <Button icon="fa-cloud-arrow-down" loading={busy} disabled={!password || !code.trim()} onClick={() => install(r)} data-testid="update-install">
                                        {t("update.install").replace("{version}", r.version)}
                                    </Button>
                                )}
                            </div>
                            {r.notes && <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 text-xs text-gray-700 whitespace-pre-wrap font-sans">{r.notes}</pre>}
                        </li>
                    ))}
                </ul>
            </Card>
        )}
        {data.checkedAt && <p className="text-xs text-gray-400">{t("update.checkedAt").replace("{at}", new Date(data.checkedAt).toLocaleString())}</p>}
    </>);
}
