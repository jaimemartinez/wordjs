"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { useRouter, useParams } from "next/navigation";
import EditorBootFallback from "@/components/verso/editor/EditorBootFallback";
import { postsApi, categoriesApi, tagsApi, Category, Tag, PostTermRef } from "@/lib/api";
import EditorLoadError from "@/components/EditorLoadError";
import VersoEditor from "@/components/verso/editor/VersoEditor";
import { rootFieldsPost } from "@/lib/verso/coreBlocks";
import { serializeContentFallback } from "@/lib/verso/contentFallback";
import type { EditorHandle } from "@/lib/verso/store";
import type { VersoData } from "@/lib/verso/types";
import { unhydratedSaveBlocked, seedLegacyVersoData, applyLegacyHtmlFallback, resolveWjsTemplateForSave, isWithinPostMountGrace, EDITOR_DATA_META_KEY } from "@/lib/editorGuards";
// La forma persistida `{ content, root }` — el mismo tipo que exponía el fork, ahora propio.
import type { VersoData as Data } from "@/lib/verso/types";
import { buildStatusPatch, dbDateToLocalInput, defaultScheduleInput, isFutureInput } from "@/lib/editorSchedule";
// Campos ROOT de REGISTRO (imagen destacada / extracto / categoría): el editor los compone sobre los
// del registro de bloques — ver la cabecera de editorRootFields.ts.
import {
    withRecordRootFields,
    seedRootPropsFromPost,
    featuredImageMetaValue,
    resolveExcerptForSave,
    resolveCategoriesForSave,
    resolveTagsForSave,
    seedTaxonomyRootProps,
    seedSeoRootProps,
    seoMetaForSave,
    type TagSelection,
} from "@/lib/editorRootFields";
// El productor ÚNICO del estado de categorías del editor (opciones del select = lista contra la que
// resuelve el guardado). Vive fuera del componente para que un test pueda ejercerlo de verdad.
import { buildCategoryEditorState } from "./categoryEditorState";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";
import { useModal } from "@/contexts/ModalContext";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";

// Paginación de la carga de etiquetas: el backend tapa `per_page` a 100, y el tope de páginas evita
// que un sitio con miles de etiquetas dispare decenas de peticiones al abrir el editor. Las
// categorías tienen exactamente el mismo tope y se recorren igual, pero el bucle vive en
// `categoriesApi.listAll` porque lo comparten tres pantallas.
const TAG_PAGE_SIZE = 100;
const TAG_MAX_PAGES = 10;

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
    // Fecha del registro (`post_date`) como valor datetime-local. Se siembra SIEMPRE, no sólo en
    // 'future': un post que se programó y luego volvió a borrador conserva la fecha futura en la
    // columna, y esconderla dejaba al autor sin ver por qué "Publicar" le devolvía "Programado".
    const [scheduleDate, setScheduleDate] = useState("");
    // ¿La tocó el AUTOR en esta sesión? La siembra escribe el state directamente, así que sólo el
    // onChange del control pone esto a true. Sin esta distinción la fecha viajaría en cada guardado
    // (reescribiendo post_date sin que nadie lo pidiera) o no viajaría nunca (control inerte).
    const dateEditedRef = useRef(false);
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
    // Las categorías DEL REGISTRO abierto, TAL CUAL las manda la API (gemelo de recordTags): la lista
    // del sitio viene paginada, así que sin esto una categoría del post que caiga fuera de las páginas
    // cargadas no tendría opción en el select y el panel la enseñaría como si el post no tuviera
    // categoría. Se guarda el valor CRUDO y se normaliza en `buildCategoryEditorState`, que es el
    // único sitio donde se construyen las opciones (ver ./categoryEditorState).
    const [recordCategorySource, setRecordCategorySource] = useState<unknown>(null);
    // Etiquetas EXISTENTES del sitio (las opciones del control) y las del registro abierto (para que
    // ninguna etiqueta suya se quede sin opción si cae fuera de las páginas cargadas).
    const [allTags, setAllTags] = useState<Tag[]>([]);
    const [recordTags, setRecordTags] = useState<PostTermRef[]>([]);
    // Valores CONFIRMADOS por el servidor de los campos que solo viajan cuando cambian
    // (ver resolveExcerptForSave / resolveCategoriesForSave / resolveTagsForSave: `setTerms` REEMPLAZA,
    // y `toJSON` devuelve un extracto DERIVADO cuando no hay uno propio — mandarlos siempre
    // reescribiría la taxonomía en cada autosave y congelaría el resumen automático).
    const seededExcerptRef = useRef("");
    // TODOS los ids de categoría del registro: el select enseña el primero, y los demás se reenvían
    // en vez de perderse (ver resolveCategoriesForSave).
    const seededCategoryIdsRef = useRef<number[]>([]);
    const seededTagsRef = useRef<TagSelection[]>([]);
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
        loadTags();
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
            // La fecha del registro, SIEMPRE (no sólo programando) — ver el state de arriba.
            setScheduleDate(dbDateToLocalInput(post.dateGmt, post.date));
            dateEditedRef.current = false;
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
            // TAXONOMÍA: el REGISTRO manda, no `_puck_data`. `Post.toJSON` ya serializa `categories`
            // y `tags`, así que un post etiquetado por importación o por API abre con sus términos a
            // la vista en vez de aparecer vacío — que es lo que convertía cualquier guardado en un
            // borrado silencioso (`setTerms` REEMPLAZA).
            const taxonomy = seedTaxonomyRootProps(post);
            const seedRoot = {
                ...seedRootPropsFromPost(post),
                ...seedSeoRootProps(post),
                category: taxonomy.category,
                tags: taxonomy.tags,
                allowComments: post.commentStatus || "open",
            };
            seededExcerptRef.current = seedRoot.excerpt;
            seededCategoryIdsRef.current = taxonomy.categoryIds;
            seededTagsRef.current = taxonomy.tags;
            setRecordTags(taxonomy.tagRefs);
            setRecordCategorySource(post.categories);
            setRootCategory(taxonomy.category);

            // Load Puck data from meta if available
            if (post.meta && post.meta[EDITOR_DATA_META_KEY]) {
                const stored = post.meta[EDITOR_DATA_META_KEY];
                // OJO: `category`/`tags` NO se leen de aquí. Vienen en `seedRoot`, que se aplica
                // DESPUÉS y por tanto pisa lo que arrastre un `_puck_data` viejo.
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
                    // ya incluye allowComments, imagen destacada, extracto, SEO y taxonomía —
                    // `extraRootProps` se aplica DESPUÉS del `category: ""` que siembra el helper.
                    extraRootProps: seedRoot
                });
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

    // Las categorías del sitio, que son las OPCIONES del select. `listAll` recorre el pager acotado:
    // `GET /categories` tapa `per_page` a 100 y ordena por nombre, así que la lectura sin paginar de
    // antes sólo veía las 100 primeras — en un sitio importado eso significaba no poder asignar la
    // mayoría de categorías, y enseñar la del propio post como si no existiera.
    const loadCategories = async () => {
        try {
            const { data } = await categoriesApi.listAll();
            setCategories(data);
        } catch (error) {
            console.error("Failed to load categories:", error);
        }
    };

    // Las etiquetas del sitio, que son las OPCIONES del control (`Post.setTerms` resuelve por
    // term_id, y `PUT /posts/:id` no crea términos: sólo se puede asignar lo que ya existe). El
    // endpoint pagina y tapa `per_page` a 100, así que se recorren varias páginas — con tope, para
    // que una biblioteca enorme no convierta abrir el editor en una ráfaga de peticiones.
    const loadTags = async () => {
        try {
            const collected: Tag[] = [];
            let page = 1;
            let totalPages = 1;
            do {
                const res = await tagsApi.listPaged({ page, perPage: TAG_PAGE_SIZE, orderby: "name", order: "asc" });
                collected.push(...res.data);
                totalPages = res.totalPages;
                page += 1;
            } while (page <= totalPages && page <= TAG_MAX_PAGES);
            setAllTags(collected);
        } catch (error) {
            // Sin lista de etiquetas el control queda sin opciones nuevas, pero las del registro
            // siguen sembradas: el guardado nunca borra lo que el autor no llegó a ver.
            console.error("Failed to load tags:", error);
        }
    };

    // Las categorías ELEGIBLES = las del sitio ∪ las del registro. Una sola unión para el select y
    // para el guardado: si el guardado resolviera contra una lista más corta que la que se enseña,
    // una categoría visible en el panel sería "irresoluble" al guardar (y no se podría cambiar). Las
    // dos salidas vienen de UN productor (./categoryEditorState) para que no puedan divergir — antes
    // eran dos líneas sueltas y borrar cualquiera de ellas dejaba la suite en verde.
    const { recordCategories, categoryOptions } = useMemo(
        () => buildCategoryEditorState(recordCategorySource, categories),
        [recordCategorySource, categories],
    );

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
        // Al PROGRAMAR hace falta un instante FUTURO. Antes bastaba con que el campo no estuviese
        // vacío, pero ahora siempre lleva la fecha del registro, que en una entrada publicada es
        // pasada: mandarla como programación la publicaría al instante (resolveScheduledStatus).
        // (No marca `dateEditedRef`: la rama 'future' de buildStatusPatch manda la fecha por sí sola,
        // y así volver a "Borrador" sin guardar no deja una fecha por defecto viajando en el payload.)
        if (s === "future" && !isFutureInput(scheduleDate)) setScheduleDate(defaultScheduleInput());
    };
    const handleScheduleDateChange = (v: string) => {
        setScheduleDate(v);
        dateEditedRef.current = true; // único productor de "el autor tocó la fecha"
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
            const statusPatch = buildStatusPatch(status, scheduleDate, lastServerStatusRef.current, new Date(), {
                dateEdited: dateEditedRef.current,
            });
            if (!statusPatch) {
                if (!isAutosave) await alert(trStr("Elige fecha y hora para programar la publicación.", language));
                setSaving(false);
                return false;
            }

            // Campos de REGISTRO que viven en el root del lienzo. Extracto, categorías y etiquetas
            // viajan SOLO si el autor los cambió (fail-safe — ver editorRootFields: `setTerms`
            // REEMPLAZA, así que mandar la taxonomía sin necesidad la reescribe entera en cada
            // autosave); la imagen destacada viaja siempre, porque '' es la única forma de borrar una
            // asignación anterior.
            const rootProps = (root?.props ?? {}) as Record<string, unknown>;
            const excerptPatch = resolveExcerptForSave({
                current: rootProps.excerpt,
                seeded: seededExcerptRef.current,
            });
            const categoriesPatch = resolveCategoriesForSave({
                current: rootProps.category,
                seeded: seededCategoryIdsRef.current,
                categories: categoryOptions, // la MISMA unión que alimenta el select
            });
            const tagsPatch = resolveTagsForSave({
                current: rootProps.tags,
                seeded: seededTagsRef.current,
            });

            const postData = {
                title: finalTitle,
                slug: finalSlug,
                content: contentRef.current, // This content is now generated from Puck
                ...statusPatch,
                commentStatus,
                ...(excerptPatch !== undefined ? { excerpt: excerptPatch } : {}),
                ...(categoriesPatch !== undefined ? { categories: categoriesPatch } : {}),
                ...(tagsPatch !== undefined ? { tags: tagsPatch } : {}),
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
            }
            // La fecha que la BD confirma pasa a ser la que se enseña, y deja de contar como "editada"
            // (si no, cada autosave posterior seguiría reescribiendo post_date con el mismo valor).
            // Sólo si la respuesta TRAE fecha: una respuesta sin ella vaciaría el campo y volvería a
            // esconderlo, que es exactamente el fallo que este cambio quita.
            const confirmedDate = saved ? dbDateToLocalInput(saved.dateGmt, saved.date) : "";
            if (confirmedDate) {
                setScheduleDate(confirmedDate);
                dateEditedRef.current = false;
            }
            // Lo que ya viajó pasa a ser la base: sin esto cada autosave posterior reenviaría el
            // mismo extracto y las mismas categorías eternamente. Solo tras un guardado CONFIRMADO.
            if (excerptPatch !== undefined) seededExcerptRef.current = excerptPatch;
            if (categoriesPatch !== undefined) seededCategoryIdsRef.current = categoriesPatch;
            if (tagsPatch !== undefined) seededTagsRef.current = tagsPatch.map((id) => ({ tag: String(id) }));
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
        () => withRecordRootFields(rootFieldsPost, {
            categories,
            currentCategory: rootCategory,
            recordCategories,
            tags: allTags,
            recordTags,
        }),
        [categories, rootCategory, recordCategories, allTags, recordTags],
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
