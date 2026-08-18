"use client";

import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useRouter, useParams } from "next/navigation";
import EditorBootFallback, { EditorSkeleton } from "@/components/verso/editor/EditorBootFallback";
import { postsApi, settingsApi } from "@/lib/api";
import EditorLoadError from "@/components/EditorLoadError";
import VersoEditor from "@/components/verso/editor/VersoEditor";
import { rootFieldsPage } from "@/lib/verso/coreBlocks";
import { serializeContentFallback } from "@/lib/verso/contentFallback";
import type { EditorHandle } from "@/lib/verso/store";
import type { VersoData } from "@/lib/verso/types";
import { unhydratedSaveBlocked, seedLegacyVersoData, applyLegacyHtmlFallback, resolveWjsTemplateForSave, isWithinPostMountGrace, EDITOR_DATA_META_KEY } from "@/lib/editorGuards";
// La forma persistida `{ content, root }` — el mismo tipo que exponía el fork, ahora propio.
import type { VersoData as Data } from "@/lib/verso/types";
import { buildStatusPatch, dbDateToLocalInput, defaultScheduleInput } from "@/lib/editorSchedule";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";
import { useModal } from "@/contexts/ModalContext";
import { useI18n } from "@/contexts/I18nContext";
import { trStr } from "@/lib/editorI18n";
import { useAuth } from "@/contexts/AuthContext";

export default function PageEditorPage() {
    const { t, language } = useI18n();
    const router = useRouter();
    const params = useParams();
    const isNew = params.id === "new";
    const pageId = isNew ? null : Number(params.id);

    // Access gate: the page editor is for content managers. A subscriber (no edit_posts) can't save
    // anyway (POST/PUT /posts is capability-gated) but the editor UI still opened by direct URL — block
    // it and send them to their account page. (authLoading avoids a redirect before caps are known.)
    const { can, isLoading: authLoading } = useAuth();
    const allowedToEdit = can('edit_posts');
    useEffect(() => {
        if (!authLoading && !allowedToEdit) router.replace('/admin/account');
    }, [authLoading, allowedToEdit, router]);

    const [title, setTitle] = useState("");
    const [slug, setSlug] = useState("");
    // The serialized HTML body is REF, not state: it is regenerated on every canvas change (i.e. on
    // every keystroke) and is only ever read inside handleSubmit — never during render. As state it
    // re-rendered the whole editor on each letter typed.
    const contentRef = useRef("");
    const [initialVersoData, setInitialVersoData] = useState<Data | null>(null);
    const versoDataRef = useRef<Data>({ content: [], root: {} }); // For saving without causing re-renders
    const [status, setStatus] = useState("draft");
    // Programación: valor datetime-local del instante elegido (solo significativo con status 'future').
    const [scheduleDate, setScheduleDate] = useState("");
    // Último estado CONFIRMADO por el servidor — ver el editor de posts: "publicar ya" un registro
    // programado exige mandar date=now o el modelo re-programaría con la fecha futura almacenada.
    const lastServerStatusRef = useRef("draft");
    // The author's per-page theme-template pick (`_wjs_template` meta). State (not just a root prop
    // read at save time) because the canvas preview re-wraps on it live — VersoThemeTemplate reads the
    // pick straight from the store root, so the canvas follows the dropdown without a save.
    const [assignedTemplate, setAssignedTemplate] = useState("");
    const [saving, setSaving] = useState(false);
    const [isLoading, setIsLoading] = useState(!isNew);
    // Data-safety hydration tracking: `loaded` is true only once the EXISTING page's content has loaded;
    // `loadError` blocks the editor on failure. Saves are refused until hydrated so a blank editor can
    // never overwrite the real page. New pages have nothing to hydrate.
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

    // Set initial dirty state for new pages
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
            // Update versoDataRef for saving (no re-render)
            versoDataRef.current = {
                ...versoDataRef.current,
                root: {
                    ...(versoDataRef.current.root as any),
                    slug: generatedSlug,
                    props: {
                        ...((versoDataRef.current.root as any)?.props || {}),
                        slug: generatedSlug
                    }
                }
            };
            setLastSyncedTitle(title);
        }
    }, [title, slugManuallyEdited, lastSyncedTitle]);
    const [, setActiveTheme] = useState("default");

    useEffect(() => {
        // Load settings to get active theme
        settingsApi.get().then((settings: any) => {
            if (settings.theme) {
                setActiveTheme(settings.theme);
            }
        });

        if (pageId) {
            loadPage();
        }
    }, [pageId]);

    const loadPage = async () => {
        setLoadError(null);
        setLoaded(false); // never carry a previous record's hydrated state into a new load / retry
        setIsLoading(true);
        try {
            const page = await postsApi.get(pageId!);
            setTitle(page.title);
            setSlug(page.slug);
            contentRef.current = page.content;
            setStatus(page.status);
            lastServerStatusRef.current = page.status;
            if (page.status === "future") setScheduleDate(dbDateToLocalInput(page.dateGmt, page.date));
            // The saved template assignment. META is the source of truth (it may have been set via the
            // API, or before this field existed), so it is injected into root.props below rather than
            // trusting whatever a stale _puck_data carries.
            const savedTemplate = typeof page.meta?._wjs_template === "string" ? page.meta._wjs_template : "";
            setAssignedTemplate(savedTemplate);

            // Load Puck data from meta if available
            if (page.meta && page.meta[EDITOR_DATA_META_KEY]) {
                const stored = page.meta[EDITOR_DATA_META_KEY];
                const withTemplate = {
                    ...stored,
                    root: {
                        ...(stored.root as any),
                        props: { ...((stored.root as any)?.props || {}), _wjs_template: savedTemplate }
                    }
                };
                setInitialVersoData(withTemplate);
                versoDataRef.current = withTemplate;
                legacyHtmlRef.current = null; // real Puck blocks — not a legacy HTML body
                if (stored.root?.title) {
                    setTitle(stored.root.title);
                }
            } else {
                // Seed Puck data with existing info for legacy pages. A legacy/imported page keeps its
                // body as HTML in `content` with no _puck_data. Wrap that HTML in an HTMLEmbed block so it
                // is VISIBLE and editable in the canvas instead of opening blank. The block renders the
                // HTML sanitized (see versoConfig HTMLEmbed); the onChange serializer round-trips props.html
                // back into `content`, so the body is preserved (and updated when edited).
                const { data: seededData, legacyHtml } = seedLegacyVersoData({
                    html: page.content || "",
                    title: page.title,
                    slug: page.slug,
                    recordId: pageId as number,
                    wjsTemplate: savedTemplate
                });
                setInitialVersoData(seededData as any);
                versoDataRef.current = seededData as any;
                // Safety net (belt-and-braces): keep the original body so an empty-canvas save can't blank
                // the page if the HTMLEmbed block is deleted before its HTML round-trips. Once the block
                // round-trips through onChange (content.length > 0), legacyHtmlRef is cleared.
                legacyHtmlRef.current = legacyHtml;
            }
            setLoaded(true); // content is now hydrated — saving is safe
        } catch (error) {
            console.error("Failed to load page:", error);
            setLoadError(error); // block the editor so a blank stand-in can't overwrite the real page
        } finally {
            setIsLoading(false);
        }
    };

    const { alert } = useModal();

    // Once a NEW page is first saved, remember its id — before this, every save created ANOTHER
    // page (params.id stays "new"). Also lets autosave create the draft once and then update it.
    const createdIdRef = useRef<number | null>(null);
    // Holds a legacy page's original HTML body while its Puck canvas is still empty (see loadPage).
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

        // DATA-SAFETY: never write an existing page whose content hasn't hydrated — a blank/failed-load
        // editor must not overwrite the real body (autosave especially, which skips the revision snapshot).
        if (unhydratedSaveBlocked({ isNew, loaded })) {
            if (!isAutosave) await alert(trStr("No se pudo cargar el contenido; el guardado está deshabilitado para no sobrescribir la página.", language));
            setSaving(false);
            return false;
        }

        try {
            // Flush any open inline editor (so its latest keystrokes land in the store), then read the
            // LIVE store rather than the mirrored ref — el mirror puede quedarse stale y persistiría
            // contenido pre-edición ("los cambios no se guardan").
            try {
                versoHandleRef.current?.commitInline();
            } catch { /* no open editor */ }
            const liveData = (versoHandleRef.current?.getData() as any) ?? versoDataRef.current;
            const root = liveData.root as any;
            const finalTitle = root?.props?.title || root?.title || title;
            const finalSlug = root?.props?.slug || root?.slug || slug;

            if (!finalTitle) {
                // A background save must never pop a modal — just wait for a title.
                if (!isAutosave) await alert(t('page.edit.titleRequired'));
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

            const pageData = {
                title: finalTitle,
                slug: finalSlug,
                content: contentRef.current,
                ...statusPatch,
                type: "page",
                meta: {
                    // Clave histórica CONGELADA a propósito — ver EDITOR_DATA_META_KEY.
                    [EDITOR_DATA_META_KEY]: liveData,
                    // Per-page theme template. Always sent (backend merges meta per key): '' explicitly
                    // CLEARS a previous assignment — omitting the key would leave it stale forever.
                    _wjs_template: resolveWjsTemplateForSave(root?.props)
                },
                // Autosaves skip the revision snapshot server-side (see routes/posts.ts).
                ...(isAutosave ? { autosave: true } : {})
            };

            // Legacy body preservation: a legacy page still on a blank canvas must not be blanked — keep
            // its original HTML and don't stamp empty Puck data over it (which would orphan the body).
            const finalPageData = applyLegacyHtmlFallback(pageData, liveData.content?.length ?? 0, legacyHtmlRef.current);

            const effectiveId = pageId ?? createdIdRef.current;
            let saved;
            if (effectiveId) {
                saved = await postsApi.update(effectiveId, finalPageData as any);
            } else {
                saved = await postsApi.create(finalPageData as any);
                if (saved?.id) {
                    createdIdRef.current = saved.id;
                    // Keep the URL honest without remounting the editor mid-session.
                    window.history.replaceState(null, "", `/admin/pages/${saved.id}`);
                }
            }
            // El backend es la autoridad del estado final (resuelve publish→future o future→publish
            // según la fecha): reflejarlo para que el selector nunca mienta tras guardar.
            if (saved?.status) {
                lastServerStatusRef.current = saved.status;
                setStatus(saved.status);
                if (saved.status === "future") setScheduleDate(dbDateToLocalInput(saved.dateGmt, saved.date));
            }
            // Stay in editor - no redirect
            setIsDirty(false); // Reset dirty state after successful save
            return true;
        } catch (error: any) {
            console.error("Failed to save page:", error);
            if (!isAutosave) {
                await alert(`${t('page.edit.saveFailed')}: ${error.message || t('page.edit.unknownError')}`);
            }
            return false;
        } finally {
            setSaving(false);
        }
    };

    // Never mount the editor for a user without edit rights (redirect to /admin/account is in flight).
    if (!allowedToEdit) {
        return <EditorSkeleton />;
    }

    if (isLoading) {
        return <EditorBootFallback />;
    }

    // Load failed → show a blocking error (with retry) instead of an empty, savable editor that would
    // silently overwrite the real page on the next save/autosave.
    if (loadError) {
        return <EditorLoadError onRetry={loadPage} onBack={() => router.back()} />;
    }

    return (
        <div className="h-full w-full overflow-hidden flex flex-col">
                {/* MOTOR VERSO — el único. Carga/seeding ya hechos arriba (loadPage/seedLegacyVersoData),
                   handleSubmit lee el doc vivo vía versoHandleRef, root fields de PAGE (asimetría del
                   CMS), y el onChange serializa el fallback HTML COMPLETO compartido
                   (lib/verso/contentFallback). */}
                <VersoEditor
                    initialData={(initialVersoData || { content: [], root: {} }) as unknown as VersoData}
                    status={status}
                    onStatusChange={handleStatusChange}
                    scheduleDate={scheduleDate}
                    onScheduleDateChange={handleScheduleDateChange}
                    saving={saving}
                    hasChanges={isDirty}
                    onSave={handleSubmit as any}
                    onCancel={() => router.back()}
                    pageId={pageId || undefined}
                    previewSlug={slug || undefined}
                    rootFields={rootFieldsPage}
                    // W30: el canvas envuelve en la plantilla `page` del tema (el pick _wjs_template
                    // lo lee VersoThemeTemplate EN VIVO del root del store — sin prop).
                    templateKind="page"
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
                        const newTemplate = root?.props?._wjs_template;
                        if (typeof newTemplate === 'string' && newTemplate !== assignedTemplate) {
                            setAssignedTemplate(newTemplate);
                        }
                        // Fallback HTML desde bloques — EXCEPTO una página legacy aún en lienzo vacío
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

const IframePreview = ({ children, theme }: { children: React.ReactNode, theme: string }) => {
    const { t } = useI18n();
    const [mountNode, setMountNode] = useState<HTMLElement | null>(null);
    const iframeRef = useRef<HTMLIFrameElement>(null);

    useEffect(() => {
        const iframe = iframeRef.current;
        if (!iframe) return;

        const doc = iframe.contentDocument;
        if (!doc) return;

        const setup = () => {
            doc.head.innerHTML = '';

            // 1. Copy styles from parent
            const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'));
            styles.forEach(style => {
                if (style instanceof HTMLLinkElement && style.href.includes('/themes/')) return;
                doc.head.appendChild(style.cloneNode(true));
            });

            // 2. Add Theme Styles
            const themeLink = doc.createElement('link');
            themeLink.rel = 'stylesheet';
            themeLink.href = `${window.location.origin}/themes/${theme}/style.css`;
            doc.head.appendChild(themeLink);

            // 3. Add Fonts
            const fontsLink = doc.createElement('link');
            fontsLink.href = "https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;700&family=Roboto:wght@300;400;700&display=swap";
            fontsLink.rel = "stylesheet";
            doc.head.appendChild(fontsLink);

            // 4. Add FontAwesome
            const faLink = doc.createElement('link');
            faLink.rel = 'stylesheet';
            faLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
            doc.head.appendChild(faLink);

            doc.body.innerHTML = '<div id="root"></div>';
            doc.body.className = "bg-white";

            setMountNode(doc.getElementById('root'));
        };

        if (doc.readyState === 'complete') {
            setup();
        } else {
            iframe.onload = setup;
        }
    }, [theme]);

    return (
        <iframe
            ref={iframeRef}
            className="w-full h-full border-none bg-white"
            title={t('page.edit.previewTitle')}
        >
            {mountNode && createPortal(children, mountNode)}
        </iframe>
    );
};
