"use client";

import React, { useEffect, useState } from "react";
import { revisionsApi, Revision, User, usersApi } from "@/lib/api";
import { formatDistanceToNow } from "date-fns";
import { useModal } from "@/contexts/ModalContext";

interface RevisionsSidebarProps {
    postId: number;
    isOpen: boolean;
    onClose: () => void;
    onRestore: (revision: Revision) => void;
}

// ---------------------------------------------------------------------------
// Word-level diff (LCS) for the "View changes" panel. Inputs are HTML: we strip
// tags and diff words. Common prefix/suffix are trimmed first so the O(n·m) DP
// only runs on the changed middle; beyond a hard cap we degrade to a plain
// "old vs new" block instead of freezing the tab.
// ---------------------------------------------------------------------------
type DiffTok = { t: "same" | "add" | "del"; w: string };

function htmlToWords(html: string): string[] {
    return (html || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .split(/\s+/)
        .filter(Boolean);
}

function wordDiff(oldHtml: string, newHtml: string): DiffTok[] | null {
    const a = htmlToWords(oldHtml);
    const b = htmlToWords(newHtml);
    // Trim the common prefix/suffix (typical revisions change a small middle region).
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const ca = a.slice(start, endA), cb = b.slice(start, endB);
    if (ca.length * cb.length > 1_500_000) return null; // too different/large — caller degrades

    // LCS lengths over the changed middle.
    const m = ca.length, n = cb.length;
    const dp = new Int32Array((m + 1) * (n + 1));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i * (n + 1) + j] = ca[i] === cb[j]
                ? dp[(i + 1) * (n + 1) + j + 1] + 1
                : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
        }
    }
    const out: DiffTok[] = a.slice(0, start).map((w) => ({ t: "same" as const, w }));
    let i = 0, j = 0;
    while (i < m && j < n) {
        if (ca[i] === cb[j]) { out.push({ t: "same", w: ca[i] }); i++; j++; }
        else if (dp[(i + 1) * (n + 1) + j] >= dp[i * (n + 1) + j + 1]) { out.push({ t: "del", w: ca[i] }); i++; }
        else { out.push({ t: "add", w: cb[j] }); j++; }
    }
    while (i < m) { out.push({ t: "del", w: ca[i] }); i++; }
    while (j < n) { out.push({ t: "add", w: cb[j] }); j++; }
    for (const w of a.slice(endA)) out.push({ t: "same", w });
    return out;
}

function DiffText({ toks }: { toks: DiffTok[] }) {
    return (
        <p className="text-sm leading-relaxed text-gray-700 whitespace-pre-wrap">
            {toks.map((tok, i) => tok.t === "same"
                ? <span key={i}>{tok.w} </span>
                : tok.t === "add"
                    ? <ins key={i} className="bg-green-100 text-green-800 no-underline rounded px-0.5">{tok.w} </ins>
                    : <del key={i} className="bg-red-100 text-red-700 rounded px-0.5">{tok.w} </del>)}
        </p>
    );
}

export default function RevisionsSidebar({ postId, isOpen, onClose, onRestore }: RevisionsSidebarProps) {
    const [revisions, setRevisions] = useState<Revision[]>([]);
    const [loading, setLoading] = useState(false);
    const [users, setUsers] = useState<Record<number, User>>({});
    const [diffRev, setDiffRev] = useState<Revision | null>(null); // revision being compared with the latest
    const { confirm } = useModal();

    useEffect(() => {
        if (isOpen && postId) {
            setDiffRev(null);
            loadRevisions();
        }
    }, [isOpen, postId]);

    const loadRevisions = async () => {
        setLoading(true);
        try {
            const data = await revisionsApi.list(postId);
            setRevisions(data.revisions);

            // Collect author IDs to fetch names. Read the current users via the
            // functional updater to avoid a stale closure, then fetch all missing
            // authors in parallel and merge once.
            const authorIds = Array.from(new Set(data.revisions.map(r => r.authorId)));
            setUsers(prev => {
                const missing = authorIds.filter(id => !prev[id]);
                if (missing.length > 0) {
                    Promise.all(
                        missing.map(async (id) => {
                            try {
                                return [id, await usersApi.get(id)] as const;
                            } catch (e) {
                                console.error(`Failed to fetch user ${id}`, e);
                                return null;
                            }
                        })
                    ).then(results => {
                        const fetched = results.filter((r): r is readonly [number, User] => r !== null);
                        if (fetched.length > 0) {
                            setUsers(curr => {
                                const next = { ...curr };
                                for (const [id, user] of fetched) next[id] = user;
                                return next;
                            });
                        }
                    });
                }
                return prev;
            });
        } catch (error) {
            console.error("Failed to load revisions:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleRestoreClick = async (revision: Revision) => {
        const ok = await confirm(
            "Restore Revision",
            `Are you sure you want to restore the version from ${new Date(revision.modified).toLocaleString()}? Your current unsaved changes will be lost.`
        );
        if (ok) {
            onRestore(revision);
        }
    };

    return (
        <div className={`fixed inset-y-0 right-0 w-full max-w-[400px] bg-white shadow-2xl z-[5000] transform transition-transform duration-300 ease-in-out border-l border-gray-100 flex flex-col ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
            {/* Header */}
            <div className="h-20 flex items-center justify-between px-6 border-b border-gray-50 bg-gray-50/30 shrink-0">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-amber-50 text-amber-600 rounded-xl flex items-center justify-center shadow-inner">
                        <i className="fa-solid fa-clock-rotate-left text-lg"></i>
                    </div>
                    <div>
                        <h3 className="font-black text-gray-900 italic tracking-tight">Revision History</h3>
                        <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">Version Control</p>
                    </div>
                </div>
                <button
                    onClick={onClose}
                    className="w-10 h-10 rounded-full hover:bg-white hover:shadow-md flex items-center justify-center text-gray-400 hover:text-red-500 transition-all border border-transparent hover:border-gray-100"
                >
                    <i className="fa-solid fa-xmark"></i>
                </button>
            </div>

            {/* Diff view (selected revision vs latest) */}
            {diffRev && (
                <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
                    <button
                        onClick={() => setDiffRev(null)}
                        className="mb-4 px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-bold text-gray-600 hover:border-blue-400 hover:text-blue-600 transition-all"
                    >
                        <i className="fa-solid fa-arrow-left mr-2"></i>All revisions
                    </button>
                    <div className="mb-4">
                        <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mb-1">Comparing</p>
                        <p className="text-xs text-gray-600">
                            <del className="bg-red-100 text-red-700 rounded px-1 no-underline">{new Date(diffRev.modified).toLocaleString()}</del>
                            <span className="mx-2 text-gray-300">→</span>
                            <ins className="bg-green-100 text-green-800 rounded px-1 no-underline">latest</ins>
                        </p>
                    </div>
                    {(() => {
                        const latest = revisions[0];
                        if (!latest) return null;
                        const titleToks = diffRev.title !== latest.title ? wordDiff(diffRev.title, latest.title) : null;
                        const toks = wordDiff(diffRev.content, latest.content);
                        return (
                            <div className="space-y-5">
                                {titleToks && (
                                    <div>
                                        <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mb-2">Title</p>
                                        <div className="p-4 rounded-xl border border-gray-100 bg-gray-50/50"><DiffText toks={titleToks} /></div>
                                    </div>
                                )}
                                <div>
                                    <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mb-2">Content</p>
                                    <div className="p-4 rounded-xl border border-gray-100 bg-gray-50/50">
                                        {toks
                                            ? (toks.some((t) => t.t !== "same")
                                                ? <DiffText toks={toks} />
                                                : <p className="text-sm text-gray-400 italic">No text changes — the difference may be in images or layout.</p>)
                                            : <p className="text-sm text-gray-400 italic">Versions differ too much for an inline diff — restore to inspect.</p>}
                                    </div>
                                </div>
                                <button
                                    onClick={() => handleRestoreClick(diffRev)}
                                    className="w-full px-4 py-3 bg-white border border-gray-200 rounded-xl text-[10px] font-black uppercase tracking-widest text-gray-600 hover:border-blue-500 hover:text-blue-600 hover:shadow-md transition-all active:scale-95"
                                >
                                    <i className="fa-solid fa-clock-rotate-left mr-2"></i>Restore this version
                                </button>
                            </div>
                        );
                    })()}
                </div>
            )}

            {/* List */}
            <div className={`flex-1 overflow-y-auto p-6 custom-scrollbar ${diffRev ? 'hidden' : ''}`}>
                {loading ? (
                    <div className="flex flex-col items-center justify-center h-full gap-4 text-gray-400">
                        <i className="fa-solid fa-circle-notch fa-spin text-2xl text-blue-500"></i>
                        <span className="text-xs font-bold uppercase tracking-widest">Loading Revisions...</span>
                    </div>
                ) : revisions.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full gap-4 text-gray-300 opacity-50">
                        <i className="fa-solid fa-ghost text-4xl"></i>
                        <span className="text-xs font-bold uppercase tracking-widest text-center">No revisions found yet.<br />Save your post to create one.</span>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {revisions.map((rev, index) => (
                            <div
                                key={rev.id || index}
                                className={`group p-5 rounded-2xl border transition-all relative overflow-hidden ${index === 0 ? 'bg-blue-50/30 border-blue-100' : 'bg-white border-gray-100 hover:border-blue-200 hover:shadow-lg hover:shadow-blue-500/5'}`}
                            >
                                {index === 0 && (
                                    <div className="absolute top-0 right-0 px-3 py-1 bg-blue-500 text-white text-[9px] font-black uppercase tracking-tighter rounded-bl-xl">
                                        Latest Revision
                                    </div>
                                )}

                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex-1">
                                        <div className="flex items-center gap-2 mb-1">
                                            <div className="w-6 h-6 rounded-full bg-white border border-gray-200 flex items-center justify-center text-[10px] text-gray-600 font-bold shadow-sm">
                                                {users[rev.authorId]?.displayName?.charAt(0) || <i className="fa-solid fa-user text-[8px]"></i>}
                                            </div>
                                            <span className="text-sm font-bold text-gray-900 leading-none">
                                                {users[rev.authorId]?.displayName || `Author #${rev.authorId}`}
                                            </span>
                                        </div>
                                        <p className="text-xs text-gray-500 font-medium">
                                            {formatDistanceToNow(new Date(rev.modified), { addSuffix: true })}
                                        </p>
                                        <p className="text-[10px] text-gray-400 mt-1 font-mono">
                                            {new Date(rev.modified).toLocaleString()}
                                        </p>
                                    </div>
                                    <div className="flex flex-col gap-2 shrink-0">
                                        <button
                                            onClick={() => handleRestoreClick(rev)}
                                            className="px-4 py-2 bg-white border border-gray-200 rounded-xl text-[10px] font-black uppercase tracking-widest text-gray-600 hover:border-blue-500 hover:text-blue-600 hover:shadow-md transition-all active:scale-95"
                                        >
                                            Restore
                                        </button>
                                        {index > 0 && (
                                            <button
                                                onClick={() => setDiffRev(rev)}
                                                className="px-4 py-2 bg-white border border-gray-200 rounded-xl text-[10px] font-black uppercase tracking-widest text-gray-600 hover:border-amber-500 hover:text-amber-600 hover:shadow-md transition-all active:scale-95"
                                                title="Compare with the latest revision"
                                            >
                                                <i className="fa-solid fa-code-compare mr-1"></i>Changes
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-gray-50 bg-gray-50/30">
                <p className="text-[10px] text-gray-400 text-center font-bold uppercase tracking-widest leading-relaxed">
                    Restoring a revision will replace your current content.<br />
                    A new revision will be created for the current state.
                </p>
            </div>
        </div>
    );
}
