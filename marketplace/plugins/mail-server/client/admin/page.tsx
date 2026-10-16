// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the
// frontend tsc (react/deps resolve at bundle time, not in the frontend-only CI). Matches every other
// plugin's client components (card-gallery, photo-carousel, video-gallery).
"use client";

// Email Center: the webmail (every account with a corporate mailbox) and the mail-server console
// (administrators). This file is only the shell — the access probe, the view switch, toasts and the
// language; the two apps live in Webmail.tsx and ServerAdmin.tsx.
import { useEffect, useState } from "react";
import { api } from "../../../../../frontend/src/lib/api";
import { useAuth } from "../../../../../frontend/src/contexts/AuthContext";
import { useModal } from "@/contexts/ModalContext";
import { useT } from "./i18n";
import { useToasts, ToastHost, Spinner } from "./ui";
import Webmail from "./Webmail";
import ServerAdmin from "./ServerAdmin";

// Answer of GET /plugin/mail-server/mailbox — "may this account use the mail surface at all?".
// The backend gates every mail route on an ACTIVE CORPORATE MAILBOX (index.js: hasCorporateMailbox);
// this is the one mail route deliberately left ungated so the UI can ask instead of being 403'd.
type MailAccess = { hasMailbox: boolean; canUseMail: boolean; isAdmin: boolean; address: string | null; siteDomain: string };

export default function MailServerAdmin() {
    const { user } = useAuth();
    const { confirm } = useModal();
    const { t, locale } = useT();
    const toasts = useToasts();
    // null = not asked yet. Nothing is loaded until this resolves: without a corporate mailbox every
    // mail route 403s, so fetching first would only paint a screen of failures.
    const [access, setAccess] = useState<MailAccess | null>(null);
    const [view, setView] = useState<'mail' | 'server'>(() => {
        try { return new URLSearchParams(window.location.search).get('view') === 'server' ? 'server' : 'mail'; } catch { return 'mail'; }
    });

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const info = await api('/plugin/mail-server/mailbox') as MailAccess;
                if (alive) setAccess(info);
            } catch (e) {
                // Undeterminable (offline, or an older backend): fail OPEN in the UI only — the server is
                // the security boundary and still 403s every mail route for an account without a mailbox.
                if (alive) setAccess({ hasMailbox: true, canUseMail: true, isAdmin: user?.role === 'administrator', address: null, siteDomain: '' });
            }
        })();
        return () => { alive = false; };
    }, []);

    const isAdmin = !!(access?.isAdmin || user?.role === 'administrator');
    // An administrator without an inbox of their own manages the server; there is no mailbox to show.
    const effectiveView = access && !access.canUseMail && isAdmin ? 'server' : view;
    const switchView = (v: 'mail' | 'server') => {
        setView(v);
        try {
            const url = new URL(window.location.href);
            if (v === 'server') url.searchParams.set('view', 'server'); else url.searchParams.delete('view');
            url.searchParams.delete('id');
            window.history.replaceState(null, '', url.toString());
        } catch { /* no history API */ }
    };

    let body;
    if (!access) {
        body = <div className="flex h-full items-center justify-center"><Spinner className="text-2xl" /></div>;
    } else if (!access.canUseMail && !isAdmin) {
        // NO CORPORATE MAILBOX → no mail app. The server refuses every mail route for this account; this
        // is the one actionable sentence instead of a dead screen. (Core already hides the menu entry —
        // reaching this is a direct URL or a stale tab whose mailbox was just switched off.)
        body = (
            <div className="flex h-full items-center justify-center bg-slate-50 p-6">
                <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
                    <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-50 text-xl text-violet-600"><i className="fa-solid fa-envelope-circle-check"></i></div>
                    <h2 className="text-lg font-bold text-slate-900">{t('access.title')}</h2>
                    <p className="mt-3 text-sm leading-relaxed text-slate-600">{t('access.body1', { domain: access.siteDomain ? `@${access.siteDomain}` : '' })}</p>
                    <p className="mt-3 text-sm leading-relaxed text-slate-600">{t('access.body2')}</p>
                </div>
            </div>
        );
    } else if (effectiveView === 'server' && isAdmin) {
        body = <ServerAdmin t={t} locale={locale} toasts={toasts} confirm={confirm} canUseMail={access.canUseMail} onBack={() => switchView('mail')} />;
    } else {
        body = <Webmail access={access} user={user} t={t} locale={locale} toasts={toasts} confirm={confirm} isAdmin={isAdmin} onOpenServer={() => switchView('server')} />;
    }

    return (
        <div className="relative h-full min-h-[480px] w-full overflow-hidden font-sans antialiased" style={{ height: '100%' }}>
            {body}
            <ToastHost toasts={toasts.toasts} dismiss={toasts.dismiss} dismissLabel={t('common.dismiss')} />
        </div>
    );
}
