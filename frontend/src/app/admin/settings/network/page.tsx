"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, apiPost, backupsApi, networkApi, type NetworkAdministrator, type NetworkRequirement, type NetworkSetup } from "@/lib/api";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { useModal } from "@/contexts/ModalContext";
import { useOptionalAuth } from "@/contexts/AuthContext";
import { PageHeader, Button, Card, EmptyState, Input } from "@/components/ui";

/**
 * Settings → Network (multisite), zero config: everything `npm run network -- enable|disable` did, plus the
 * restart that used to be "now restart the backend by hand".
 *
 * While the network is off (main-site administrators): what a network needs, checked by the server in
 * plain words with the fix for each (a sqlite-legacy install is moved to sqlite-native right here: a
 * backup, then the migration with its progress, then the automatic restart), which administrators of the
 * main site become network administrators, and the switch — confirmed with the password AND a current
 * two-factor code. Once on (network administrators): who runs the network, and turning it off again while
 * the main site is the only site. Every switch restarts the backend by itself (backend core/restart); this
 * page waits for it and comes back.
 *
 * The server enforces every rule (backend routes/network.ts /setup, /enable, /disable, /admins); this page
 * only decides what to draw.
 */

type Phase =
    | { kind: "idle" }
    | { kind: "backup" }
    | { kind: "migrating"; progress: number; table: string }
    | { kind: "restarting"; until: "enabled" | "disabled" | "migrated" }
    | { kind: "manual"; what: "enabled" | "disabled" | "migrated" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function NetworkSettingsPage() {
    const { t } = useI18n();
    const { addToast } = useToast();
    const { confirm } = useModal();
    const me = useOptionalAuth()?.user;
    const [setup, setSetup] = useState<NetworkSetup | null>(null);
    const [denied, setDenied] = useState(false);
    const [chosen, setChosen] = useState<number[]>([]);
    const [password, setPassword] = useState("");
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [phase, setPhase] = useState<Phase>({ kind: "idle" });
    const [admins, setAdmins] = useState<NetworkAdministrator[]>([]);
    const [adminPassword, setAdminPassword] = useState("");
    const [busyAdmin, setBusyAdmin] = useState<number | null>(null);
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    const load = async () => {
        try {
            const s = await networkApi.setup();
            setSetup(s);
            setAdmins(s.administrators);
            setChosen((prev) => (prev.length ? prev : s.administrators.filter((a) => Number(a.id) === Number(me?.id)).map((a) => a.id)));
        } catch (e: any) {
            if (e?.status === 403 || e?.status === 404 || /403|404|forbidden/i.test(String(e?.message))) setDenied(true);
            else addToast(e?.message || t("networkSetup.loadFailed"), "error");
        }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { load(); }, []);

    /**
     * Wait for the backend to come back from its restart: first for it to go away (or a short grace for
     * a very fast restart), then for it to answer with the new state.
     */
    const waitForRestart = async (until: "enabled" | "disabled" | "migrated") => {
        setPhase({ kind: "restarting", until });
        await sleep(1500);
        for (let i = 0; i < 240 && alive.current; i++) {
            try {
                if (until === "migrated") {
                    const st = await api<{ currentDriver: string }>("/db-migration/status");
                    if (st.currentDriver === "sqlite-native") break;
                } else {
                    const st = await networkApi.status();
                    if (st.enabled === (until === "enabled")) break;
                }
            } catch { /* still restarting */ }
            await sleep(1000);
        }
        if (!alive.current) return;
        if (until === "enabled") {
            addToast(t("networkSetup.enabledToast"), "success");
            window.location.assign("/admin/network");
            return;
        }
        // The admin menu follows the new state after a full reload.
        window.location.reload();
    };

    const migrate = async () => {
        const ok = await confirm(t("networkSetup.migrateConfirm"), t("networkSetup.migrateTitle"));
        if (!ok) return;
        setError(null);
        setPhase({ kind: "backup" });
        try {
            await backupsApi.create();
        } catch (e: any) {
            setPhase({ kind: "idle" });
            setError(`${t("networkSetup.backupFailed")} ${e?.message || ""}`.trim());
            return;
        }
        setPhase({ kind: "migrating", progress: 0, table: "" });
        const poll = setInterval(async () => {
            try {
                const st = await api<any>("/db-migration/status");
                if (st?.status && alive.current) setPhase((p) => (p.kind === "migrating" ? { kind: "migrating", progress: Number(st.status.progress) || 0, table: String(st.status.currentTable || "") } : p));
            } catch { /* the next tick */ }
        }, 500);
        try {
            const r = await apiPost<{ restart?: string; message?: string }>("/db-migration/migrate", { targetDriver: "sqlite-native" });
            clearInterval(poll);
            if (r.restart === "manual") { setPhase({ kind: "manual", what: "migrated" }); return; }
            await waitForRestart("migrated");
        } catch (e: any) {
            clearInterval(poll);
            setPhase({ kind: "idle" });
            setError(e?.message || t("networkSetup.migrateFailed"));
        }
    };

    const turnOn = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        if (!chosen.length) { setError(t("networkSetup.chooseAdmin")); return; }
        setBusy(true);
        try {
            const r = await networkApi.enable(chosen, password, code.trim());
            setPassword(""); setCode("");
            if (r.restart === "manual") { setPhase({ kind: "manual", what: "enabled" }); return; }
            await waitForRestart("enabled");
        } catch (err: any) {
            setError(err?.message || t("networkSetup.enableFailed"));
        } finally {
            setBusy(false);
        }
    };

    const turnOff = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        const ok = await confirm(t("networkSetup.disableConfirm"), t("networkSetup.disableTitle"), true);
        if (!ok) return;
        setBusy(true);
        try {
            const r = await networkApi.disable(password, code.trim());
            setPassword(""); setCode("");
            if (r.restart === "manual") { setPhase({ kind: "manual", what: "disabled" }); return; }
            await waitForRestart("disabled");
        } catch (err: any) {
            setError(err?.message || t("networkSetup.disableFailed"));
        } finally {
            setBusy(false);
        }
    };

    const changeAdmin = async (a: NetworkAdministrator) => {
        if (!adminPassword) { addToast(t("network.passwordRequired"), "error"); return; }
        // Taking someone's network administration away is asked first (QA X1-11: it applied on one click).
        if (a.networkAdmin && !(await confirm(t("networkSetup.removeAdminConfirm").replace("{login}", a.login), t("networkSetup.removeAdmin"), true))) return;
        setBusyAdmin(a.id);
        try {
            const r = a.networkAdmin ? await networkApi.removeAdmin(a.id, adminPassword) : await networkApi.addAdmin(a.id, adminPassword);
            setAdmins(r.administrators);
            setAdminPassword("");
            addToast((a.networkAdmin ? t("networkSetup.adminRemoved") : t("networkSetup.adminAdded")).replace("{login}", a.login), "success");
        } catch (err: any) {
            addToast(err?.message || t("networkSetup.adminFailed"), "error");
        } finally {
            setBusyAdmin(null);
        }
    };

    const header = <PageHeader title={t("networkSetup.title")} subtitle={t("networkSetup.subtitle")} icon="fa-sitemap" />;
    const shell = (children: React.ReactNode) => (
        <div className="p-4 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full">{header}<div className="max-w-4xl space-y-8">{children}</div></div>
    );

    if (denied) {
        return shell(
            <Card variant="default" padding="none">
                <EmptyState icon="fa-lock" title={t("network.notAllowedTitle")} description={t("networkSetup.notAllowed")} />
            </Card>
        );
    }
    if (phase.kind === "backup" || phase.kind === "migrating" || phase.kind === "restarting") {
        const label = phase.kind === "backup" ? t("networkSetup.phaseBackup")
            : phase.kind === "migrating" ? t("networkSetup.phaseMigrating")
            : t("networkSetup.phaseRestarting");
        return shell(
            <Card variant="default" padding="lg">
                <div role="status" aria-live="polite" data-testid="network-setup-progress" className="flex flex-col items-center text-center gap-4 py-8">
                    <i className="fa-solid fa-circle-notch fa-spin text-3xl text-blue-500" aria-hidden="true"></i>
                    <p className="text-lg font-bold text-gray-900">{label}</p>
                    {phase.kind === "migrating" && (
                        <div className="w-full max-w-md">
                            <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
                                <div className="h-2 bg-blue-500 transition-all" style={{ width: `${Math.max(3, phase.progress)}%` }}></div>
                            </div>
                            <p className="mt-2 text-xs text-gray-500">{phase.progress}%{phase.table ? ` · ${phase.table}` : ""}</p>
                        </div>
                    )}
                    <p className="text-sm text-gray-500 max-w-md">{t("networkSetup.phaseHelp")}</p>
                </div>
            </Card>
        );
    }
    if (phase.kind === "manual") {
        return shell(
            <Card variant="default" padding="lg">
                <div role="alert" className="flex items-start gap-4">
                    <i className="fa-solid fa-power-off text-2xl text-amber-500 mt-1" aria-hidden="true"></i>
                    <div>
                        <p className="font-bold text-gray-900">{t("networkSetup.manualTitle")}</p>
                        <p className="text-sm text-gray-600 mt-1">{t("networkSetup.manualHelp")}</p>
                    </div>
                </div>
            </Card>
        );
    }
    if (!setup) {
        return shell(<Card variant="default" padding="lg"><p className="text-sm text-gray-500">{t("loading")}</p></Card>);
    }

    const errorBox = error !== null && (
        <div role="alert" data-testid="network-setup-error" className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700 break-words">
            <i className="fa-solid fa-triangle-exclamation mr-2" aria-hidden="true"></i>{error}
        </div>
    );

    const secondFactor = !setup.mfaEnrolled ? (
        <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-800" data-testid="network-setup-mfa-needed">
            <p className="font-bold">{t("networkSetup.mfaNeededTitle")}</p>
            <p className="mt-1">{t("networkSetup.mfaNeededHelp")}</p>
            <Link href="/admin/account" className="mt-2 inline-flex items-center gap-2 font-bold text-amber-900 underline">{t("networkSetup.mfaNeededLink")} <i className="fa-solid fa-arrow-right" aria-hidden="true"></i></Link>
        </div>
    ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Input label={t("network.currentPassword")} icon="fa-lock" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <Input label={t("networkSetup.mfaCode")} icon="fa-shield-halved" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
        </div>
    );

    if (setup.enabled) {
        return shell(<>
            <Card variant="default" padding="lg">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-start gap-4">
                        <i className="fa-solid fa-circle-check text-2xl text-green-500 mt-1" aria-hidden="true"></i>
                        <div>
                            <p className="font-bold text-gray-900">{t("networkSetup.isOn")}</p>
                            <p className="text-sm text-gray-500 mt-1">{t("networkSetup.otherSites").replace("{n}", String(setup.otherSites))}</p>
                        </div>
                    </div>
                    <Link href="/admin/network" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-2xl bg-gray-900 px-5 py-3 text-sm font-bold text-white hover:bg-gray-800">
                        {t("networkSetup.openNetwork")} <i className="fa-solid fa-arrow-right" aria-hidden="true"></i>
                    </Link>
                </div>
            </Card>

            <Card variant="default" padding="lg">
                <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-2 flex items-center gap-2"><i className="fa-solid fa-user-shield text-blue-500" aria-hidden="true"></i>{t("networkSetup.adminsTitle")}</h2>
                <p className="text-sm text-gray-500 mb-6">{t("networkSetup.adminsManageHelp")}</p>
                <div className="mb-6 md:w-80">
                    <Input label={t("network.currentPassword")} icon="fa-lock" type="password" autoComplete="current-password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
                </div>
                <ul className="divide-y divide-gray-100">
                    {admins.map((a) => (
                        <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                            <div className="min-w-0">
                                <p className="font-bold text-gray-900 truncate">{a.displayName}</p>
                                <p className="text-xs text-gray-500">@{a.login}{a.networkAdmin ? ` · ${t("networkSetup.isNetworkAdmin")}` : ""}</p>
                            </div>
                            <Button variant={a.networkAdmin ? "secondary" : "primary"} size="sm" loading={busyAdmin === a.id} onClick={() => changeAdmin(a)}>
                                {a.networkAdmin ? t("networkSetup.removeAdmin") : t("networkSetup.makeAdmin")}
                            </Button>
                        </li>
                    ))}
                </ul>
            </Card>

            <Card variant="default" padding="lg">
                <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-2 flex items-center gap-2"><i className="fa-solid fa-power-off text-red-500" aria-hidden="true"></i>{t("networkSetup.turnOffTitle")}</h2>
                {setup.otherSites > 0 ? (
                    <p className="text-sm text-gray-600">{t("networkSetup.turnOffBlocked").replace("{n}", String(setup.otherSites))}</p>
                ) : (
                    <form onSubmit={turnOff} className="space-y-6">
                        <p className="text-sm text-gray-600">{t("networkSetup.turnOffHelp")}</p>
                        {secondFactor}
                        {errorBox}
                        <Button type="submit" variant="danger" icon="fa-power-off" loading={busy} disabled={!setup.mfaEnrolled}>{t("networkSetup.turnOff")}</Button>
                    </form>
                )}
            </Card>
        </>);
    }

    const requirementRow = (r: NetworkRequirement) => (
        <li key={r.id} data-requirement={r.id} data-ok={r.ok ? "1" : "0"} className="flex items-start gap-3 py-4">
            <i className={`fa-solid ${r.ok ? "fa-circle-check text-green-500" : r.blocking ? "fa-circle-xmark text-red-500" : "fa-circle-info text-amber-500"} mt-0.5`} aria-hidden="true"></i>
            <div className="min-w-0 flex-1">
                <p className="text-sm text-gray-800">{r.message}</p>
                {!r.ok && r.fix?.action === "migrate_sqlite_native" && (
                    <div className="mt-3">
                        <Button icon="fa-database" onClick={migrate} data-testid="network-setup-migrate">{t("networkSetup.migrateButton")}</Button>
                    </div>
                )}
                {!r.ok && r.fix?.action === "site_address" && (
                    <Link href="/admin/settings/site-address" className="mt-2 inline-flex items-center gap-2 text-sm font-bold text-blue-600 underline">{t("networkSetup.openSiteAddress")} <i className="fa-solid fa-arrow-right" aria-hidden="true"></i></Link>
                )}
                {!r.ok && r.fix?.action === "db_grant" && r.fix.detail && (
                    <pre className="mt-2 overflow-x-auto rounded-lg bg-gray-900 px-3 py-2 text-xs text-gray-100">{r.fix.detail}</pre>
                )}
            </div>
        </li>
    );

    return shell(<>
        <Card variant="default" padding="lg">
            <div className="flex items-start gap-4">
                <i className="fa-solid fa-sitemap text-2xl text-blue-500 mt-1" aria-hidden="true"></i>
                <div className="text-sm text-gray-600 space-y-2">
                    <p className="font-bold text-gray-900">{t("networkSetup.whatTitle")}</p>
                    <p>{t("networkSetup.whatHelp")}</p>
                </div>
            </div>
        </Card>

        <Card variant="default" padding="lg">
            <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-2 flex items-center gap-2"><i className="fa-solid fa-list-check text-blue-500" aria-hidden="true"></i>{t("networkSetup.requirementsTitle")}</h2>
            <ul className="divide-y divide-gray-100" data-testid="network-setup-requirements">{setup.requirements.map(requirementRow)}</ul>
            {errorBox && !setup.ready && <div className="mt-4">{errorBox}</div>}
        </Card>

        <Card variant="default" padding="lg">
            <form onSubmit={turnOn} className="space-y-6">
                <div>
                    <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-2 flex items-center gap-2"><i className="fa-solid fa-user-shield text-blue-500" aria-hidden="true"></i>{t("networkSetup.adminsTitle")}</h2>
                    <p className="text-sm text-gray-500 mb-4">{t("networkSetup.adminsChooseHelp")}</p>
                    <fieldset className="space-y-2">
                        <legend className="sr-only">{t("networkSetup.adminsTitle")}</legend>
                        {setup.administrators.map((a) => (
                            <label key={a.id} className="flex items-center gap-3 rounded-xl border border-gray-100 px-4 py-3 hover:bg-gray-50 cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="h-4 w-4"
                                    checked={chosen.includes(a.id)}
                                    onChange={(e) => setChosen((c) => (e.target.checked ? [...c, a.id] : c.filter((x) => x !== a.id)))}
                                />
                                <span className="font-bold text-gray-900">{a.displayName}</span>
                                <span className="text-xs text-gray-500">@{a.login}</span>
                            </label>
                        ))}
                    </fieldset>
                </div>
                {setup.ready ? secondFactor : <p className="text-sm text-gray-500">{t("networkSetup.fixFirst")}</p>}
                {setup.ready && errorBox}
                <Button type="submit" icon="fa-power-off" loading={busy} disabled={!setup.ready || !setup.mfaEnrolled || !chosen.length} data-testid="network-setup-enable">
                    {t("networkSetup.turnOn")}
                </Button>
                <p className="text-xs text-gray-400">{setup.restart.automatic ? t("networkSetup.restartAuto") : t("networkSetup.restartManual")}</p>
            </form>
        </Card>
    </>);
}
