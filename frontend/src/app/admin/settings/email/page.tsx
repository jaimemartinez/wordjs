"use client";
/**
 * Settings → Account email: how password-reset and verification email is delivered (backend routes/account-mail.ts,
 * core/account-mail.ts).
 *
 * Those messages carry links that ARE the account, so they do not go to a mail provider plugin unless an
 * administrator allows that plugin by name. The default is the built-in SMTP transport configured here,
 * which the host sends itself. Every change asks for the administrator's password (the backend
 * re-authenticates and audits it); the relay password is write-only (`hasPassword`).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { accountMailApi, AccountMailStatus } from "@/lib/api";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { useModal } from "@/contexts/ModalContext";
import { PageHeader, Button, Card, Input, Select } from "@/components/ui";


type Security = "tls" | "starttls" | "none";

export default function AccountMailSettingsPage() {
    const { t } = useI18n();
    const { addToast } = useToast();
    const { confirm } = useModal();
    const [status, setStatus] = useState<AccountMailStatus | null>(null);
    const [host, setHost] = useState("");
    const [port, setPort] = useState("587");
    const [security, setSecurity] = useState<Security>("starttls");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [fromAddress, setFromAddress] = useState("");
    const [fromName, setFromName] = useState("");
    const [currentPassword, setCurrentPassword] = useState("");
    const [saving, setSaving] = useState(false);
    const [testTo, setTestTo] = useState("");
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

    const apply = (s: AccountMailStatus) => {
        setStatus(s);
        if (s.smtp) {
            setHost(s.smtp.host);
            setPort(String(s.smtp.port));
            setSecurity(s.smtp.security);
            setUsername(s.smtp.username);
            setFromAddress(s.smtp.fromAddress);
            setFromName(s.smtp.fromName);
        }
        setPassword("");
    };

    useEffect(() => {
        accountMailApi.status().then(apply).catch((e: any) => addToast(e?.message || t("accountMail.loadFailed"), "error"));
    }, []);

    const needPassword = () => {
        if (currentPassword) return false;
        addToast(t("accountMail.currentPasswordRequired"), "error");
        return true;
    };

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        if (needPassword()) return;
        setSaving(true);
        try {
            const s = await accountMailApi.saveSmtp({
                host, port: Number(port), security, username, password: password || undefined, fromAddress, fromName, currentPassword,
            });
            apply(s);
            setCurrentPassword("");
            addToast(t("accountMail.saved"), "success");
        } catch (err: any) {
            addToast(err?.message || t("accountMail.saveFailed"), "error");
        } finally {
            setSaving(false);
        }
    };

    const clear = async () => {
        if (needPassword()) return;
        if (!(await confirm(t("accountMail.clearConfirm"), t("accountMail.clear"), true))) return;
        setSaving(true);
        try {
            const s = await accountMailApi.saveSmtp({ clear: true, currentPassword });
            apply(s);
            setHost(""); setUsername(""); setFromAddress(""); setFromName("");
            setCurrentPassword("");
            addToast(t("accountMail.cleared"), "success");
        } catch (err: any) {
            addToast(err?.message || t("accountMail.saveFailed"), "error");
        } finally {
            setSaving(false);
        }
    };

    const test = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            await accountMailApi.test(testTo);
            setTestResult({ ok: true, text: t("accountMail.testOk").replace("{to}", testTo) });
        } catch (err: any) {
            setTestResult({ ok: false, text: err?.message || "Error" });
        } finally {
            setTesting(false);
        }
    };

    const setAllowed = async (slug: string, allowed: boolean) => {
        if (needPassword()) return;
        if (allowed && !(await confirm(t("accountMail.allowConfirm").replace("{plugin}", slug), t("accountMail.allowTitle"), true))) return;
        try {
            const s = await accountMailApi.setProvider(slug, allowed, currentPassword);
            apply(s);
            setCurrentPassword("");
            addToast(t(allowed ? "accountMail.allowed" : "accountMail.disallowed"), "success");
        } catch (err: any) {
            addToast(err?.message || t("accountMail.saveFailed"), "error");
        }
    };

    const label = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
    const routeText = !status ? "" : status.route === "core" ? t("accountMail.routeCore")
        : status.route === "provider" ? t("accountMail.routeProvider").replace("{plugin}", status.provider || "")
        : t("accountMail.routeNone");

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader title={t("accountMail.title")} subtitle={t("accountMail.subtitle")} icon="fa-envelope-circle-check" />

            {status && (
                <div data-testid="account-mail-route" data-route={status.route}
                    className={`mb-8 flex items-start gap-4 rounded-3xl border-2 px-6 py-5 ${status.route === "core" ? "border-emerald-100 bg-emerald-50/60" : status.route === "provider" ? "border-rose-100 bg-rose-50/60" : "border-amber-100 bg-amber-50/60"}`}>
                    <i className={`fa-solid ${status.route === "core" ? "fa-circle-check text-emerald-500" : "fa-triangle-exclamation " + (status.route === "provider" ? "text-rose-500" : "text-amber-500")} text-xl mt-0.5`}></i>
                    <div>
                        <h2 className="text-sm font-bold text-gray-900">{routeText}</h2>
                        <p className="text-sm text-gray-600 mt-1 leading-relaxed">
                            {status.route === "core" ? t("accountMail.routeCoreHelp") : status.route === "provider" ? t("accountMail.routeProviderHelp") : t("accountMail.routeNoneHelp")}
                        </p>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <Card variant="default" padding="lg" className="lg:col-span-2">
                    <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-6 flex items-center gap-2">
                        <i className="fa-solid fa-server text-blue-500"></i>{t("accountMail.smtpTitle")}
                    </h2>
                    {!status ? (
                        <div className="p-10 text-center text-gray-400 text-xs font-bold uppercase tracking-widest">{t("common.loading")}</div>
                    ) : (
                        <form onSubmit={save} className="space-y-5">
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                <div className="sm:col-span-2">
                                    <Input label={t("accountMail.host")} icon="fa-server" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" autoComplete="off" />
                                </div>
                                <Input label={t("accountMail.port")} icon="fa-hashtag" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))} />
                            </div>
                            <div>
                                <label className={label}>{t("accountMail.security")}</label>
                                <Select value={security} onChange={(v) => setSecurity(v as Security)} options={[
                                    { value: "starttls", label: t("accountMail.securityStarttls") },
                                    { value: "tls", label: t("accountMail.securityTls") },
                                    { value: "none", label: t("accountMail.securityNone") },
                                ]} />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <Input label={t("accountMail.username")} icon="fa-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
                                <div>
                                    <Input label={t("accountMail.password")} icon="fa-key" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={status.hasPassword ? "••••••••" : ""} />
                                    <p className="text-[11px] text-gray-400 mt-1.5">{status.hasPassword ? t("accountMail.passwordStored") : t("accountMail.passwordNone")}</p>
                                </div>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <Input label={t("accountMail.fromAddress")} icon="fa-at" type="email" value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} placeholder="no-reply@example.com" />
                                <Input label={t("accountMail.fromName")} icon="fa-signature" value={fromName} onChange={(e) => setFromName(e.target.value)} />
                            </div>
                            <div className="rounded-2xl border border-gray-100 bg-gray-50/60 p-4">
                                <Input label={t("accountMail.currentPassword")} icon="fa-lock" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
                                <p className="text-[11px] text-gray-400 mt-1.5">{t("accountMail.currentPasswordHelp")}</p>
                            </div>
                            <div className="flex flex-wrap gap-3 items-center">
                                <Button type="submit" icon="fa-floppy-disk" loading={saving}>{t("accountMail.save")}</Button>
                                {status.smtp && <Button type="button" variant="ghost" icon="fa-trash" onClick={clear}>{t("accountMail.clear")}</Button>}
                            </div>
                            {status.smtp && (
                                <div className="border-t border-gray-100 pt-5 flex flex-col sm:flex-row gap-3 sm:items-end">
                                    <div className="flex-1">
                                        <Input label={t("accountMail.testTo")} icon="fa-paper-plane" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
                                    </div>
                                    <Button type="button" variant="secondary" icon="fa-plug-circle-check" loading={testing} onClick={test}>{t("accountMail.test")}</Button>
                                </div>
                            )}
                            {testResult && (
                                <p role="status" className={`text-sm font-medium ${testResult.ok ? "text-emerald-600" : "text-red-600"}`}>
                                    <i className={`fa-solid ${testResult.ok ? "fa-circle-check" : "fa-circle-exclamation"} mr-1.5`}></i>{testResult.text}
                                </p>
                            )}
                        </form>
                    )}
                </Card>

                <Card variant="default" padding="lg" className="h-fit">
                    <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2">
                        <i className="fa-solid fa-puzzle-piece text-rose-500"></i>{t("accountMail.providerTitle")}
                    </h2>
                    <p className="text-xs text-gray-600 leading-relaxed mb-4">{t("accountMail.providerHelp")}</p>
                    {status && (
                        <div className="space-y-3" data-testid="account-mail-provider">
                            {status.provider ? (
                                <div className="rounded-2xl border border-rose-100 bg-rose-50/50 p-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <code className="text-xs font-mono font-bold text-gray-800">{status.provider}</code>
                                        <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-full ${status.providerAllowed ? "bg-rose-600 text-white" : "bg-gray-200 text-gray-600"}`}>
                                            {status.providerAllowed ? t("accountMail.providerAllowedBadge") : t("accountMail.providerNotAllowedBadge")}
                                        </span>
                                    </div>
                                    <p className="text-[11px] text-rose-800 leading-relaxed mt-3">
                                        <i className="fa-solid fa-user-shield mr-1"></i>{t("accountMail.providerWarning")}
                                    </p>
                                    <div className="mt-3">
                                        {status.providerAllowed
                                            ? <Button size="sm" variant="secondary" icon="fa-ban" onClick={() => setAllowed(status.provider as string, false)}>{t("accountMail.disallow")}</Button>
                                            : <Button size="sm" variant="danger" icon="fa-unlock" onClick={() => setAllowed(status.provider as string, true)}>{t("accountMail.allow")}</Button>}
                                    </div>
                                </div>
                            ) : (
                                <p className="text-xs text-gray-400">{t("accountMail.noProvider")}</p>
                            )}
                            {status.allowedProviders.filter((p) => p !== status.provider).map((p) => (
                                <div key={p} className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 px-3 py-2">
                                    <code className="text-xs font-mono text-gray-700">{p}</code>
                                    <Button size="sm" variant="ghost" icon="fa-ban" onClick={() => setAllowed(p, false)}>{t("accountMail.disallow")}</Button>
                                </div>
                            ))}
                            <p className="text-[11px] text-gray-400 leading-relaxed">
                                {t("accountMail.currentPasswordForProvider")}{" "}
                                <Link href="/admin/plugins" className="text-blue-600 hover:underline">{t("accountMail.managePlugins")}</Link>
                            </p>
                        </div>
                    )}
                </Card>
            </div>
        </div>
    );
}
