"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { useRouter, useParams } from "next/navigation";
import EditorBootFallback from "@/components/verso/editor/EditorBootFallback";
import { postsApi, categoriesApi, Category } from "@/lib/api";
import EditorLoadError from "@/components/EditorLoadError";
import VersoEditor from "@/components/verso/editor/VersoEditor";
import { rootFieldsPost } from "@/lib/verso/coreBlocks";
import { serializeContentFallback } from "@/lib/verso/contentFallback";
import type { EditorHandle } from "@/lib/verso/store";
import type { VersoData } from "@/lib/verso/types";
import { unhydratedSaveBlocked, seedLegacyVersoData, applyLegacyHtmlFallback, resolveWjsTemplateForSave, isWithinPostMountGrace, EDITOR_DATA_META_KEY } from "@/lib/editorGuards";
// La forma persistida `{ content, root }` — el mismo tipo que exponía el fork, ahora propio.
import type { VersoData as Data } from "@/lib/verso/types";
import { buildStatusPatch, dbDateToLocalInput, defaultScheduleInput } from "@/lib/editorSchedule";
// Campos ROOT de REGISTRO (imagen destacada / extracto / categoría): el editor los compone sobre los
// del registro de bloques — ver la cabecera de editorRootFields.ts.
import {
    withRecordRootFields,
    seedRootPropsFromPost,
    featuredImageMetaValue,
    resolveExcerptForSave,
    resolveCategoriesForSave,
    seedSeoRootProps,
    seoMetaForSave,
} from "@/lib/editorRootFields";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";
import { useModal } from "@/contexts/ModalContext";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";

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
    // Store Puck data. `versoData` seeds the canvas ONCE (initialData); the live mirror used at save
    // time is the ref, updated in onChange — writing state there re-rendered the editor per keystroke.
    const [versoData, setVersoData] = useState<Data>({ content: [], root: {} });
    const versoDataRef = useRef<Data>({ content: [], root: {} });
    const [status, setStatus] = useState("draft");
    // Programación: valor datetime-local del instante elegido (solo significativo con status 'future').
    const [scheduleDate, setScheduleDate] = useState("");
    // Último estado CONFIRMADO por el servidor. Distingue "publicar ya" sobre un post programado (hay
    // que mandar date=now, o el modelo re-evaluaría la fecha futura ALMACENADA y re-programaría) de un
    // publish normal, que no debe tocar post_date.
    const lastServerStatusRef = useRef("draft");
    const [commentStatus, setCommentStatus] = useState("open");
    // The author's per-page theme-template pick (`_wjs_template` meta). State (not just a root prop
    // read at save time) because the canvas preview re-wraps on it live — VersoThemeTemplate reads the
    // pick straight from the store root, so the canvas follows the dropdown without a save.
    const [assignedTemplate, setAssignedTemplate] = useState("");
    const [categories, setCategories] = useState<Category[]>([]);
    // Espejo de la categoría elegida en el root (state, no solo ref): el select se reconstruye con
    // ella para poder SINTETIZAR la opción de un valor que no case con ninguna categoría viva (el
    // NOMBRE que guardaba el control viejo) en vez de enseñar el campo vacío.
    const [rootCategory, setRootCategory] = useState("");
    // Valores CONFIRMADOS por el servidor de los dos campos que solo viajan cuando cambian
    // (ver resolveExcerptForSave / resolveCategoriesForSave: la API no devuelve los términos de un
    // post, y devuelve un extracto DERIVADO cuando no hay uno propio — mandarlos siempre destruiría
    // términos puestos por importación y congelaría el resumen automático).
    const seededExcerptRef = useRef("");
    const seededCategoryRef = useRef("");
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

    // Handle vivo del motor: el guardado lee getData() de aquí — el documento REAL del store, sin
    // mirrors.
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
            // Also update versoData to keep sidebar in sync
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
            setVersoData(withSlug);
            versoDataRef.current = withSlug(versoDataRef.current);
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
            lastServerStatusRef.current = post.status;
            if (post.status === "future") setScheduleDate(dbDateToLocalInput(post.dateGmt, post.date));
            setCommentStatus(post.commentStatus || "open");
            // The saved template assignment. META is the source of truth (it may have been set via the
            // API, or before this field existed), so it is injected into root.props below rather than
            // trusting whatever a stale _puck_data carries.
            const savedTemplate = typeof post.meta?._wjs_template === "string" ? post.meta._wjs_template : "";
            setAssignedTemplate(savedTemplate);

            // Imagen destacada y extracto: la BD manda sobre lo que traiga _puck_data (pudieron
            // cambiarse por la API o antes de que estos campos existieran), igual que _wjs_template.
            // SEO: la META manda igual que _wjs_template. Sin esta siembra, un registro cuyo SEO se
            // puso por la API/importación llegaba con root.props vacío y el primer guardado lo
            // BORRABA (el body manda los cuatro campos siempre) — y hoy eso cambia el <title> real y
            // puede re-listar en el sitemap una página ocultada a propósito.
            // `allowComments` va en el mismo saco: el onChange lo copia a commentStatus, así que un
            // _puck_data con un valor viejo pisaba la columna real en cuanto se tocaba el lienzo.
            const seedRoot = {
                ...seedRootPropsFromPost(post),
                ...seedSeoRootProps(post),
                allowComments: post.commentStatus || "open",
            };
            seededExcerptRef.current = seedRoot.excerpt;

            // Load Puck data from meta if available
            if (post.meta && post.meta[EDITOR_DATA_META_KEY]) {
                const stored = post.meta[EDITOR_DATA_META_KEY];
                const storedCategory = String((stored.root as any)?.props?.category ?? "");
                seededCategoryRef.current = storedCategory;
                setRootCategory(storedCategory);
                const withTemplate = {
                    ...stored,
                    root: {
                        ...(stored.root as any),
                        props: { ...((stored.root as any)?.props || {}), _wjs_template: savedTemplate, ...seedRoot }
                    }
                };
                setVersoData(withTemplate);
                versoDataRef.current = withTemplate;
                legacyHtmlRef.current = null; // real Puck blocks — not a legacy HTML body
                if (stored.root?.title) {
                    setTitle(stored.root.title);
                }
            } else {
                // Seed Puck data with existing info for legacy posts. A legacy/imported post keeps its
                // body as HTML in `content` with no _puck_data. Wrap that HTML in an HTMLEmbed block so it
                // is VISIBLE and editable in the canvas instead of opening blank. The block renders the
                // HTML sanitized (see versoConfig HTMLEmbed); the onChange serializer round-trips props.html
                // back into `content`, so the body is preserved (and updated when edited).
                const { data: seededData, legacyHtml } = seedLegacyVersoData({
                    html: post.content || "",
                    title: post.title,
                    slug: post.slug,
                    recordId: postId as number,
                    wjsTemplate: savedTemplate,
                    extraRootProps: seedRoot // ya incluye allowComments, imagen destacada, extracto y SEO
                });
                // seedLegacyVersoData siembra `category: ""` — el registro no trae ninguna elección.
                seededCategoryRef.current = "";
                setRootCategory("");
                setVersoData(seededData as any);
                versoDataRef.current = seededData as any;
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

    // Cambiar estado o fecha programada marca dirty por sí solo — programar/despublicar no exige
    // tocar el lienzo, y el botón Guardar se deshabilita sin cambios.
    const handleStatusChange = (s: string) => {
        setStatus(s);
        setIsDirty(true);
        if (s === "future" && !scheduleDate) setScheduleDate(defaultScheduleInput());
    };
    const handleScheduleDateChange = (v: string) => {
        setScheduleDate(v);
        setIsDirty(true);
    };

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
            // Flush any open inline editor and read the LIVE store (same hardening as the page
            // editor): el mirror puede quedarse stale y persistiría contenido pre-edición.
            try {
                versoHandleRef.current?.commitInline();
            } catch { /* no open editor */ }
            const liveData = (versoHandleRef.current?.getData() as any) ?? versoDataRef.current;
            const root = liveData.root as any;
            const finalTitle = root?.props?.title || root?.title || title;
            const finalSlug = root?.props?.slug || root?.slug || slug;

            if (!finalTitle) {
                // A background save must never pop a modal — just wait for a title.
                if (!isAutosave) await alert(t('post.edit.titleRequired'));
                setSaving(false);
                return false;
            }

            // Estado + fecha: 'future' viaja como publish+date (el backend lo almacena como 'future'
            // y arma el cron del flip); null = programar sin fecha válida → bloquear el guardado.
            const statusPatch = buildStatusPatch(status, scheduleDate, lastServerStatusRef.current);
            if (!statusPatch) {
                if (!isAutosave) await alert(trStr("Elige fecha y hora para programar la publicación.", language));
                setSaving(false);
                return false;
            }

            // Campos de REGISTRO que viven en el root del lienzo. Extracto y categorías viajan SOLO
            // si el autor los cambió (fail-closed — ver editorRootFields); la imagen destacada viaja
            // siempre, porque '' es la única forma de borrar una asignación anterior.
            const rootProps = (root?.props ?? {}) as Record<string, unknown>;
            const excerptPatch = resolveExcerptForSave({
                current: rootProps.excerpt,
                seeded: seededExcerptRef.current,
            });
            const categoriesPatch = resolveCategoriesForSave({
                current: rootProps.category,
                seeded: seededCategoryRef.current,
                categories,
            });

            const postData = {
                title: finalTitle,
                slug: finalSlug,
                content: contentRef.current, // This content is now generated from Puck
                ...statusPatch,
                commentStatus,
                ...(excerptPatch !== undefined ? { excerpt: excerptPatch } : {}),
                ...(categoriesPatch !== undefined ? { categories: categoriesPatch } : {}),
                meta: {
                    // Clave histórica CONGELADA a propósito — ver EDITOR_DATA_META_KEY.
                    [EDITOR_DATA_META_KEY]: liveData, // Save the JSON structure for re-editing
                    // Per-page theme template. Always sent (backend merges meta per key): '' explicitly
                    // CLEARS a previous assignment — omitting the key would leave it stale forever.
                    _wjs_template: resolveWjsTemplateForSave(root?.props),
                    // Imagen destacada (Post.getFeaturedImage la resuelve desde aquí). Siempre
                    // presente: '' BORRA la asignación anterior, omitirla la dejaría fija.
                    _thumbnail_id: featuredImageMetaValue(rootProps),
                    // SEO (título/descripción/imagen social/noindex). Una sola fuente para entradas y
                    // páginas — ver editorRootFields.seoMetaForSave.
                    ...seoMetaForSave(rootProps)
                },
                // Autosaves skip the revision snapshot server-side (see routes/posts.ts).
                ...(isAutosave ? { autosave: true } : {})
            };

            // Legacy body preservation: a legacy post still on a blank canvas must not be blanked — keep
            // its original HTML and don't stamp empty Puck data over it (which would orphan the body).
            const finalPostData = applyLegacyHtmlFallback(postData, liveData.content?.length ?? 0, legacyHtmlRef.current);

            const effectiveId = postId ?? createdIdRef.current;
            let saved;
            if (effectiveId) {
                saved = await postsApi.update(effectiveId, finalPostData as any);
            } else {
                saved = await postsApi.create({ ...finalPostData, type: "post" } as any);
                if (saved?.id) {
                    createdIdRef.current = saved.id;
                    // Keep the URL honest without remounting the editor mid-session.
                    window.history.replaceState(null, "", `/admin/posts/${saved.id}`);
                }
            }
            // El backend es la autoridad del estado final (resuelve publish→future o future→publish
            // según la fecha): reflejarlo para que el selector nunca mienta tras guardar.
            if (saved?.status) {
                lastServerStatusRef.current = saved.status;
                setStatus(saved.status);
                if (saved.status === "future") setScheduleDate(dbDateToLocalInput(saved.dateGmt, saved.date));
            }
            // Lo que ya viajó pasa a ser la base: sin esto cada autosave posterior reenviaría el
            // mismo extracto y las mismas categorías eternamente. Solo tras un guardado CONFIRMADO.
            if (excerptPatch !== undefined) seededExcerptRef.current = excerptPatch;
            if (categoriesPatch !== undefined) seededCategoryRef.current = String(rootProps.category ?? "");
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

    // Campos ROOT del inspector: los del registro MÁS imagen destacada/extracto, y la categoría
    // sustituida por el select por ID (que es lo que Post.setTerms espera). Memorizado para no
    // reconstruir el objeto en cada pulsación.
    const rootFields = useMemo(
        () => withRecordRootFields(rootFieldsPost, { categories, currentCategory: rootCategory }),
        [categories, rootCategory],
    );

    if (isLoading) {
        return <EditorBootFallback />;
    }

    // Load failed → show a blocking error (with retry) instead of an empty, savable editor that would
    // silently overwrite the real post on the next save/autosave.
    if (loadError) {
        return <EditorLoadError onRetry={loadPost} onBack={() => router.back()} />;
    }

    return (
        <div className="h-full w-full overflow-hidden flex flex-col">
                {/* MOTOR VERSO — el único. Carga/seeding ya hechos arriba (loadPost/seedLegacyVersoData),
                   handleSubmit lee el doc vivo vía versoHandleRef, root fields de POST (SEO/
                   categoría/comentarios — la asimetría del CMS, W41), y el fallback HTML usa el
                   módulo COMPARTIDO con el switch COMPLETO de pages: la divergencia W47 (posts solo
                   serializaba 4 tipos, sin clases wp-block-*) era drift accidental y se resolvió
                   hacia el lado completo — decisión ratificada del encargo F3. */}
                <VersoEditor
                    initialData={versoData as unknown as VersoData}
                    status={status}
                    onStatusChange={handleStatusChange}
                    scheduleDate={scheduleDate}
                    onScheduleDateChange={handleScheduleDateChange}
                    saving={saving}
                    hasChanges={isDirty}
                    onSave={handleSubmit as any}
                    onCancel={() => router.back()}
                    breadcrumbRoot="Entradas"
                    pageId={postId || undefined}
                    previewSlug={slug || undefined}
                    rootFields={rootFields}
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
                        versoDataRef.current = data as unknown as Data;
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
                        // Espejo de la categoría: alimenta la opción sintetizada del select.
                        const newCategory = String(root?.props?.category ?? "");
                        if (newCategory !== rootCategory) {
                            setRootCategory(newCategory);
                        }
                        // Fallback HTML desde bloques — EXCEPTO un post legacy aún en lienzo vacío
                        // (su cuerpo vive como HTML en `content`): no machacarlo a "".
                        if (data.content.length > 0) legacyHtmlRef.current = null;
                        if (!(data.content.length === 0 && legacyHtmlRef.current)) {
                            contentRef.current = serializeContentFallback(data.content);
                        }
                    }}
                />
        </div>
    );
}
