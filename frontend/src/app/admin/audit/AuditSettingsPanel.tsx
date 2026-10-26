"use client";

/**
 * Admin → Audit: the log's integrity and where it is kept (backend routes/audit.ts).
 *
 *   · Integrity: GET /audit/verify recomputes the hash chain over the rows (core/audit-chain) and names the
 *     first entry that was changed or removed outside WordJS.
 *   · Retention: how long entries are kept. A SHORTER window asks for the password (and a 2FA code when the
 *     account has one); a longer one, or "for ever", does not.
 *   · External copy: every entry also goes to a syslog server or an HTTPS webhook (core/audit-export), so
 *     what the log records cannot be erased from here. Any change to it asks for the password.
 */

import React, { useEffect, useState } from "react";
import { auditApi, AuditChainReport, AuditExportConfig, AuditSettings } from "@/lib/api";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { registerTranslations } from "@/lib/i18n";
import { Card, Select, Button, Input, Checkbox, SegmentedControl } from "@/components/ui";
import { useMfaStepUp, MfaStepUpFields } from "@/components/MfaStepUp";

registerTranslations({
    es: {
        "auditx.integrity": "Integridad",
        "auditx.checking": "Comprobando la cadena de hashes…",
        "auditx.intact": "Cadena intacta: las {count} entradas coinciden con sus hashes.",
        "auditx.partial": "Las primeras {count} entradas coinciden; el resto no dio tiempo a comprobarlo.",
        "auditx.broken": "La cadena se rompe en la entrada {seq}: {reason}. Alguien cambió o borró entradas fuera de WordJS; compáralo con la copia externa.",
        "auditx.reason.altered": "su contenido cambió",
        "auditx.reason.gap": "falta la entrada anterior",
        "auditx.reason.link": "no enlaza con la anterior",
        "auditx.reason.start": "las entradas más antiguas no coinciden con lo que borró la purga",
        "auditx.pending": "{count} entrada(s) esperan a sellarse.",
        "auditx.recheck": "Comprobar de nuevo",
        "auditx.verifyFailed": "No se pudo comprobar la cadena",
        "auditx.shortenTitle": "Conservar menos tiempo borra entradas antiguas",
        "auditx.shortenHelp": "Confirma con tu contraseña para guardar {label}.",
        "auditx.confirm": "Confirmar",
        "auditx.cancel": "Cancelar",
        "auditx.password": "Tu contraseña",
        "auditx.copy": "Copia externa",
        "auditx.copyHelp": "Cada entrada se envía también fuera del sitio, con su número y su hash, para que nadie pueda borrar el rastro desde aquí.",
        "auditx.mode.off": "Desactivada",
        "auditx.mode.syslog": "Syslog",
        "auditx.mode.webhook": "Webhook HTTPS",
        "auditx.host": "Servidor syslog",
        "auditx.port": "Puerto",
        "auditx.transport": "Transporte",
        "auditx.transport.tcp": "TCP",
        "auditx.transport.tls": "TLS (cifrado)",
        "auditx.transport.udp": "UDP",
        "auditx.url": "Dirección del webhook",
        "auditx.secret": "Secreto de firma (HMAC-SHA256)",
        "auditx.secretKept": "Guardado. Déjalo vacío para mantenerlo.",
        "auditx.allowPrivate": "El receptor está en una red privada",
        "auditx.allowPrivateHelp": "Permite una dirección interna (10.x, 192.168.x, localhost…). Sin marcar, solo se envía a direcciones públicas.",
        "auditx.save": "Guardar la copia",
        "auditx.test": "Enviar una prueba",
        "auditx.testOk": "Prueba enviada",
        "auditx.testFailed": "La prueba falló: {error}",
        "auditx.saved": "Copia externa guardada",
        "auditx.saveFailed": "No se pudo guardar la copia externa",
        "auditx.status.ok": "Última entrega: {at}",
        "auditx.status.behind": "{count} entrada(s) esperan a enviarse.",
        "auditx.status.error": "Falla: {error}",
        "auditx.sendNow": "Enviar ahora",
        "auditx.passwordNeeded": "Escribe tu contraseña para confirmar",
    },
    en: {
        "auditx.integrity": "Integrity",
        "auditx.checking": "Checking the hash chain…",
        "auditx.intact": "Chain intact: all {count} entries match their hashes.",
        "auditx.partial": "The first {count} entries match; the rest were not checked in time.",
        "auditx.broken": "The chain breaks at entry {seq}: {reason}. Someone changed or removed entries outside WordJS; compare with the external copy.",
        "auditx.reason.altered": "its content changed",
        "auditx.reason.gap": "the entry before it is missing",
        "auditx.reason.link": "it does not link to the one before",
        "auditx.reason.start": "the oldest entries do not match what the prune removed",
        "auditx.pending": "{count} entr(ies) waiting to be sealed.",
        "auditx.recheck": "Check again",
        "auditx.verifyFailed": "Could not check the chain",
        "auditx.shortenTitle": "Keeping less time deletes older entries",
        "auditx.shortenHelp": "Confirm with your password to save {label}.",
        "auditx.confirm": "Confirm",
        "auditx.cancel": "Cancel",
        "auditx.password": "Your password",
        "auditx.copy": "External copy",
        "auditx.copyHelp": "Every entry is also sent outside the site, with its number and hash, so nobody can erase the trail from here.",
        "auditx.mode.off": "Off",
        "auditx.mode.syslog": "Syslog",
        "auditx.mode.webhook": "HTTPS webhook",
        "auditx.host": "Syslog server",
        "auditx.port": "Port",
        "auditx.transport": "Transport",
        "auditx.transport.tcp": "TCP",
        "auditx.transport.tls": "TLS (encrypted)",
        "auditx.transport.udp": "UDP",
        "auditx.url": "Webhook address",
        "auditx.secret": "Signing secret (HMAC-SHA256)",
        "auditx.secretKept": "Saved. Leave empty to keep it.",
        "auditx.allowPrivate": "The receiver is on a private network",
        "auditx.allowPrivateHelp": "Allows an internal address (10.x, 192.168.x, localhost…). Unticked, only public addresses are used.",
        "auditx.save": "Save the copy",
        "auditx.test": "Send a test",
        "auditx.testOk": "Test sent",
        "auditx.testFailed": "The test failed: {error}",
        "auditx.saved": "External copy saved",
        "auditx.saveFailed": "Could not save the external copy",
        "auditx.status.ok": "Last delivery: {at}",
        "auditx.status.behind": "{count} entr(ies) waiting to be sent.",
        "auditx.status.error": "Failing: {error}",
        "auditx.sendNow": "Send now",
        "auditx.passwordNeeded": "Enter your password to confirm",
    },
    pt: {
        "auditx.integrity": "Integridade",
        "auditx.checking": "Verificando a cadeia de hashes…",
        "auditx.intact": "Cadeia intacta: as {count} entradas conferem com seus hashes.",
        "auditx.partial": "As primeiras {count} entradas conferem; o resto não foi verificado a tempo.",
        "auditx.broken": "A cadeia quebra na entrada {seq}: {reason}. Alguém alterou ou apagou entradas fora do WordJS; compare com a cópia externa.",
        "auditx.reason.altered": "o conteúdo mudou",
        "auditx.reason.gap": "falta a entrada anterior",
        "auditx.reason.link": "não liga com a anterior",
        "auditx.reason.start": "as entradas mais antigas não conferem com o que a limpeza apagou",
        "auditx.pending": "{count} entrada(s) aguardam ser seladas.",
        "auditx.recheck": "Verificar de novo",
        "auditx.verifyFailed": "Não foi possível verificar a cadeia",
        "auditx.shortenTitle": "Manter por menos tempo apaga entradas antigas",
        "auditx.shortenHelp": "Confirme com sua senha para salvar {label}.",
        "auditx.confirm": "Confirmar",
        "auditx.cancel": "Cancelar",
        "auditx.password": "Sua senha",
        "auditx.copy": "Cópia externa",
        "auditx.copyHelp": "Cada entrada também é enviada para fora do site, com seu número e hash, para que ninguém apague o rastro daqui.",
        "auditx.mode.off": "Desativada",
        "auditx.mode.syslog": "Syslog",
        "auditx.mode.webhook": "Webhook HTTPS",
        "auditx.host": "Servidor syslog",
        "auditx.port": "Porta",
        "auditx.transport": "Transporte",
        "auditx.transport.tcp": "TCP",
        "auditx.transport.tls": "TLS (criptografado)",
        "auditx.transport.udp": "UDP",
        "auditx.url": "Endereço do webhook",
        "auditx.secret": "Segredo de assinatura (HMAC-SHA256)",
        "auditx.secretKept": "Salvo. Deixe vazio para mantê-lo.",
        "auditx.allowPrivate": "O receptor está em uma rede privada",
        "auditx.allowPrivateHelp": "Permite um endereço interno (10.x, 192.168.x, localhost…). Desmarcado, só endereços públicos.",
        "auditx.save": "Salvar a cópia",
        "auditx.test": "Enviar um teste",
        "auditx.testOk": "Teste enviado",
        "auditx.testFailed": "O teste falhou: {error}",
        "auditx.saved": "Cópia externa salva",
        "auditx.saveFailed": "Não foi possível salvar a cópia externa",
        "auditx.status.ok": "Última entrega: {at}",
        "auditx.status.behind": "{count} entrada(s) aguardam envio.",
        "auditx.status.error": "Falhando: {error}",
        "auditx.sendNow": "Enviar agora",
        "auditx.passwordNeeded": "Digite sua senha para confirmar",
    },
});

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/** Does `to` keep less history than `from`? (0 = for ever.) The same rule as backend core/audit.retentionShortens. */
export function retentionShortens(from: number, to: number): boolean {
    if (to === 0) return false;
    if (from === 0) return true;
    return to < from;
}

const RETENTION_LABEL: Record<string, string> = { "90": "audit.retention.d90", "180": "audit.retention.d180", "365": "audit.retention.d365", "730": "audit.retention.d730", "0": "audit.retention.forever" };

export default function AuditSettingsPanel() {
    const { t } = useI18n();
    const { addToast } = useToast();
    const stepUp = useMfaStepUp();

    const [chainReport, setChainReport] = useState<AuditChainReport | null>(null);
    const [verifying, setVerifying] = useState(false);
    const [settings, setSettings] = useState<AuditSettings | null>(null);
    const [pendingRetention, setPendingRetention] = useState<string | null>(null);
    const [password, setPassword] = useState("");
    const [draft, setDraft] = useState<AuditExportConfig | null>(null);
    const [secret, setSecret] = useState("");
    const [saving, setSaving] = useState<string | null>(null);

    const verify = async () => {
        setVerifying(true);
        try { setChainReport(await auditApi.verify()); }
        catch (e: any) { addToast(e?.message || t("auditx.verifyFailed"), "error"); }
        finally { setVerifying(false); }
    };

    const loadSettings = async () => {
        try {
            const s = await auditApi.settings();
            setSettings(s);
            setDraft(s.export.config);
        } catch { /* the log itself still shows; the page reports its own load error */ }
    };

    useEffect(() => { verify(); loadSettings(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const failed = (e: any, fallback: string) => {
        if (e?.code === "rest_bad_current_password") setPassword("");
        if (!stepUp.absorb(e)) addToast(e?.message || t(fallback), "error");
    };

    const saveRetention = async (value: string, withPassword: boolean) => {
        setSaving("retention");
        try {
            const s = await auditApi.saveSettings({ retentionDays: Number(value), ...(withPassword ? { currentPassword: password, ...stepUp.payload() } : {}) });
            setSettings(s);
            setPendingRetention(null);
            setPassword("");
            stepUp.reset();
            addToast(t("audit.retention.saved"), "success");
        } catch (e: any) {
            failed(e, "audit.retention.failed");
        } finally {
            setSaving(null);
        }
    };

    const onRetention = (value: string) => {
        if (!settings) return;
        if (retentionShortens(settings.retentionDays, Number(value))) { setPendingRetention(value); return; }
        setPendingRetention(null);
        saveRetention(value, false);
    };

    const saveExport = async () => {
        if (!draft) return;
        if (!password) { addToast(t("auditx.passwordNeeded"), "error"); return; }
        setSaving("export");
        try {
            const s = await auditApi.saveSettings({ export: { ...draft, ...(secret ? { secret } : {}) }, currentPassword: password, ...stepUp.payload() });
            setSettings(s);
            setDraft(s.export.config);
            setSecret("");
            setPassword("");
            stepUp.reset();
            addToast(t("auditx.saved"), "success");
        } catch (e: any) {
            failed(e, "auditx.saveFailed");
        } finally {
            setSaving(null);
        }
    };

    const testExport = async () => {
        if (!draft) return;
        setSaving("test");
        try {
            const r = await auditApi.testExport({ ...draft, ...(secret ? { secret } : {}) });
            addToast(r.ok ? t("auditx.testOk") : fill(t("auditx.testFailed"), { error: r.error || "" }), r.ok ? "success" : "error");
        } catch (e: any) {
            addToast(fill(t("auditx.testFailed"), { error: e?.message || "" }), "error");
        } finally {
            setSaving(null);
        }
    };

    const sendNow = async () => {
        setSaving("flush");
        try {
            const r = await auditApi.flushExport();
            setSettings((s) => (s ? { ...s, export: r.export } : s));
        } catch (e: any) {
            addToast(e?.message || t("auditx.saveFailed"), "error");
        } finally {
            setSaving(null);
        }
    };

    const passwordFields = (
        <div className="space-y-2 max-w-sm">
            <Input label={t("auditx.password")} icon="fa-lock" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <MfaStepUpFields stepUp={stepUp} />
        </div>
    );

    const ex = settings?.export;
    const dirty = !!(draft && ex && (JSON.stringify(draft) !== JSON.stringify(ex.config) || secret));

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <Card variant="default">
                <div className="flex items-start justify-between gap-3 mb-3">
                    <h2 className="text-sm font-bold text-gray-900">{t("auditx.integrity")}</h2>
                    <Button size="sm" variant="secondary" onClick={verify} pending={verifying} icon="fa-rotate">{t("auditx.recheck")}</Button>
                </div>
                <div aria-live="polite" data-testid="audit-chain-status">
                    {!chainReport ? (
                        <p className="text-sm text-gray-500">{t("auditx.checking")}</p>
                    ) : !chainReport.ok && chainReport.firstBreak ? (
                        <p className="text-sm text-red-700 flex items-start gap-2"><i className="fa-solid fa-triangle-exclamation mt-0.5" aria-hidden="true"></i>
                            <span>{fill(t("auditx.broken"), { seq: chainReport.firstBreak.seq ?? "?", reason: t(`auditx.reason.${chainReport.firstBreak.reason}`) })}</span></p>
                    ) : (
                        <p className="text-sm text-green-700 flex items-start gap-2"><i className="fa-solid fa-link mt-0.5" aria-hidden="true"></i>
                            <span>{fill(t(chainReport.complete ? "auditx.intact" : "auditx.partial"), { count: chainReport.checked })}</span></p>
                    )}
                    {chainReport && chainReport.pending > 0 && <p className="text-xs text-gray-500 mt-1">{fill(t("auditx.pending"), { count: chainReport.pending })}</p>}
                </div>

                {settings && (
                    <div className="mt-6 max-w-xs">
                        <Select
                            label={t("audit.retention.label")}
                            value={pendingRetention ?? String(settings.retentionDays)}
                            onChange={onRetention}
                            disabled={saving === "retention"}
                            options={[
                                { value: "90", label: t("audit.retention.d90") },
                                { value: "180", label: t("audit.retention.d180") },
                                { value: "365", label: t("audit.retention.d365") },
                                { value: "730", label: t("audit.retention.d730") },
                                { value: "0", label: t("audit.retention.forever") },
                            ]}
                        />
                    </div>
                )}
                {pendingRetention !== null && (
                    <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50/60 p-4 space-y-3" data-testid="audit-retention-confirm">
                        <p className="text-sm font-semibold text-amber-900">{t("auditx.shortenTitle")}</p>
                        <p className="text-xs text-amber-800">{fill(t("auditx.shortenHelp"), { label: t(RETENTION_LABEL[pendingRetention] || "audit.retention.d365") })}</p>
                        {passwordFields}
                        <div className="flex gap-2">
                            <Button size="sm" onClick={() => (password ? saveRetention(pendingRetention, true) : addToast(t("auditx.passwordNeeded"), "error"))} pending={saving === "retention"}>{t("auditx.confirm")}</Button>
                            <Button size="sm" variant="ghost" onClick={() => { setPendingRetention(null); setPassword(""); stepUp.reset(); }}>{t("auditx.cancel")}</Button>
                        </div>
                    </div>
                )}
            </Card>

            {draft && ex && (
                <Card variant="default">
                    <h2 className="text-sm font-bold text-gray-900 mb-1">{t("auditx.copy")}</h2>
                    <p className="text-xs text-gray-500 mb-4">{t("auditx.copyHelp")}</p>
                    <SegmentedControl
                        aria-label={t("auditx.copy")}
                        value={draft.mode}
                        onChange={(mode) => setDraft({ ...draft, mode })}
                        options={[
                            { value: "off", label: t("auditx.mode.off") },
                            { value: "syslog", label: t("auditx.mode.syslog") },
                            { value: "webhook", label: t("auditx.mode.webhook") },
                        ]}
                    />
                    {draft.mode === "syslog" && (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
                            <Input containerClassName="sm:col-span-2" label={t("auditx.host")} value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} placeholder="siem.example.com" />
                            <Input label={t("auditx.port")} inputMode="numeric" value={String(draft.port || "")} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
                            <Select
                                containerClassName="sm:col-span-3"
                                label={t("auditx.transport")}
                                value={draft.transport}
                                onChange={(v) => setDraft({ ...draft, transport: v as AuditExportConfig["transport"], port: v === "tls" && draft.port === 514 ? 6514 : v !== "tls" && draft.port === 6514 ? 514 : draft.port })}
                                options={[
                                    { value: "tcp", label: t("auditx.transport.tcp") },
                                    { value: "tls", label: t("auditx.transport.tls") },
                                    { value: "udp", label: t("auditx.transport.udp") },
                                ]}
                            />
                        </div>
                    )}
                    {draft.mode === "webhook" && (
                        <div className="space-y-3 mt-4">
                            <Input label={t("auditx.url")} type="url" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://siem.example.com/wordjs" />
                            <Input label={t("auditx.secret")} type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} help={ex.hasSecret ? t("auditx.secretKept") : undefined} />
                        </div>
                    )}
                    {draft.mode !== "off" && (
                        <div className="mt-3">
                            <Checkbox label={t("auditx.allowPrivate")} help={t("auditx.allowPrivateHelp")} checked={draft.allowPrivate} onChange={(e) => setDraft({ ...draft, allowPrivate: e.target.checked })} />
                        </div>
                    )}

                    {ex.config.mode !== "off" && (
                        <div className="mt-4 text-xs space-y-1" data-testid="audit-export-status">
                            {ex.lastError && <p className="text-red-700">{fill(t("auditx.status.error"), { error: ex.lastError })}</p>}
                            {ex.lastSuccessAt && <p className="text-gray-600">{fill(t("auditx.status.ok"), { at: new Date(ex.lastSuccessAt).toLocaleString() })}</p>}
                            {ex.behind > 0 && (
                                <p className="text-amber-700 flex items-center gap-2">{fill(t("auditx.status.behind"), { count: ex.behind })}
                                    <Button size="sm" variant="link" onClick={sendNow} pending={saving === "flush"}>{t("auditx.sendNow")}</Button></p>
                            )}
                        </div>
                    )}

                    {dirty && <div className="mt-4">{passwordFields}</div>}
                    <div className="flex flex-wrap gap-2 mt-4">
                        <Button size="sm" onClick={saveExport} disabled={!dirty} pending={saving === "export"} icon="fa-floppy-disk">{t("auditx.save")}</Button>
                        {draft.mode !== "off" && <Button size="sm" variant="secondary" onClick={testExport} pending={saving === "test"} icon="fa-paper-plane">{t("auditx.test")}</Button>}
                    </div>
                </Card>
            )}
        </div>
    );
}
