"use client";

import { useState, useEffect } from "react";
import { commentsApi, Comment } from "@/lib/api";
import { sanitizeHTML } from "@/lib/sanitize";

// Local initials avatar — no request to the external avatar service. Background is a
// deterministic pick (simple char-code hash of the name) over the theme token palette.
const AVATAR_BG = [
    "var(--wjs-color-primary,#2563eb)",
    "var(--wjs-color-secondary,#6b7280)",
];

// The hidden field the backend traps on (routes/comments.ts HONEYPOT_FIELD, and the SAME name the
// contact-form block uses — one convention per site). A human never sees it and never fills it, so a
// non-empty value on the wire is a bot; the server answers such a request exactly as it answers a real
// one and stores nothing. It is hidden OFF-SCREEN rather than with `display:none`/`hidden`: naive bots
// skip fields that are not rendered, and this trap only works if they fill it.
const HONEYPOT_FIELD = "_hp";

function InitialsAvatar({ name }: { name: string }) {
    const initials = (name || "").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
    let hash = 0;
    for (let i = 0; i < (name || "").length; i++) hash = (hash + name.charCodeAt(i)) % AVATAR_BG.length;
    return (
        <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold select-none"
            style={{ background: AVATAR_BG[hash], color: "var(--wjs-color-on-primary,#fff)" }}
            aria-hidden="true"
        >
            {initials}
        </div>
    );
}

export default function CommentsSection({ postId }: { postId: number }) {
    const [comments, setComments] = useState<Comment[]>([]);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [successMessage, setSuccessMessage] = useState("");

    // Form state
    const [authorName, setAuthorName] = useState("");
    const [authorEmail, setAuthorEmail] = useState("");
    const [authorUrl, setAuthorUrl] = useState("");
    const [content, setContent] = useState("");
    // Always sent, always empty for a human — see HONEYPOT_FIELD.
    const [honeypot, setHoneypot] = useState("");

    useEffect(() => {
        loadComments();
    }, [postId]);

    const loadComments = async () => {
        setLoading(true);
        setError("");
        try {
            const data = await commentsApi.list({ post: postId, status: '1' }); // Only approved
            setComments(data);
        } catch (err) {
            console.error("Failed to load comments", err);
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setSuccessMessage("");

        if (!content.trim() || !authorName.trim() || !authorEmail.trim()) {
            setError("Please fill in all required fields.");
            return;
        }

        setSubmitting(true);
        try {
            // Built as a value rather than passed as a literal on purpose: the honeypot is anti-spam
            // plumbing, not part of a comment, so commentsApi.create's declared body does not name it —
            // and TypeScript's excess-property check only fires on a fresh literal handed straight to
            // the call. Widening the API type instead would put `_hp` in every caller's contract.
            const payload = {
                post: postId,
                content,
                author_name: authorName,
                author_email: authorEmail,
                author_url: authorUrl,
                [HONEYPOT_FIELD]: honeypot
            };
            await commentsApi.create(payload);
            setSuccessMessage("Comment submitted successfully! It awaits moderation.");
            setContent("");
            // Don't reload immediately if it's pending moderation, 
            // but if we were logged in (future improvement) we might see it.
            // For now, just clear form.
        } catch (err: any) {
            console.error(err);
            setError(err.message || "Failed to submit comment.");
        } finally {
            setSubmitting(false);
        }
    };

    if (loading) return <div className="py-8 text-center text-[var(--wjs-color-text-muted,#6b7280)]">Loading comments...</div>;

    // Token hooks below prefer UNDECLARED contract tokens (card-*/button-*/form-*): ui.css :root
    // pre-declares e.g. --wjs-color-danger (a SOLID color) and would beat any Tailwind-parity
    // fallback, repainting today's render. Declared tokens are only used where their ui.css
    // default equals the current Tailwind value (--wjs-radius 0.5rem, --wjs-radius-lg 0.75rem).
    // `wjs-comment*` hooks are the theme contract: STABLE names alongside the Tailwind utilities, so a
    // theme can style the thread declaratively. They carry no styling themselves; the manifest promises
    // them and the chrome-selector contract test proves this markup still emits them.
    const inputClass = "wjs-comment-field w-full px-4 py-2 border border-[var(--wjs-border-subtle,#e5e7eb)] rounded-[var(--wjs-form-input-radius,0.5rem)] bg-[var(--wjs-bg-surface,#fff)] text-[var(--wjs-color-text-main,#111827)] focus:ring-2 focus:ring-[var(--wjs-color-primary,#2563eb)] focus:border-transparent outline-none transition";

    return (
        <div className="wjs-comments max-w-3xl mx-auto py-12 px-4 border-t border-[var(--wjs-border-subtle,#e5e7eb)] mt-12 bg-[var(--wjs-bg-muted,#f9fafb)] rounded-[var(--wjs-radius-lg,0.75rem)]">
            <h3 className="wjs-comments-title text-2xl font-bold text-[var(--wjs-color-heading,#111827)] mb-8">
                Comments ({comments.length})
            </h3>

            {/* Comments List */}
            <div className="wjs-comment-list space-y-8 mb-12">
                {comments.length === 0 ? (
                    <p className="wjs-comments-empty text-[var(--wjs-color-text-muted,#6b7280)] italic">No comments yet. Be the first to share your thoughts!</p>
                ) : (
                    comments.map((comment) => (
                        <div key={comment.id} className="wjs-comment flex gap-4">
                            <div className="wjs-comment-avatar flex-shrink-0">
                                {comment.authorAvatarUrl ? (
                                    <img
                                        src={comment.authorAvatarUrl}
                                        alt={comment.author}
                                        className="w-10 h-10 rounded-full"
                                    />
                                ) : (
                                    <InitialsAvatar name={comment.author} />
                                )}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="wjs-comment-body bg-[var(--wjs-bg-surface,#fff)] p-4 rounded-[var(--wjs-card-radius,0.5rem)] shadow-[var(--wjs-card-shadow,0_1px_3px_0_rgba(0,0,0,0.1),0_1px_2px_-1px_rgba(0,0,0,0.1))] border border-[var(--wjs-border-subtle,#e5e7eb)]">
                                    <div className="wjs-comment-head flex justify-between items-start mb-2 gap-2">
                                        <h4 className="wjs-comment-author font-bold text-[var(--wjs-color-heading,#111827)] break-words min-w-0">{comment.author}</h4>
                                        <span className="wjs-comment-date text-xs text-[var(--wjs-color-text-muted,#6b7280)] shrink-0">
                                            {new Date(comment.date).toLocaleDateString()}
                                        </span>
                                    </div>
                                    <div className="wjs-comment-content prose prose-sm text-[var(--wjs-color-text-main,#374151)] max-w-none break-words overflow-x-auto [&_table]:block [&_table]:overflow-x-auto [&_pre]:overflow-x-auto" dangerouslySetInnerHTML={{ __html: sanitizeHTML(comment.content) }} />
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* Comment Form */}
            <div className="wjs-comment-form bg-[var(--wjs-bg-surface,#fff)] p-6 rounded-[var(--wjs-card-radius,0.75rem)] shadow-[var(--wjs-card-shadow,0_1px_3px_0_rgba(0,0,0,0.1),0_1px_2px_-1px_rgba(0,0,0,0.1))] border border-[var(--wjs-border-subtle,#e5e7eb)]">
                <h4 className="wjs-comment-form-title text-lg font-bold text-[var(--wjs-color-heading,#111827)] mb-4">Leave a Reply</h4>

                {/* Alert bg tints (red-50/green-50) stay literal: the contract has no undeclared danger/
                    success-surface token, and --wjs-color-danger/success are pre-declared SOLIDS. */}
                {error && (
                    <div role="alert" aria-live="polite" className="bg-red-50 text-[var(--wjs-form-error-color,oklch(57.7%_0.245_27.325))] p-3 rounded-[var(--wjs-radius,0.5rem)] text-sm mb-4">
                        {error}
                    </div>
                )}

                {successMessage && (
                    <div role="alert" aria-live="polite" className="bg-green-50 text-[var(--wjs-form-success-color,oklch(62.7%_0.194_149.214))] p-3 rounded-[var(--wjs-radius,0.5rem)] text-sm mb-4">
                        {successMessage}
                    </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label htmlFor="comment-author-name" className="block text-sm font-medium text-[var(--wjs-color-text-main,#374151)] mb-1">Name *</label>
                            <input
                                id="comment-author-name"
                                type="text"
                                required
                                aria-invalid={!!error && !authorName.trim()}
                                value={authorName}
                                onChange={(e) => setAuthorName(e.target.value)}
                                className={inputClass}
                            />
                        </div>
                        <div>
                            <label htmlFor="comment-author-email" className="block text-sm font-medium text-[var(--wjs-color-text-main,#374151)] mb-1">Email *</label>
                            <input
                                id="comment-author-email"
                                type="email"
                                required
                                aria-invalid={!!error && !authorEmail.trim()}
                                value={authorEmail}
                                onChange={(e) => setAuthorEmail(e.target.value)}
                                className={inputClass}
                            />
                        </div>
                    </div>
                    <div>
                        <label htmlFor="comment-author-url" className="block text-sm font-medium text-[var(--wjs-color-text-main,#374151)] mb-1">Website</label>
                        <input
                            id="comment-author-url"
                            type="url"
                            value={authorUrl}
                            onChange={(e) => setAuthorUrl(e.target.value)}
                            className={inputClass}
                        />
                    </div>
                    <div>
                        <label htmlFor="comment-content" className="block text-sm font-medium text-[var(--wjs-color-text-main,#374151)] mb-1">Comment *</label>
                        <textarea
                            id="comment-content"
                            required
                            rows={4}
                            aria-invalid={!!error && !content.trim()}
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            className={inputClass}
                        ></textarea>
                    </div>
                    {/* Honeypot anti-spam — see HONEYPOT_FIELD. Off-screen, out of the tab order,
                        hidden from assistive tech and never autofilled, so no human ever meets it. */}
                    <div
                        className="wjs-comment-hp"
                        aria-hidden="true"
                        style={{
                            position: "absolute",
                            left: "-9999px",
                            top: "auto",
                            width: "1px",
                            height: "1px",
                            overflow: "hidden",
                        }}
                    >
                        <label htmlFor="comment-hp">Do not fill in this field</label>
                        <input
                            id="comment-hp"
                            type="text"
                            name={HONEYPOT_FIELD}
                            tabIndex={-1}
                            autoComplete="off"
                            value={honeypot}
                            onChange={(e) => setHoneypot(e.target.value)}
                        />
                    </div>
                    <button
                        type="submit"
                        disabled={submitting}
                        className="wjs-comment-submit px-6 py-2 bg-[var(--wjs-color-primary,#2563eb)] text-[var(--wjs-color-on-primary,#ffffff)] font-medium rounded-[var(--wjs-button-radius,0.5rem)] hover:opacity-90 disabled:opacity-50 transition shadow-[var(--wjs-button-shadow,0_1px_3px_0_rgba(0,0,0,0.1),0_1px_2px_-1px_rgba(0,0,0,0.1))]"
                    >
                        {submitting ? "Posting..." : "Post Comment"}
                    </button>
                </form>
            </div>
        </div>
    );
}
