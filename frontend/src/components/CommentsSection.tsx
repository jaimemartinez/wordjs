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

    if (loading) return <div className="py-8 text-center text-gray-500">Loading comments...</div>;

    return (
        <div className="max-w-3xl mx-auto py-12 px-4 border-t border-gray-100 mt-12 bg-gray-50/50 rounded-xl">
            <h3 className="text-2xl font-bold text-gray-900 mb-8">
                Comments ({comments.length})
            </h3>

            {/* Comments List */}
            <div className="space-y-8 mb-12">
                {comments.length === 0 ? (
                    <p className="text-gray-500 italic">No comments yet. Be the first to share your thoughts!</p>
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
                            <div className="flex-1">
                                <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-100">
                                    <div className="flex justify-between items-start mb-2">
                                        <h4 className="font-bold text-gray-900">{comment.author}</h4>
                                        <span className="text-xs text-gray-500">
                                            {new Date(comment.date).toLocaleDateString()}
                                        </span>
                                    </div>
                                    <div className="prose prose-sm text-gray-700 max-w-none" dangerouslySetInnerHTML={{ __html: sanitizeHTML(comment.content) }} />
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* Comment Form */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                <h4 className="text-lg font-bold text-gray-900 mb-4">Leave a Reply</h4>

                {error && (
                    <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm mb-4">
                        {error}
                    </div>
                )}

                {successMessage && (
                    <div className="bg-green-50 text-green-600 p-3 rounded-lg text-sm mb-4">
                        {successMessage}
                    </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                            <input
                                type="text"
                                required
                                value={authorName}
                                onChange={(e) => setAuthorName(e.target.value)}
                                className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
                            <input
                                type="email"
                                required
                                value={authorEmail}
                                onChange={(e) => setAuthorEmail(e.target.value)}
                                className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
                            />
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Website</label>
                        <input
                            type="url"
                            value={authorUrl}
                            onChange={(e) => setAuthorUrl(e.target.value)}
                            className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Comment *</label>
                        <textarea
                            required
                            rows={4}
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
                        ></textarea>
                    </div>
                    <button
                        type="submit"
                        disabled={submitting}
                        className="px-6 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition shadow-sm"
                    >
                        {submitting ? "Posting..." : "Post Comment"}
                    </button>
                </form>
            </div>
        </div>
    );
}
