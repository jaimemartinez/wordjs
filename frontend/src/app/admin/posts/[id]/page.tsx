"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import EngineToggle from "@/components/verso/editor/EngineToggle";
import EditorBootFallback from "@/components/verso/editor/EditorBootFallback";
import { postsApi, categoriesApi, Category } from "@/lib/api";
import { postConfig } from "@/components/puckConfig";
import { useRuntimePuckConfig } from "@/lib/useRuntimePuckConfig";
import { localizeConfig } from "@/lib/puckI18n";
import PuckEditor from "@/components/PuckEditor";
import PuckEditorSkeleton from "@/components/PuckEditorSkeleton";
import EditorLoadError from "@/components/EditorLoadError";
import VersoEditor from "@/components/verso/editor/VersoEditor";
import { rootFieldsPost } from "@/lib/verso/coreBlocks";
import { serializeContentFallback } from "@/lib/verso/contentFallback";
import { resolveEditorEngineFromBrowser, type EditorEngine } from "@/lib/editorEngine";
import type { EditorHandle } from "@/lib/verso/store";
import type { VersoData } from "@/lib/verso/types";
import { unhydratedSaveBlocked, seedLegacyPuckData, applyLegacyHtmlFallback, resolveWjsTemplateForSave, isWithinPostMountGrace } from "@/lib/editorGuards";
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
    // The serialized HTML body is REF, not state: it is regenerated on every canvas change (i.e. on
    // every keystroke) and is only ever read inside handleSubmit — never during render. As state it
    // re-rendered the whole editor on each letter typed.
    const contentRef = useRef("");
    // Store Puck data. `puckData` seeds the canvas ONCE (initialData); the live mirror used at save
    // time is the ref, updated in onChange — writing state there re-rendered the editor per keystroke.
    const [puckData, setPuckData] = useState<Data>({ content: [], root: {} });
    const puckDataRef = useRef<Data>({ content: [], root: {} });
    const [status, setStatus] = useState("draft");
    const [commentStatus, setCommentStatus] = useState("open");
    // The author's per-page theme-template pick (`_wjs_template` meta). State (not just a root prop
    // read at save time) because the canvas preview re-wraps on it live — see PuckEditor.assignedTemplate.
    const [assignedTemplate, setAssignedTemplate] = useState("");
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

    // F3 — engine flag: legacy es el DEFAULT ABSOLUTO; Verso solo con opt-in explícito
    // (?engine= / localStorage wjs_editor_engine / NEXT_PUBLIC_WORDJS_EDITOR_ENGINE). Se resuelve
    // tras montar (window/localStorage no existen en SSR — evita un mismatch de hidratación).
    const searchParams = useSearchParams();
    const [engine, setEngine] = useState<EditorEngine | null>(null);
    useEffect(() => {
        // Re-resuelve tambien en navegacion SUAVE (?engine= cambiado sin recarga) — el defecto
        // reportado: la resolucion de un solo mount dejaba el editor colgado/stale al cambiar la URL.
        setEngine(resolveEditorEngineFromBrowser());
    }, [searchParams]);
    // Handle vivo del motor Verso (null en legacy): el guardado lee getData() de aquí — el
    // documento REAL del store, sin mirrors (el equivalente Verso de window.puckGetData).
    const versoHandleRef = useRef<EditorHandle | null>(null);

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
            const withSlug = (prev: Data): Data => ({
                ...prev,
                root: {
                    ...(prev.root as any),
                    slug: generatedSlug,
                    props: {
                        ...((prev.root as any)?.props || {}),
                        slug: generatedSlug
                    }
                }
            });
            setPuckData(withSlug);
            puckDataRef.current = withSlug(puckDataRef.current);
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
            contentRef.current = post.content;
            setStatus(post.status);
            setCommentStatus(post.commentStatus || "open");
            // The saved template assignment. META is the source of truth (it may have been set via the
            // API, or before this field existed), so it is injected into root.props below rather than
            // trusting whatever a stale _puck_data carries.
            const savedTemplate = typeof post.meta?._wjs_template === "string" ? post.meta._wjs_template : "";
            setAssignedTemplate(savedTemplate);

            // Load Puck data from meta if available
            if (post.meta && post.meta._puck_data) {
                const stored = post.meta._puck_data;
                const withTemplate = {
                    ...stored,
                    root: {
                        ...(stored.root as any),
                        props: { ...((stored.root as any)?.props || {}), _wjs_template: savedTemplate }
                    }
                };
                setPuckData(withTemplate);
                puckDataRef.current = withTemplate;
                legacyHtmlRef.current = null; // real Puck blocks — not a legacy HTML body
                if (stored.root?.title) {
                    setTitle(stored.root.title);
                }
            } else {
                // Seed Puck data with existing info for legacy posts. A legacy/imported post keeps its
                // body as HTML in `content` with no _puck_data. Wrap that HTML in an HTMLEmbed block so it
                // is VISIBLE and editable in the canvas instead of opening blank. The block renders the
                // HTML sanitized (see puckConfig HTMLEmbed); the onChange serializer round-trips props.html
                // back into `content`, so the body is preserved (and updated when edited).
                const { data: seededData, legacyHtml } = seedLegacyPuckData({
                    html: post.content || "",
                    title: post.title,
                    slug: post.slug,
                    recordId: postId as number,
                    wjsTemplate: savedTemplate,
                    extraRootProps: { allowComments: post.commentStatus || "open" }
                });
                setPuckData(seededData as any);
                puckDataRef.current = seededData as any;
                // Safety net (belt-and-braces): keep the original body so an empty-canvas save can't blank
                // the post if the HTMLEmbed block is deleted before its HTML round-trips. Once the block
                // round-trips through onChange (content.length > 0), legacyHtmlRef is cleared.
                legacyHtmlRef.current = legacyHtml;
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

    // Returns whether the save actually landed, so the editor chrome can distinguish success from
    // failure (saved-state pill, autosave backoff) instead of assuming every attempt succeeded.
    const handleSubmit = async (e?: React.FormEvent | { autosave?: boolean }): Promise<boolean> => {
        const isAutosave = !!(e && "autosave" in e && e.autosave);
        if (e && "preventDefault" in e) e.preventDefault();
        setSaving(true);

        // DATA-SAFETY: never write an existing post whose content hasn't hydrated — a blank/failed-load
        // editor must not overwrite the real body (autosave especially, which skips the revision snapshot).
        if (unhydratedSaveBlocked({ isNew, loaded })) {
            if (!isAutosave) await alert(trStr("No se pudo cargar el contenido; el guardado está deshabilitado para no sobrescribir la publicación.", language));
            setSaving(false);
            return false;
        }

        try {
            // Flush any open inline editor and read the LIVE Puck store (same hardening as the page
            // editor): Puck's onChange deep-equal guard can leave the mirrored state stale.
            // Verso: the same two steps against the live EditorHandle (commitInline + getData), no mirrors.
            try {
                if (versoHandleRef.current) versoHandleRef.current.commitInline();
                else (window as any).puckCommitActive?.();
            } catch { /* no open editor */ }
            const liveData = (versoHandleRef.current?.getData() as any) ?? ((window as any).puckGetData?.() ?? puckDataRef.current);
            const root = liveData.root as any;
            const finalTitle = root?.props?.title || root?.title || title;
            const finalSlug = root?.props?.slug || root?.slug || slug;

            if (!finalTitle) {
                // A background save must never pop a modal — just wait for a title.
                if (!isAutosave) await alert(t('post.edit.titleRequired'));
                setSaving(false);
                return false;
            }

            const postData = {
                title: finalTitle,
                slug: finalSlug,
                content: contentRef.current, // This content is now generated from Puck
                status,
                commentStatus,
                meta: {
                    _puck_data: liveData, // Save the JSON structure for re-editing
                    // Per-page theme template. Always sent (backend merges meta per key): '' explicitly
                    // CLEARS a previous assignment — omitting the key would leave it stale forever.
                    _wjs_template: resolveWjsTemplateForSave(root?.props),
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
            const finalPostData = applyLegacyHtmlFallback(postData, liveData.content?.length ?? 0, legacyHtmlRef.current);

            const effectiveId = postId ?? createdIdRef.current;
            if (effectiveId) {
                await postsApi.update(effectiveId, finalPostData as any);
            } else {
                const created = await postsApi.create({ ...finalPostData, type: "post" } as any);
                if (created?.id) {
                    createdIdRef.current = created.id;
                    // Keep the URL honest without remounting the editor mid-session.
                    window.history.replaceState(null, "", `/admin/posts/${created.id}`);
                }
            }
            // Stay in editor - no redirect
            setIsDirty(false); // Reset dirty state after successful save
            return true;
        } catch (error: any) {
            console.error("Failed to save post:", error);
            if (!isAutosave) {
                await alert(`${t('post.edit.saveFailed')}: ${error.message || t('post.edit.unknownError')}`);
            }
            return false;
        } finally {
            setSaving(false);
        }
    };

    const localizedConfig = useMemo(() => localizeConfig(postConfig, language), [language]);
    // Add active marketplace plugins' Puck blocks to the editor palette/canvas at runtime.
    const runtimeConfig = useRuntimePuckConfig(localizedConfig);

    // `engine === null` solo dura el primer frame tras montar (la resolución es síncrona en el
    // efecto); el skeleton es el mismo que el de la carga, así que no hay parpadeo distinto.
    if (isLoading || engine === null) {
        return <EditorBootFallback />;
    }

    // Load failed → show a blocking error (with retry) instead of an empty, savable editor that would
    // silently overwrite the real post on the next save/autosave.
    if (loadError) {
        return <EditorLoadError onRetry={loadPost} onBack={() => router.back()} />;
    }

    return (
        <div key={engine} className="h-full w-full overflow-hidden flex flex-col">
            <EngineToggle current={engine} />
            {engine === "verso" ? (
                /* MOTOR VERSO (opt-in explícito). Mismas props de datos que alimentan a PuckEditor:
                   carga/seeding ya hechos arriba (loadPost/seedLegacyPuckData), handleSubmit idéntico
                   en semántica (lee el doc vivo vía versoHandleRef), root fields de POST (SEO/
                   categoría/comentarios — la asimetría del CMS, W41), y el fallback HTML usa el
                   módulo COMPARTIDO con el switch COMPLETO de pages: la divergencia W47 (posts solo
                   serializaba 4 tipos, sin clases wp-block-*) era drift accidental y se resuelve
                   hacia el lado completo — decisión ratificada del encargo F3. */
                <VersoEditor
                    initialData={puckData as unknown as VersoData}
                    status={status}
                    onStatusChange={setStatus}
                    saving={saving}
                    hasChanges={isDirty}
                    onSave={handleSubmit as any}
                    onCancel={() => router.back()}
                    breadcrumbRoot="Entradas"
                    pageId={postId || undefined}
                    previewSlug={slug || undefined}
                    rootFields={rootFieldsPost}
                    // W30: el canvas envuelve en la plantilla `single` (single-post → single → page),
                    // igual que la ruta pública del post; el pick _wjs_template se lee EN VIVO del store.
                    templateKind="single"
                    templatePostType="post"
                    handleRef={versoHandleRef}
                    onChange={(data: VersoData) => {
                        // Ignore init-time events only (see mountedAtRef note above).
                        if (!isWithinPostMountGrace(mountedAtRef.current, Date.now())) {
                            setIsDirty(true);
                        }
                        // Mirror de última instancia (el guardado prefiere versoHandleRef.getData()).
                        puckDataRef.current = data as unknown as Data;
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
                        const newTemplate = root?.props?._wjs_template;
                        if (typeof newTemplate === 'string' && newTemplate !== assignedTemplate) {
                            setAssignedTemplate(newTemplate);
                        }
                        // Fallback HTML desde bloques — EXCEPTO un post legacy aún en lienzo vacío
                        // (su cuerpo vive como HTML en `content`): no machacarlo a "".
                        if (data.content.length > 0) legacyHtmlRef.current = null;
                        if (!(data.content.length === 0 && legacyHtmlRef.current)) {
                            contentRef.current = serializeContentFallback(data.content);
                        }
                    }}
                />
            ) : (
            <PuckEditor
                config={runtimeConfig}
                initialData={puckData}
                status={status}
                onStatusChange={setStatus}
                saving={saving}
                hasChanges={isDirty}
                onSave={handleSubmit as any}
                onCancel={() => router.back()}
                breadcrumbRoot="Entradas"
                pageId={postId || undefined}
                previewSlug={slug || undefined}
                // OLA 3: preview the post inside the theme's `single` template (single-post-… → single →
                // page in the hierarchy), matching the public post route. The author's dropdown pick is
                // hoisted to the front of that chain, live (OLA 5).
                templateKind="single"
                templatePostType="post"
                assignedTemplate={assignedTemplate || undefined}
                onChange={(data) => {
                    // Ignore init-time events only (see mountedAtRef note above).
                    if (!isWithinPostMountGrace(mountedAtRef.current, Date.now())) {
                        setIsDirty(true);
                    }

                    // Mirror into the ref (not state): saving reads this, and a setState here would
                    // re-render the whole editor on every keystroke.
                    puckDataRef.current = data;
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
                    // Template pick from the sidebar dropdown — state so the canvas re-wraps live.
                    // Guarded on change (it fires per keystroke for unrelated edits, the value rarely moves).
                    const newTemplate = root?.props?._wjs_template;
                    if (typeof newTemplate === 'string' && newTemplate !== assignedTemplate) {
                        setAssignedTemplate(newTemplate);
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
                            } else if (item.type === 'HTMLEmbed') {
                                // Legacy/custom HTML block: emit its raw HTML verbatim so a legacy post's
                                // body round-trips into `content` unchanged (sanitized once on save,
                                // server-side). Editing the block updates the body via the same path.
                                html += props.html || '';
                            }
                        });
                        contentRef.current = html;
                    }
                }}
            />
            )}
        </div>
    );
}
