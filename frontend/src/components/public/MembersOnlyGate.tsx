"use client";

/**
 * MEMBERS-ONLY ENTRIES on the public site (backend core/content-access).
 *
 * The public page is rendered ANONYMOUSLY and cached (ISR), so the server only ever has the entry's
 * TEASER — the API cut its body, excerpt and page-builder tree at the access break. This island is the
 * other half: in the browser of a signed-in visitor it asks the same API again, with their own session,
 * and when the answer comes back `granted` it swaps the teaser for the full body (and the comments,
 * which are gated with the entry). Nothing withheld ever sits in the cached HTML.
 *
 * Signed-out visitors never cause a request: the `wjs_csrf` cookie is issued alongside every session
 * cookie (the session cookie itself is HttpOnly), so its absence is "no session" without asking.
 * Whatever the provider plugin's paywall block draws at the break stays as it is — this island only adds
 * a plain notice when the entry has no teaser at all.
 */
import React, { useEffect, useState } from "react";
import ContentRenderer from "@/components/content/ContentRenderer";
import CommentsSection from "@/components/CommentsSection";
import { sanitizeHTML } from "@/lib/sanitize";
import { readCsrfToken } from "@/lib/csrf";
import type { PublicUiStrings, MembersGateStrings } from "@/lib/public/uiStrings";

interface FullEntry {
    content?: string;
    meta?: Record<string, unknown>;
    access?: { granted?: boolean };
}

interface MembersOnlyGateProps {
    postId: number;
    /** How the body renders: the Verso tree, or the sanitized HTML body with these classes. */
    mode: "verso" | "html";
    htmlClassName?: string;
    ixPresets?: string;
    motion?: string;
    ui?: PublicUiStrings;
    strings: MembersGateStrings;
    /** The teaser is empty: show the notice (the paywall block, when present, is in the teaser). */
    showNotice: boolean;
    /** Render the comments once access is confirmed (the server withheld them with the body). */
    commentsWhenGranted: boolean;
    /** The «registered users only» comment setting, passed through to CommentsSection. */
    commentsRequireLogin?: boolean;
    /** The teaser, server-rendered. */
    children: React.ReactNode;
}


export default function MembersOnlyGate(props: MembersOnlyGateProps) {
    const { postId, mode, htmlClassName, ixPresets, motion, ui, strings, showNotice, commentsWhenGranted, commentsRequireLogin, children } = props;
    const [full, setFull] = useState<FullEntry | null>(null);
    const [checking, setChecking] = useState(false);
    // `?redirect=<this page>` for the sign-in / sign-up links, set after mount so the server HTML and the
    // first client render agree (the login page re-checks that it is a same-origin path).
    const [returnQuery, setReturnQuery] = useState("");

    useEffect(() => {
        setReturnQuery(`?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }, []);

    useEffect(() => {
        if (!readCsrfToken()) return; // no session → the teaser is the answer
        let active = true;
        setChecking(true);
        fetch(`/api/v1/posts/${postId}`, { credentials: "include", cache: "no-store" })
            .then((r) => (r.ok ? r.json() : null))
            .then((entry: FullEntry | null) => {
                if (active && entry && entry.access && entry.access.granted) setFull(entry);
            })
            .catch(() => { /* network trouble: keep the teaser */ })
            .finally(() => { if (active) setChecking(false); });
        return () => { active = false; };
    }, [postId]);

    if (full) {
        const data = full.meta && (full.meta as any)._puck_data;
        return (
            <>
                {mode === "verso" && data ? (
                    <div className="wjs-post-body puck-content">
                        <ContentRenderer data={data as any} ixPresets={ixPresets} motion={motion} ui={ui} />
                    </div>
                ) : (
                    <div className={htmlClassName} dangerouslySetInnerHTML={{ __html: sanitizeHTML(full.content || "") }} />
                )}
                {commentsWhenGranted && <CommentsSection postId={postId} requireLogin={commentsRequireLogin} />}
            </>
        );
    }

    return (
        <>
            {children}
            {showNotice && (
                <div className="wjs-members-only max-w-xl mx-auto my-10 px-6 py-8 text-center rounded-2xl border border-[var(--wjs-border-subtle,#e5e7eb)] bg-[var(--wjs-bg-surface,#f9fafb)]" role="note">
                    <i className="fa-solid fa-lock text-2xl text-[var(--wjs-color-primary,#2563eb)]" aria-hidden="true"></i>
                    <h2 className="text-xl font-bold mt-3 mb-2 text-[var(--wjs-color-heading,#111827)]">{strings.title}</h2>
                    <p className="text-[var(--wjs-color-text-muted,#6b7280)] mb-5">{checking ? strings.checking : strings.body}</p>
                    {!checking && (
                        <div className="flex flex-wrap gap-3 justify-center">
                            <a className="wp-button button-primary" href={`/login${returnQuery}`}>{strings.login}</a>
                            {strings.signupOpen !== false && (
                                <a className="wp-button button-secondary" href={`/register${returnQuery}`}>{strings.signup}</a>
                            )}
                        </div>
                    )}
                </div>
            )}
        </>
    );
}
