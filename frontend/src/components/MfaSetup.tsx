"use client";

import { useEffect, useState } from "react";
import qrcode from "qrcode-generator";
import { mfaApi, MfaStatus } from "@/lib/api";
import { useToast } from "@/contexts/ToastContext";
import { Button } from "@/components/ui";
import SecretRevealModal from "@/components/SecretRevealModal";

/**
 * Self-service TOTP enrollment/management, rendered on the account page. Uses the zero-dependency
 * qrcode-generator (pure JS) to draw the otpauth QR client-side; also shows the raw secret for manual
 * entry. Backup codes are surfaced once via the shared SecretRevealModal.
 */
export default function MfaSetup({ onEnabled }: { onEnabled?: () => void } = {}) {
    const { addToast } = useToast();
    const [status, setStatus] = useState<MfaStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    // enrollment in progress: { secret, qr data-url }
    const [enroll, setEnroll] = useState<{ secret: string; qr: string } | null>(null);
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
        catch (e: any) { addToast(e?.message || "Failed to load MFA status", "error"); }
        finally { setLoading(false); }
    };
    useEffect(() => { loadStatus(); }, []);

    const startEnroll = async () => {
        setBusy(true);
        try {
            const { otpauthUri, secret } = await mfaApi.setup();
            const qr = qrcode(0, "M");
            qr.addData(otpauthUri);
            qr.make();
            setEnroll({ secret, qr: qr.createDataURL(5, 4) });
            setCode("");
        } catch (e: any) { addToast(e?.message || "Could not start setup", "error"); }
        finally { setBusy(false); }
    };

    const confirmEnroll = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            const res = await mfaApi.enable(code.trim());
            setBackupReveal(res.backupCodes.join("\n"));
            setEnrolledPendingClose(true); // fire onEnabled when the user closes the backup-codes modal
            setEnroll(null);
            setCode("");
            addToast("Two-factor authentication enabled", "success");
            await loadStatus();
        } catch (e: any) { addToast(e?.message || "Invalid code — check your device clock", "error"); }
        finally { setBusy(false); }
    };

    const disable = async () => {
        setBusy(true);
        try {
            await mfaApi.disable(manageCode.trim());
            addToast("Two-factor authentication disabled", "success");
            setManageCode("");
            await loadStatus();
        } catch (e: any) { addToast(e?.message || "Invalid authentication code", "error"); }
        finally { setBusy(false); }
    };

    const regenerate = async () => {
        setBusy(true);
        try {
            const res = await mfaApi.regenerateBackupCodes(manageCode.trim());
            setBackupReveal(res.backupCodes.join("\n"));
            setManageCode("");
            addToast("New backup codes generated", "success");
            await loadStatus();
        } catch (e: any) { addToast(e?.message || "Invalid authentication code", "error"); }
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
                    <h2 className="text-lg font-black italic tracking-tight text-gray-800">Two-Factor Authentication</h2>
                    <p className="text-xs text-gray-400">An authenticator app code (TOTP) required at sign-in.</p>
                </div>
                {status && (
                    <span className={`ml-auto text-[10px] font-black uppercase tracking-widest px-3 py-1.5 rounded-full ${status.enabled ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-400"}`}>
                        {status.enabled ? "Enabled" : "Off"}
                    </span>
                )}
            </div>

            {loading ? (
                <p className="text-sm text-gray-400 mt-4">Loading…</p>
            ) : enroll ? (
                // ── enrollment: show the QR + secret, then verify a code ──
                <form onSubmit={confirmEnroll} className="mt-6 space-y-5">
                    <p className="text-sm text-gray-500">Scan this with your authenticator app, or enter the key manually, then type the 6-digit code it shows.</p>
                    <div className="flex flex-col sm:flex-row gap-6 items-center">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={enroll.qr} alt="TOTP QR code" width={180} height={180} className="rounded-xl border border-gray-100" />
                        <div className="flex-1 w-full">
                            <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1">Manual entry key</label>
                            <code className="block break-all bg-gray-50 rounded-xl px-3 py-2 font-mono text-xs text-gray-600 mb-4">{enroll.secret}</code>
                            <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1">6-digit code</label>
                            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" className={codeInput} required />
                        </div>
                    </div>
                    <div className="flex gap-3">
                        <Button type="submit" icon="fa-check" loading={busy}>Verify &amp; enable</Button>
                        <Button type="button" variant="secondary" onClick={() => { setEnroll(null); setCode(""); }}>Cancel</Button>
                    </div>
                </form>
            ) : status?.enabled ? (
                // ── enabled: manage (disable / regenerate backup codes) ──
                <div className="mt-6 space-y-4">
                    <p className="text-sm text-gray-500">
                        {status.backupCodesRemaining} backup code{status.backupCodesRemaining === 1 ? "" : "s"} remaining.
                    </p>
                    <div>
                        <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1">Enter a current code to make changes</label>
                        <input value={manageCode} onChange={(e) => setManageCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456 or a backup code" className={codeInput} />
                    </div>
                    <div className="flex flex-wrap gap-3">
                        <Button variant="secondary" icon="fa-rotate" onClick={regenerate} loading={busy} disabled={!manageCode.trim()}>Regenerate backup codes</Button>
                        <Button variant="danger" icon="fa-shield-halved" onClick={disable} loading={busy} disabled={!manageCode.trim()}>Disable 2FA</Button>
                    </div>
                </div>
            ) : (
                // ── off: offer to enable ──
                <div className="mt-6">
                    <p className="text-sm text-gray-500 mb-4">Protect your account with a time-based code from an authenticator app (Google Authenticator, 1Password, Authy, …).</p>
                    <Button icon="fa-plus" onClick={startEnroll} loading={busy}>Enable two-factor authentication</Button>
                </div>
            )}

            <SecretRevealModal
                secret={backupReveal}
                title="Your backup codes"
                description="Each code works once if you lose access to your authenticator. Store them somewhere safe."
                onClose={() => {
                    setBackupReveal(null);
                    if (enrolledPendingClose) { setEnrolledPendingClose(false); onEnabled?.(); }
                }}
            />
        </div>
    );
}
