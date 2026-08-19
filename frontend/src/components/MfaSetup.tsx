"use client";

import { useEffect, useId, useState } from "react";
import qrcode from "qrcode-generator";
import { mfaApi, MfaStatus } from "@/lib/api";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { Button } from "@/components/ui";
import SecretRevealModal from "@/components/SecretRevealModal";

/**
 * Self-service TOTP enrollment/management, rendered on the account page. Uses the zero-dependency
 * qrcode-generator (pure JS) to draw the otpauth QR client-side; also shows the raw secret for manual
 * entry. Backup codes are surfaced once via the shared SecretRevealModal.
 */
export default function MfaSetup({ onEnabled }: { onEnabled?: () => void } = {}) {
    const { addToast } = useToast();
    const { t } = useI18n();
    // t() returns the KEY itself when a catalogue has no entry, so a brand-new key would render as
    // "mfa.currentPassword" on screen. The re-auth strings are not in lib/i18n.ts yet, so fall back to
    // English copy until all three catalogues carry them (they must land together — the i18n parity test
    // fails a key added to one language only).
    const tf = (key: string, fallback: string) => { const s = t(key); return s === key ? fallback : s; };
    const uid = useId();
    const enrollCodeId = `${uid}-enroll-code`;
    const enrollPasswordId = `${uid}-enroll-password`;
    const manualKeyId = `${uid}-manual-key`;
    const manageCodeId = `${uid}-manage-code`;
    const [status, setStatus] = useState<MfaStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    // enrollment in progress: { secret, qr data-url }
    const [enroll, setEnroll] = useState<{ secret: string; qr: string } | null>(null);
    // The account password, proving this is the owner and not whoever holds the session. Held only for
    // the length of one enrolment because BOTH halves demand it (/setup mints the secret, /enable locks
    // the account); wiped the moment enrolment finishes, is cancelled, or the password is rejected.
    const [enrollPassword, setEnrollPassword] = useState("");
    const [code, setCode] = useState("");
    // one code field reused by the enabled-state actions (disable / regenerate)
    const [manageCode, setManageCode] = useState("");
    const [backupReveal, setBackupReveal] = useState<string | null>(null);
    // When enrolment (not a regenerate) triggered the backup-codes modal, defer onEnabled until the user
    // CLOSES it — otherwise a host that re-renders on onEnabled (the forced-enrol gate) unmounts us and the
    // codes are never seen.
    const [enrolledPendingClose, setEnrolledPendingClose] = useState(false);

    const loadStatus = async () => {
        try { setStatus(await mfaApi.status()); }
        catch (e: any) { addToast(e?.message || t("mfa.loadFailed"), "error"); }
        finally { setLoading(false); }
    };
    useEffect(() => { loadStatus(); }, []);

    /**
     * The password is proved FIRST, as the submit of the "off" panel — /auth/mfa/setup is the call that
     * discloses the TOTP secret, so asking afterwards (with the QR already on screen) would prove nothing:
     * whoever held the session would already have everything they need to enrol their own authenticator.
     */
    const startEnroll = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            const { otpauthUri, secret } = await mfaApi.setup(enrollPassword);
            const qr = qrcode(0, "M");
            qr.addData(otpauthUri);
            qr.make();
            setEnroll({ secret, qr: qr.createDataURL(5, 4) });
            setCode("");
        } catch (err: any) {
            // `err`, not `e`: the form event is still in scope here, and a shadowed name is how a catch
            // block ends up reading a property off the event instead of the failure.
            // A rejected password leaves nothing to keep: clear it so a retry re-types it rather than
            // silently re-sending a wrong one (every attempt counts against the account's lockout bucket).
            setEnrollPassword("");
            addToast(err?.message || t("mfa.setupFailed"), "error");
        }
        finally { setBusy(false); }
    };

    const confirmEnroll = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            const res = await mfaApi.enable(code.trim(), enrollPassword);
            setBackupReveal(res.backupCodes.join("\n"));
            setEnrolledPendingClose(true); // fire onEnabled when the user closes the backup-codes modal
            setEnroll(null);
            setCode("");
            setEnrollPassword("");
            addToast(t("mfa.enabledToast"), "success");
            await loadStatus();
        } catch (err: any) {
            // The password can be refused at this second door too (it changed in another tab, or the
            // sudo window was throttled). Send the user back to the password step — /setup will mint a
            // fresh secret — instead of leaving a QR on screen that can no longer be activated.
            if (err?.code === "rest_bad_current_password") {
                setEnroll(null);
                setCode("");
                setEnrollPassword("");
            }
            addToast(err?.message || t("mfa.invalidCodeClock"), "error");
        }
        finally { setBusy(false); }
    };

    const disable = async () => {
        setBusy(true);
        try {
            await mfaApi.disable(manageCode.trim());
            addToast(t("mfa.disabledToast"), "success");
            setManageCode("");
            await loadStatus();
        } catch (e: any) { addToast(e?.message || t("mfa.invalidCode"), "error"); }
        finally { setBusy(false); }
    };

    const regenerate = async () => {
        setBusy(true);
        try {
            const res = await mfaApi.regenerateBackupCodes(manageCode.trim());
            setBackupReveal(res.backupCodes.join("\n"));
            setManageCode("");
            addToast(t("mfa.backupRegenerated"), "success");
            await loadStatus();
        } catch (e: any) { addToast(e?.message || t("mfa.invalidCode"), "error"); }
        finally { setBusy(false); }
    };

    const codeInput = "w-full px-4 py-3 border border-gray-200 rounded-xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 outline-none font-mono tracking-widest text-center";

    return (
        <div className="bg-white border border-gray-100 rounded-3xl p-8 shadow-sm">
            <div className="flex items-center gap-3 mb-2">
                <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-indigo-50 to-blue-50 flex items-center justify-center text-indigo-600">
                    <i className="fa-solid fa-shield-halved"></i>
                </div>
                <div>
                    <h2 className="text-lg font-black italic tracking-tight text-gray-800">{t("mfa.title")}</h2>
                    <p className="text-xs text-gray-400">{t("mfa.subtitle")}</p>
                </div>
                {status && (
                    <span className={`ml-auto text-[10px] font-black uppercase tracking-widest px-3 py-1.5 rounded-full ${status.enabled ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-400"}`}>
                        {status.enabled ? t("mfa.statusEnabled") : t("mfa.statusOff")}
                    </span>
                )}
            </div>

            {loading ? (
                <p className="text-sm text-gray-400 mt-4">{t("common.loading")}</p>
            ) : enroll ? (
                // ── enrollment: show the QR + secret, then verify a code ──
                <form onSubmit={confirmEnroll} className="mt-6 space-y-5">
                    <p className="text-sm text-gray-500">{t("mfa.enrollInstructions")}</p>
                    <div className="flex flex-col sm:flex-row gap-6 items-center">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={enroll.qr} alt={t("mfa.qrAlt")} width={180} height={180} className="rounded-xl border border-gray-100" />
                        <div className="flex-1 w-full">
                            <label htmlFor={manualKeyId} className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1">{t("mfa.manualKey")}</label>
                            <code id={manualKeyId} className="block break-all bg-gray-50 rounded-xl px-3 py-2 font-mono text-xs text-gray-600 mb-4">{enroll.secret}</code>
                            <label htmlFor={enrollCodeId} className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1">{t("mfa.codeLabel")}</label>
                            <input id={enrollCodeId} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" className={codeInput} required />
                        </div>
                    </div>
                    <div className="flex gap-3">
                        <Button type="submit" icon="fa-check" loading={busy}>{t("mfa.verifyEnable")}</Button>
                        <Button type="button" variant="secondary" onClick={() => { setEnroll(null); setCode(""); setEnrollPassword(""); }}>{t("common.cancel")}</Button>
                    </div>
                </form>
            ) : status?.enabled ? (
                // ── enabled: manage (disable / regenerate backup codes) ──
                <div className="mt-6 space-y-4">
                    <p className="text-sm text-gray-500">
                        {(status.backupCodesRemaining === 1 ? t("mfa.backupRemaining.one") : t("mfa.backupRemaining.other")).replace("{count}", String(status.backupCodesRemaining))}
                    </p>
                    <div>
                        <label htmlFor={manageCodeId} className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1">{t("mfa.enterCurrentCode")}</label>
                        <input id={manageCodeId} value={manageCode} onChange={(e) => setManageCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder={t("mfa.codePlaceholder")} className={codeInput} />
                    </div>
                    <div className="flex flex-wrap gap-3">
                        <Button variant="secondary" icon="fa-rotate" onClick={regenerate} loading={busy} disabled={!manageCode.trim()}>{t("mfa.regenerate")}</Button>
                        <Button variant="danger" icon="fa-shield-halved" onClick={disable} loading={busy} disabled={!manageCode.trim()}>{t("mfa.disable")}</Button>
                    </div>
                </div>
            ) : (
                // ── off: prove the account password, and only then mint + show the secret ──
                <form onSubmit={startEnroll} className="mt-6 space-y-4">
                    <p className="text-sm text-gray-500">{t("mfa.offDescription")}</p>
                    <div>
                        <label htmlFor={enrollPasswordId} className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1">
                            {tf("mfa.currentPassword", "Your current password")}
                        </label>
                        <input
                            id={enrollPasswordId}
                            type="password"
                            value={enrollPassword}
                            onChange={(e) => setEnrollPassword(e.target.value)}
                            autoComplete="current-password"
                            required
                            className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 outline-none"
                        />
                        <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
                            {tf("mfa.currentPassword.help", "Turning two-factor on locks this account to one device, so it takes more than being signed in: re-enter your password.")}
                        </p>
                    </div>
                    <Button type="submit" icon="fa-plus" loading={busy} disabled={!enrollPassword}>{t("mfa.enable")}</Button>
                </form>
            )}

            <SecretRevealModal
                secret={backupReveal}
                title={t("mfa.backupTitle")}
                description={t("mfa.backupDescription")}
                onClose={() => {
                    setBackupReveal(null);
                    if (enrolledPendingClose) { setEnrolledPendingClose(false); onEnabled?.(); }
                }}
            />
        </div>
    );
}
