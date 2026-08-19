"use client";

import { useState } from "react";
import { mfaApi } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useModal } from "@/contexts/ModalContext";

/**
 * ADMIN ESCAPE HATCH from a two-factor lockout — the client half of POST /users/:id/mfa/reset.
 *
 * Enrolment is a state a user can be pushed into (a hijacked session, a phone that died, an
 * authenticator restored to the wrong device), and until this button existed the only exits were the
 * victim's own /auth/mfa/disable — which needs a code they no longer have — or deleting and recreating
 * the account, losing every row that references their user id. The backend route shipped with no UI at
 * all, so the escape hatch was unreachable.
 *
 * Rendered by BOTH admin user editors (the modal on /admin/users and the /admin/users/[id] page) rather
 * than inlined in one of them: this is exactly the shape of bug the audit kept finding — a capability
 * added to one surface and forgotten on its twin.
 *
 * The client mirrors the two backend gates it can actually evaluate, so the button is not offered where
 * the request could only fail:
 *   • `edit_users` — this is account administration, not self-service.
 *   • never yourself — an admin turns their OWN 2FA off through /auth/mfa/disable, which demands a
 *     current code. Offering it here would hand a hijacked admin session precisely the "disarm the
 *     second factor with nothing but a cookie" power that route deliberately refuses.
 * The third gate — only an administrator may reset a PRIVILEGED account — is partly invisible from here
 * (a custom role can be privileged through its capabilities, which the users list does not expose), so
 * the obvious case is hidden and the rest is left to the server's 403, whose message is shown verbatim.
 */
export default function UserMfaReset({ userId, username, targetRole, className = "mt-8 pt-6 border-t border-gray-100" }: {
    userId: number;
    username: string;
    targetRole?: string;
    // The two hosts sit in different chrome (a section inside the modal's form column, a standalone card
    // on the editor page). The root class is the host's business — a hidden panel must leave NO empty
    // wrapper behind, which it would if the card lived outside this component.
    className?: string;
}) {
    const { user, can } = useAuth();
    const { alert, confirm } = useModal();
    const [busy, setBusy] = useState(false);
    const [wasReset, setWasReset] = useState(false);

    if (!user || !can("edit_users")) return null;
    if (user.id === userId) return null;
    if (targetRole === "administrator" && user.role !== "administrator") return null;

    const handleReset = async () => {
        // The confirmation NAMES the account: this screen is reachable with a user already loaded into a
        // form, and "are you sure?" on the wrong row silently disarms the wrong person's second factor.
        const ok = await confirm(
            `Reset two-factor authentication for @${username}? Their authenticator app and backup codes stop working immediately, and they sign in with their password alone until they enrol again.`,
            "Reset two-factor authentication",
            true
        );
        if (!ok) return;
        setBusy(true);
        try {
            await mfaApi.resetForUser(userId);
            setWasReset(true);
        } catch (e: any) {
            // Show the server's own message: it distinguishes the refusals that matter (privileged
            // target, self, an API token instead of a session) and inventing copy here would hide them.
            await alert(e?.message || "Could not reset two-factor authentication.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={className}>
            <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Two-Factor Authentication</h3>
            {wasReset ? (
                // The users API does not report whether an account has 2FA enabled, so the only state this
                // screen can honestly assert is the one it just caused. Say exactly that, and no more.
                <p className="text-sm font-medium text-emerald-600">
                    <i className="fa-solid fa-shield-halved mr-2"></i>
                    Two-factor authentication cleared for @{username}. They can sign in with their password and enrol again from their account page.
                </p>
            ) : (
                <>
                    <p className="text-[11px] text-gray-400 leading-relaxed mb-3">
                        If @{username} lost their authenticator, clear their second factor so they can sign in with their
                        password again and re-enrol. Their password is not changed.
                    </p>
                    <button
                        type="button"
                        onClick={handleReset}
                        disabled={busy}
                        className="px-6 py-3 border-2 border-red-100 text-red-600 rounded-2xl hover:bg-red-50 font-bold text-xs uppercase tracking-widest transition-all disabled:opacity-50"
                    >
                        {busy ? "Resetting…" : "Reset two-factor"}
                    </button>
                </>
            )}
        </div>
    );
}
