"use client";

/**
 * PASSWORD-PROTECTED ENTRIES on the public site (WordPress "password protected" visibility, carried
 * over by the WXR importer and set from the editor). The cached page holds only the title and this
 * form; the reader's password goes to POST /posts/:id/unlock, which answers the entry as its readers see
 * it, and the body renders here. Nothing protected ever sits in the cached HTML.
 */
import React, { useState } from "react";
import ContentRenderer from "@/components/content/ContentRenderer";
import { sanitizeHTML } from "@/lib/sanitize";
import { CSRF_HEADER, readCsrfToken } from "@/lib/csrf";
import type { PublicUiStrings, ProtectedEntryStrings } from "@/lib/public/uiStrings";

interface UnlockedEntry {
    content?: string;
    meta?: Record<string, unknown>;
}

interface ProtectedEntryUnlockProps {
    postId: number;
    strings: ProtectedEntryStrings;
    htmlClassName?: string;
    ixPresets?: string;
    motion?: string;
    ui?: PublicUiStrings;
}

export default function ProtectedEntryUnlock({ postId, strings, htmlClassName, ixPresets, motion, ui }: ProtectedEntryUnlockProps) {
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [entry, setEntry] = useState<UnlockedEntry | null>(null);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!password || busy) return;
        setBusy(true);
        setError(null);
        try {
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            const csrf = readCsrfToken();
            if (csrf) headers[CSRF_HEADER] = csrf;
            const r = await fetch(`/api/v1/posts/${postId}/unlock`, {
                method: "POST",
                credentials: "include",
                cache: "no-store",
                headers,
                body: JSON.stringify({ password }),
            });
            if (r.ok) setEntry(await r.json());
            else setError(r.status === 429 ? strings.tooMany : strings.wrong);
        } catch {
            setError(strings.wrong);
        } finally {
            setBusy(false);
        }
    };

    if (entry) {
        const tree = entry.meta && (entry.meta as Record<string, unknown>)._puck_data;
        if (tree && typeof tree === "object") {
            return (
                <div className="wjs-post-body puck-content">
                    <ContentRenderer data={tree as never} ixPresets={ixPresets} motion={motion} ui={ui} />
                </div>
            );
        }
        return <div className={htmlClassName} dangerouslySetInnerHTML={{ __html: sanitizeHTML(entry.content || "") }} />;
    }

    return (
        <form onSubmit={submit} className="wjs-post-body wjs-post-protected max-w-md mx-auto px-4 py-8 text-center">
            <p className="mb-4 text-[var(--wjs-color-text-muted,#6b7280)]">{strings.notice}</p>
            <div className="flex gap-2 justify-center">
                <label className="sr-only" htmlFor={`wjs-pp-${postId}`}>{strings.password}</label>
                <input
                    id={`wjs-pp-${postId}`}
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={strings.password}
                    className="flex-1 min-w-0 rounded border border-[var(--wjs-color-border,#d1d5db)] bg-[var(--wjs-color-surface,#fff)] px-3 py-2 text-[var(--wjs-color-text,#111827)]"
                />
                <button
                    type="submit"
                    disabled={busy || !password}
                    className="rounded bg-[var(--wjs-color-primary,#2563eb)] px-4 py-2 font-semibold text-[var(--wjs-color-on-primary,#fff)] disabled:opacity-50"
                >
                    {strings.submit}
                </button>
            </div>
            {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
        </form>
    );
}
