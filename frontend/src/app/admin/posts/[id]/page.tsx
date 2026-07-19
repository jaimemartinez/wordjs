"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { useRouter, useParams } from "next/navigation";
import { postsApi, categoriesApi, Category } from "@/lib/api";
import { postConfig } from "@/components/puckConfig";
import { localizeConfig } from "@/lib/puckI18n";
import PuckEditor from "@/components/PuckEditor";
import PuckEditorSkeleton from "@/components/PuckEditorSkeleton";
import EditorLoadError from "@/components/EditorLoadError";
import { unhydratedSaveBlocked } from "@/lib/editorGuards";
import { Data } from "@wordjs/puck";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";
import { useModal } from "@/contexts/ModalContext";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/puckI18n";

export default function PostEditorPage() {
    const { t, language } = useI18n();
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
    const [categories, setCategories] = useState<Category[]>([]);
    const [saving, setSaving] = useState(false);
    const [isLoading, setIsLoading] = useState(!isNew);
    // Data-safety hydration tracking: `loaded` is true only once the EXISTING post's content has
    // successfully loaded; `loadError` blocks the editor entirely on failure. Until hydrated, saves are
    // refused so a blank editor can never overwrite the real post. New posts have nothing to hydrate.
    const [loaded, setLoaded] = useState(isNew);
    const [loadError, setLoadError] = useState<unknown>(null);
    const [lastSyncedTitle, setLastSyncedTitle] = useState("");
    const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
    const { isDirty, setIsDirty } = useUnsavedChanges();
    // Puck MAY fire onChange during initialization (migrate/resolveData). Skipping "the first
    // event" by counting was fragile: when no init event fires, the user's FIRST real change got
    // swallowed (save stayed disabled, autosave never armed). A short post-mount grace window
    // ignores init noise without ever eating a human edit.
    const mountedAtRef = useRef(Date.now());

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
        setLoadError(null);
        setLoaded(false); // never carry a previous record's hydrated state into a new load / retry
        setIsLoading(true);
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
                legacyHtmlRef.current = null; // real Puck blocks — not a legacy HTML body
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
                // Legacy post: its real body is HTML in `content` (the Puck canvas is BLANK). Remember it
                // so a save from the still-empty canvas preserves it instead of blanking the post.
                legacyHtmlRef.current = post.content || null;
            }
            setLoaded(true); // content is now hydrated — saving is safe
        } catch (error) {
            console.error("Failed to load post:", error);
            setLoadError(error); // block the editor so a blank stand-in can't overwrite the real post
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

    const { alert } = useModal();

    // Once a NEW post is first saved, remember its id — before this, every save created ANOTHER
    // post (params.id stays "new"). Also lets autosave create the draft once and then update it.
    const createdIdRef = useRef<number | null>(null);
    // Holds a legacy post's original HTML body while its Puck canvas is still empty (see loadPost).
    // Cleared once the user builds real blocks, after which the normal block→HTML path takes over.
    const legacyHtmlRef = useRef<string | null>(null);

    const handleSubmit = async (e?: React.FormEvent | { autosave?: boolean }) => {
        const isAutosave = !!(e && "autosave" in e && e.autosave);
        if (e && "preventDefault" in e) e.preventDefault();
        setSaving(true);

        // DATA-SAFETY: never write an existing post whose content hasn't hydrated — a blank/failed-load
        // editor must not overwrite the real body (autosave especially, which skips the revision snapshot).
        if (unhydratedSaveBlocked({ isNew, loaded })) {
            if (!isAutosave) await alert(trStr("No se pudo cargar el contenido; el guardado está deshabilitado para no sobrescribir la publicación.", language));
            setSaving(false);
            return;
        }

        try {
            // Flush any open inline editor and read the LIVE Puck store (same hardening as the page
            // editor): Puck's onChange deep-equal guard can leave the mirrored state stale.
            try { (window as any).puckCommitActive?.(); } catch { /* no open editor */ }
            const liveData = ((window as any).puckGetData?.() ?? puckData);
            const root = liveData.root as any;
            const finalTitle = root?.props?.title || root?.title || title;
            const finalSlug = root?.props?.slug || root?.slug || slug;

            if (!finalTitle) {
                // A background save must never pop a modal — just wait for a title.
                if (!isAutosave) await alert(t('post.edit.titleRequired'));
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
                    _puck_data: liveData, // Save the JSON structure for re-editing
                    // SEO fields
                    seo_title: root?.props?.seo_title || '',
                    seo_description: root?.props?.seo_description || '',
                    og_image: root?.props?.og_image || '',
                    noindex: root?.props?.noindex === 'true'
                },
                // Autosaves skip the revision snapshot server-side (see routes/posts.ts).
                ...(isAutosave ? { autosave: true } : {})
            };

            // Legacy body preservation: a legacy post still on a blank canvas must not be blanked — keep
            // its original HTML and don't stamp empty Puck data over it (which would orphan the body).
            if (!(liveData.content && liveData.content.length) && legacyHtmlRef.current) {
                postData.content = legacyHtmlRef.current;
                delete (postData.meta as any)._puck_data;
            }

            const effectiveId = postId ?? createdIdRef.current;
            if (effectiveId) {
                await postsApi.update(effectiveId, postData as any);
            } else {
                const created = await postsApi.create({ ...postData, type: "post" } as any);
                if (created?.id) {
                    createdIdRef.current = created.id;
                    // Keep the URL honest without remounting the editor mid-session.
                    window.history.replaceState(null, "", `/admin/posts/${created.id}`);
                }
            }
            // Stay in editor - no redirect
            setIsDirty(false); // Reset dirty state after successful save
        } catch (error: any) {
            console.error("Failed to save post:", error);
            if (!isAutosave) {
                await alert(`${t('post.edit.saveFailed')}: ${error.message || t('post.edit.unknownError')}`);
            }
        } finally {
            setSaving(false);
        }
    };

    const localizedConfig = useMemo(() => localizeConfig(postConfig, language), [language]);

    if (isLoading) {
        return <PuckEditorSkeleton />;
    }

    // Load failed → show a blocking error (with retry) instead of an empty, savable editor that would
    // silently overwrite the real post on the next save/autosave.
    if (loadError) {
        return <EditorLoadError onRetry={loadPost} onBack={() => router.back()} />;
    }

    return (
        <div className="h-full w-full overflow-hidden flex flex-col">
            <PuckEditor
                config={localizedConfig}
                initialData={puckData}
                status={status}
                onStatusChange={setStatus}
                saving={saving}
                hasChanges={isDirty}
                onSave={handleSubmit as any}
                onCancel={() => router.back()}
                pageId={postId || undefined}
                previewSlug={slug || undefined}
                onChange={(data) => {
                    // Ignore init-time events only (see mountedAtRef note above).
                    if (Date.now() - mountedAtRef.current > 800) {
                        setIsDirty(true);
                    }

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
                    // Regenerate the fallback HTML from blocks — EXCEPT a legacy post still on a blank
                    // canvas (its body lives in `content` HTML, not blocks): don't clobber it to "".
                    if (data.content.length > 0) legacyHtmlRef.current = null; // real blocks now exist
                    if (!(data.content.length === 0 && legacyHtmlRef.current)) {
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
                    }
                }}
            />
        </div>
    );
}
