"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { useRouter, useParams } from "next/navigation";
import { postsApi, settingsApi } from "@/lib/api";
import { pageConfig } from "@/components/puckConfig";
import { useRuntimePuckConfig } from "@/lib/useRuntimePuckConfig";
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
    const [initialPuckData, setInitialPuckData] = useState<Data | null>(null);
    const puckDataRef = useRef<Data>({ content: [], root: {} }); // For saving without causing re-renders
    const [status, setStatus] = useState("draft");
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
            // Update puckDataRef for saving (no re-render)
            puckDataRef.current = {
                ...puckDataRef.current,
                root: {
                    ...(puckDataRef.current.root as any),
                    slug: generatedSlug,
                    props: {
                        ...((puckDataRef.current.root as any)?.props || {}),
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

            // Load Puck data from meta if available
            if (page.meta && page.meta._puck_data) {
                setInitialPuckData(page.meta._puck_data);
                puckDataRef.current = page.meta._puck_data;
                legacyHtmlRef.current = null; // real Puck blocks — not a legacy HTML body
                if (page.meta._puck_data.root?.title) {
                    setTitle(page.meta._puck_data.root.title);
                }
            } else {
                // Seed Puck data with existing info for legacy pages. A legacy/imported page keeps its
                // body as HTML in `content` with no _puck_data. Wrap that HTML in an HTMLEmbed block so it
                // is VISIBLE and editable in the canvas instead of opening blank. The block renders the
                // HTML sanitized (see puckConfig HTMLEmbed); the onChange serializer round-trips props.html
                // back into `content`, so the body is preserved (and updated when edited).
                const legacyHtml = page.content || "";
                const seededData: any = {
                    content: legacyHtml
                        ? [{ type: "HTMLEmbed", props: { id: `HTMLEmbed-legacy-${pageId}`, html: legacyHtml } }]
                        : [],
                    root: {
                        title: page.title,
                        slug: page.slug,
                        props: {
                            title: page.title,
                            slug: page.slug,
                            category: ""
                        }
                    }
                };
                setInitialPuckData(seededData);
                puckDataRef.current = seededData;
                // Safety net (belt-and-braces): keep the original body so an empty-canvas save can't blank
                // the page if the HTMLEmbed block is deleted before its HTML round-trips. Once the block
                // round-trips through onChange (content.length > 0), legacyHtmlRef is cleared.
                legacyHtmlRef.current = legacyHtml || null;
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
            // Flush any open inline editor (so its latest keystrokes land in Puck's store), then read
            // the LIVE store rather than the mirrored ref — Puck's onChange has a deep-equal guard that
            // can leave puckDataRef stale, which would persist pre-edit content ("changes don't save").
            try { (window as any).puckCommitActive?.(); } catch { /* no open editor */ }
            const liveData = ((window as any).puckGetData?.() ?? puckDataRef.current);
            const root = liveData.root as any;
            const finalTitle = root?.props?.title || root?.title || title;
            const finalSlug = root?.props?.slug || root?.slug || slug;

            if (!finalTitle) {
                // A background save must never pop a modal — just wait for a title.
                if (!isAutosave) await alert(t('page.edit.titleRequired'));
                setSaving(false);
                return false;
            }

            const pageData = {
                title: finalTitle,
                slug: finalSlug,
                content: contentRef.current,
                status,
                type: "page",
                meta: {
                    _puck_data: liveData
                },
                // Autosaves skip the revision snapshot server-side (see routes/posts.ts).
                ...(isAutosave ? { autosave: true } : {})
            };

            // Legacy body preservation: a legacy page still on a blank canvas must not be blanked — keep
            // its original HTML and don't stamp empty Puck data over it (which would orphan the body).
            if (!(liveData.content && liveData.content.length) && legacyHtmlRef.current) {
                pageData.content = legacyHtmlRef.current;
                delete (pageData.meta as any)._puck_data;
            }

            const effectiveId = pageId ?? createdIdRef.current;
            if (effectiveId) {
                await postsApi.update(effectiveId, pageData as any);
            } else {
                const created = await postsApi.create(pageData as any);
                if (created?.id) {
                    createdIdRef.current = created.id;
                    // Keep the URL honest without remounting the editor mid-session.
                    window.history.replaceState(null, "", `/admin/pages/${created.id}`);
                }
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

    const localizedConfig = useMemo(() => localizeConfig(pageConfig, language), [language]);
    // Add active marketplace plugins' Puck blocks to the editor palette/canvas at runtime.
    const runtimeConfig = useRuntimePuckConfig(localizedConfig);

    // Never mount the editor for a user without edit rights (redirect to /admin/account is in flight).
    if (!allowedToEdit) {
        return <PuckEditorSkeleton />;
    }

    if (isLoading) {
        return <PuckEditorSkeleton />;
    }

    // Load failed → show a blocking error (with retry) instead of an empty, savable editor that would
    // silently overwrite the real page on the next save/autosave.
    if (loadError) {
        return <EditorLoadError onRetry={loadPage} onBack={() => router.back()} />;
    }

    return (
        <div className="h-full w-full overflow-hidden flex flex-col">
            <PuckEditor
                config={runtimeConfig}
                initialData={initialPuckData || { content: [], root: {} }}
                status={status}
                onStatusChange={setStatus}
                saving={saving}
                hasChanges={isDirty}
                onSave={handleSubmit as any}
                onCancel={() => router.back()}
                pageId={pageId || undefined}
                previewSlug={slug || undefined}
                // OLA 3: preview the page inside the theme's `page` template (page-<slug> → page).
                templateKind="page"
                onChange={(data) => {
                    // Ignore init-time events only (see mountedAtRef note above).
                    if (Date.now() - mountedAtRef.current > 800) {
                        setIsDirty(true);
                    }

                    // Store in ref for saving (no re-render)
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
                    // Regenerate fallback HTML from blocks — EXCEPT a legacy page still on a blank canvas
                    // (its body is HTML in `content`, not blocks): don't clobber it to "".
                    if (data.content.length > 0) legacyHtmlRef.current = null;
                    if (!(data.content.length === 0 && legacyHtmlRef.current)) {
                    let html = "";
                    data.content.forEach((item: any) => {
                        const props = item.props;
                        if (item.type === 'Heading') {
                            html += `<${props.level} class="wp-block-heading font-bold my-4">${props.title}</${props.level}>`;
                        } else if (item.type === 'Text') {
                            html += `<div class="wp-block-text prose">${props.content}</div>`;
                        } else if (item.type === 'Image') {
                            html += `<img src="${props.src}" alt="${props.alt}" class="wp-block-image max-w-full my-4 rounded shadow-sm"/>`;
                        } else if (item.type === 'Button') {
                            const alignClass = props.align === 'center' ? 'text-center' : props.align === 'right' ? 'text-right' : 'text-left';
                            html += `<div class="wp-block-button my-6 ${alignClass}"><a href="${props.href}" class="wp-button button-${props.variant}">${props.label}</a></div>`;
                        } else if (item.type === 'Card') {
                            html += `
                                <div class="wp-block-card card-theme-${props.theme} p-8 rounded-3xl border my-6">
                                    ${props.icon ? `<i class="fa-solid ${props.icon} text-2xl mb-4"></i>` : ''}
                                    <h3 class="text-xl font-bold mb-2">${props.title}</h3>
                                    <p class="opacity-80">${props.description}</p>
                                </div>`;
                        } else if (item.type === 'Divider') {
                            html += `<hr class="wp-block-divider divider-${props.type} my-10 border-gray-100" />`;
                        } else if (item.type === 'HTMLEmbed') {
                            // Legacy/custom HTML block: emit its raw HTML verbatim so a legacy page's body
                            // round-trips into `content` unchanged (sanitized once on save, server-side).
                            // Editing the block updates the body via the same path.
                            html += props.html || '';
                        }
                    });
                    contentRef.current = html;
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
