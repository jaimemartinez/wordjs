"use client";

import { useEffect, useState } from "react";
import { HOST_NOT_ALLOWED_EVENT, hostNotAllowedWasAnnounced } from "@/lib/api";
import { canonicalLink, fillTemplate, noticeLanguage, storedAdminLanguage } from "@/lib/siteAddress";

/** The strings the bar needs, already resolved for one language. */
export interface HostNoticeStrings {
    title: string;
    goTo: string;
    admins: string;
}

export interface HostRefusal {
    /** `host[:port]` as the location bar shows it. */
    host: string;
    /** The refused origin, for the command an administrator runs to accept it. */
    origin: string;
    /** The configured main address (plus the current path), or null when there is none to offer. */
    link: { href: string; origin: string } | null;
}

/**
 * The bar itself: which address was refused, where the site does answer, and how an administrator fixes
 * it. Deliberately NO form and NO button that acts: a page on an address the operator never declared may
 * be a phishing or DNS-rebinding page, so the only thing offered is a plain link to the configured main
 * address. Every value is rendered as text.
 */
export function HostNotAllowedBar({ refusal, strings }: { refusal: HostRefusal; strings: HostNoticeStrings }) {
    // backend/scripts/site-address.js: what accepts this address from the server's own shell.
    const command = `npm run site -- add ${refusal.origin}`;
    const [beforeCommand, afterCommand = ""] = strings.admins.split("{command}");
    return (
        <div
            role="alert"
            data-wjs-host-not-allowed=""
            className="fixed inset-x-0 top-0 z-[6000] border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-md"
        >
            <div className="mx-auto flex max-w-5xl flex-col gap-1">
                <p className="font-semibold">
                    {fillTemplate(strings.title, { host: refusal.host })}
                    {refusal.link && (
                        <>
                            {" "}
                            <a href={refusal.link.href} rel="nofollow" className="underline underline-offset-2 hover:text-amber-800">
                                {fillTemplate(strings.goTo, { canonical: refusal.link.origin })}
                            </a>
                        </>
                    )}
                </p>
                <p className="text-amber-900/90">
                    {beforeCommand}
                    <code className="rounded bg-amber-100 px-1 font-mono text-xs">{command}</code>
                    {afterCommand}
                </p>
            </div>
        </div>
    );
}

/**
 * Mounted once in the root layout. Silent until the backend refuses this page's address (api() and
 * AuthContext announce a 421 once per page), then shows the bar.
 *
 * `canonical` is the configured main address from the server render (the same `siteurl` the layout's
 * metadataBase uses); `documentLang` is the site's language, used when the admin never picked one. The
 * translations load only when the bar is needed: lib/i18n is the whole admin catalogue, and no public
 * page should pay for it to cover a condition that is normally never met.
 */
export default function HostNotAllowedNotice({ canonical, documentLang }: { canonical: string | null; documentLang: string | null }) {
    const [refusal, setRefusal] = useState<HostRefusal | null>(null);
    const [strings, setStrings] = useState<HostNoticeStrings | null>(null);

    useEffect(() => {
        const show = () => setRefusal({
            host: window.location.host,
            origin: window.location.origin,
            link: canonicalLink(canonical, window.location),
        });
        // A request may have been refused before this effect ran.
        if (hostNotAllowedWasAnnounced()) show();
        window.addEventListener(HOST_NOT_ALLOWED_EVENT, show);
        return () => window.removeEventListener(HOST_NOT_ALLOWED_EVENT, show);
    }, [canonical]);

    useEffect(() => {
        if (!refusal) return;
        let active = true;
        const lang = noticeLanguage(storedAdminLanguage(() => window.localStorage), documentLang);
        import("@/lib/i18n").then(({ t }) => {
            if (active) setStrings({ title: t("hostNotice.title", lang), goTo: t("hostNotice.goTo", lang), admins: t("hostNotice.admins", lang) });
        });
        return () => { active = false; };
    }, [refusal, documentLang]);

    if (!refusal || !strings) return null;
    return <HostNotAllowedBar refusal={refusal} strings={strings} />;
}
