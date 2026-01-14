"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { postsApi, categoriesApi, Category } from "@/lib/api";
import { postConfig } from "@/components/puckConfig";
import PuckEditor from "@/components/PuckEditor";
import Header from "@/components/public/Header";
import Footer from "@/components/public/Footer";
import { Data } from "@measured/puck";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";

export default function PostEditorPage() {
    const router = useRouter();
    const params = useParams();
    const isNew = params.id === "new";
    const postId = isNew ? null : Number(params.id);

    const [title, setTitle] = useState("");
    const [slug, setSlug] = useState("");
    const [content, setContent] = useState("");
    // Store Puck data
    const [puckData, setPuckData] = useState<Data>({ content: [], root: {} });
    const [status, setStatus] = useState("draft");
    const [commentStatus, setCommentStatus] = useState("open");
    const [category, setCategory] = useState("");
    const [categories, setCategories] = useState<Category[]>([]);
    const [saving, setSaving] = useState(false);
    const [showPreview, setShowPreview] = useState(true);
    const [isLoading, setIsLoading] = useState(!isNew);
    const [lastSyncedTitle, setLastSyncedTitle] = useState("");
    const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
    const { isDirty, setIsDirty } = useUnsavedChanges();
    const changesCount = useRef(0);

    // Set initial dirty state for new posts
    useEffect(() => {
        if (isNew) setIsDirty(true);
        // Reset on unmount
        return () => setIsDirty(false);
    }, [isNew, setIsDirty]);

    // Auto-generate slug from title
    useEffect(() => {
        if (title && !slugManuallyEdited && title !== lastSyncedTitle) {
            const generatedSlug = title
                .toLowerCase()
                .trim()
                .replace(/[^\w\s-]/g, '')
                .replace(/[\s_-]+/g, '-')
                .replace(/^-+|-+$/g, '');
            setSlug(generatedSlug);
            // Also update puckData to keep sidebar in sync
            setPuckData(prev => ({
                ...prev,
                root: {
                    ...(prev.root as any),
                    slug: generatedSlug,
                    props: {
                        ...((prev.root as any)?.props || {}),
                        slug: generatedSlug
                    }
                }
            }));
            setLastSyncedTitle(title);
        }
    }, [title, slugManuallyEdited, lastSyncedTitle]);

    useEffect(() => {
        loadCategories();
        if (postId) {
            loadPost();
        }
    }, [postId]);

    const loadPost = async () => {
        try {
            const post = await postsApi.get(postId!);
            setTitle(post.title);
            setSlug(post.slug);
            setContent(post.content);
            setStatus(post.status);
            setCommentStatus(post.commentStatus || "open");

            // Load Puck data from meta if available
            if (post.meta && post.meta._puck_data) {
                setPuckData(post.meta._puck_data);
                if (post.meta._puck_data.root?.title) {
                    setTitle(post.meta._puck_data.root.title);
                }
            } else {
                // Seed Puck data with existing info for legacy posts
                const seededData: any = {
                    content: [],
                    root: {
                        title: post.title,
                        slug: post.slug,
                        props: {
                            title: post.title,
                            slug: post.slug,
                            category: "",
                            allowComments: post.commentStatus || "open"
                        }
                    }
                };
                setPuckData(seededData);
            }
        } catch (error) {
            console.error("Failed to load post:", error);
        } finally {
            setIsLoading(false);
        }
    };

    const loadCategories = async () => {
        try {
            const data = await categoriesApi.list();
            setCategories(data);
        } catch (error) {
            console.error("Failed to load categories:", error);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);

        try {
            const root = puckData.root as any;
            const finalTitle = root?.props?.title || root?.title || title;
            const finalSlug = root?.props?.slug || root?.slug || slug;

            if (!finalTitle) {
                alert("Title is required before saving.");
                setSaving(false);
                return;
            }

            const postData = {
                title: finalTitle,
                slug: finalSlug,
                content, // This content is now generated from Puck
                status,
                commentStatus,
                meta: {
                    _puck_data: puckData // Save the JSON structure for re-editing
                }
            };

            if (postId) {
                await postsApi.update(postId, postData);
            } else {
                await postsApi.create({ ...postData, type: "post" });
            }
            // Stay in editor - no redirect
            setIsDirty(false); // Reset dirty state after successful save
        } catch (error: any) {
            console.error("Failed to save post:", error);
            alert(`Failed to save post: ${error.message || "Unknown error"}`);
        } finally {
            setSaving(false);
        }
    };

    if (isLoading) {
        return <div className="p-8 text-center text-gray-500">Loading editor...</div>;
    }

    return (
        <div className="h-full w-full overflow-hidden flex flex-col">
            <PuckEditor
                config={postConfig}
                initialData={puckData}
                status={status}
                onStatusChange={setStatus}
                saving={saving}
                hasChanges={isDirty}
                onSave={handleSubmit as any}
                onCancel={() => router.back()}
                pageId={postId || undefined}
                onChange={(data) => {
                    // Ignore the first change event which is fired by Puck initialization
                    if (changesCount.current > 0) {
                        setIsDirty(true);
                    }
                    changesCount.current++;

                    setPuckData(data);
                    const root = data.root as any;
                    const newTitle = root?.props?.title || root?.title;
                    const newSlug = root?.props?.slug || root?.slug;
                    if (newTitle !== undefined) {
                        setTitle(newTitle);
                    }
                    if (newSlug !== undefined && newSlug !== slug) {
                        // User manually edited slug in sidebar
                        setSlugManuallyEdited(true);
                        setSlug(newSlug);
                    }
                    const newAllowComments = root?.props?.allowComments;
                    if (newAllowComments !== undefined) {
                        setCommentStatus(newAllowComments);
                    }
                    // Update content for SEO/Fallback HTML
                    let html = "";
                    data.content.forEach((item: any) => {
                        const props = item.props;
                        if (item.type === 'Heading') {
                            html += `<${props.level} class="font-bold my-4">${props.title}</${props.level}>`;
                        } else if (item.type === 'Text') {
                            html += `<div class="prose">${props.content}</div>`;
                        } else if (item.type === 'Image') {
                            html += `<img src="${props.src}" alt="${props.alt}" class="max-w-full my-4 rounded"/>`;
                        }
                    });
                    setContent(html);
                }}
            />
        </div>
    );
}
