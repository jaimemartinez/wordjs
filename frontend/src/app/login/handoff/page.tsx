"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { authApi } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";

/**
 * /login/handoff — where a network administrator's "Open as administrator" lands (multisite).
 *
 * Admin → Network on the main site answers a one-time URL on THIS site's address with the token in the
 * fragment (`#token=…`): a fragment never reaches a server, a log or a Referer. This page takes it, removes
 * it from the address bar and the history at once, and redeems it (POST /auth/handoff), which starts a
 * 30-minute session marked as a handoff (backend core/network-handoff). Then it goes to the admin, where the
 * handoff banner says who is in and until when. A token works once: a reload of this page cannot reuse it.
 */
// The language provider comes from the sign-in shell (login/layout.tsx → _root/AuthScreen.tsx).
export default function HandoffPage() {
    return <Handoff />;
}

/** Why the handoff failed: the server's message, or one of ours by its key. */
type Failure = { message: string } | { key: string };

function Handoff() {
    const { t } = useI18n();
    const [failure, setFailure] = useState<Failure | null>(null);
    const started = useRef(false);

    useEffect(() => {
        // Once per page: React's development double-run must not spend the token twice.
        if (started.current) return;
        started.current = true;
        const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        const token = params.get("token");
        // Out of the address bar and the history before anything else happens.
        window.history.replaceState(null, "", window.location.pathname);
        const redeem = token
            ? authApi.redeemHandoff(token).then(() => { window.location.replace("/admin"); })
            : Promise.reject({ key: "handoff.missing" });
        redeem.catch((err: any) => {
            setFailure(err?.key ? { key: err.key } : err?.message ? { message: String(err.message) } : { key: "handoff.failed" });
        });
    }, []);
    const error = failure ? ("key" in failure ? t(failure.key) : failure.message) : null;

    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-600 to-blue-800 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl p-8 w-full max-w-md text-center" data-handoff-state={error ? "failed" : "working"}>
                <h1 className="text-xl font-bold text-gray-800 flex items-center justify-center gap-3 mb-4">
                    <i className="fa-solid fa-sitemap text-blue-600" aria-hidden="true"></i>
                    {t("handoff.title")}
                </h1>
                {error ? (
                    <>
                        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm mb-4" role="alert">{error}</div>
                        <Link href="/login" className="text-sm font-semibold text-blue-600 underline underline-offset-2 hover:text-blue-800">{t("handoff.backToLogin")}</Link>
                    </>
                ) : (
                    <div className="flex items-center justify-center gap-3 text-gray-500 text-sm">
                        <span className="inline-block w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" aria-hidden="true"></span>
                        {t("handoff.working")}
                    </div>
                )}
            </div>
        </div>
    );
}
