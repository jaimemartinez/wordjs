"use client";

import { useState, useEffect } from "react";
import { commentsApi, Comment } from "@/lib/api";
import { sanitizeHTML } from "@/lib/sanitize";

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
            await commentsApi.create({
                post: postId,
                content,
                author_name: authorName,
                author_email: authorEmail,
                author_url: authorUrl
            });
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

    const inputClass = "w-full px-4 py-2 border border-[var(--wjs-border-subtle,#e5e7eb)] rounded-lg bg-[var(--wjs-bg-surface,#fff)] text-[var(--wjs-color-text-main,#111827)] focus:ring-2 focus:ring-[var(--wjs-color-primary,#2563eb)] focus:border-transparent outline-none transition";

    return (
        <div className="max-w-3xl mx-auto py-12 px-4 border-t border-[var(--wjs-border-subtle,#e5e7eb)] mt-12 bg-[var(--wjs-bg-muted,#f9fafb)] rounded-xl">
            <h3 className="text-2xl font-bold text-[var(--wjs-color-heading,#111827)] mb-8">
                Comments ({comments.length})
            </h3>

            {/* Comments List */}
            <div className="space-y-8 mb-12">
                {comments.length === 0 ? (
                    <p className="text-[var(--wjs-color-text-muted,#6b7280)] italic">No comments yet. Be the first to share your thoughts!</p>
                ) : (
                    comments.map((comment) => (
                        <div key={comment.id} className="flex gap-4">
                            <div className="flex-shrink-0">
                                <img
                                    src={comment.authorAvatarUrl || `https://ui-avatars.com/api/?name=${comment.author}&background=random`}
                                    alt={comment.author}
                                    className="w-10 h-10 rounded-full"
                                />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="bg-[var(--wjs-bg-surface,#fff)] p-4 rounded-lg shadow-sm border border-[var(--wjs-border-subtle,#e5e7eb)]">
                                    <div className="flex justify-between items-start mb-2 gap-2">
                                        <h4 className="font-bold text-[var(--wjs-color-heading,#111827)] break-words min-w-0">{comment.author}</h4>
                                        <span className="text-xs text-[var(--wjs-color-text-muted,#6b7280)] shrink-0">
                                            {new Date(comment.date).toLocaleDateString()}
                                        </span>
                                    </div>
                                    <div className="prose prose-sm text-[var(--wjs-color-text-main,#374151)] max-w-none break-words overflow-x-auto [&_table]:block [&_table]:overflow-x-auto [&_pre]:overflow-x-auto" dangerouslySetInnerHTML={{ __html: sanitizeHTML(comment.content) }} />
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* Comment Form */}
            <div className="bg-[var(--wjs-bg-surface,#fff)] p-6 rounded-xl shadow-sm border border-[var(--wjs-border-subtle,#e5e7eb)]">
                <h4 className="text-lg font-bold text-[var(--wjs-color-heading,#111827)] mb-4">Leave a Reply</h4>

                {error && (
                    <div role="alert" aria-live="polite" className="bg-red-50 text-red-600 p-3 rounded-lg text-sm mb-4">
                        {error}
                    </div>
                )}

                {successMessage && (
                    <div role="alert" aria-live="polite" className="bg-green-50 text-green-600 p-3 rounded-lg text-sm mb-4">
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
                    <button
                        type="submit"
                        disabled={submitting}
                        className="px-6 py-2 bg-[var(--wjs-color-primary,#2563eb)] text-[var(--wjs-color-on-primary,#ffffff)] font-medium rounded-lg hover:opacity-90 disabled:opacity-50 transition shadow-sm"
                    >
                        {submitting ? "Posting..." : "Post Comment"}
                    </button>
                </form>
            </div>
        </div>
    );
}
