"use client";

import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useRouter, useParams } from "next/navigation";
import { postsApi, Post, settingsApi } from "@/lib/api";
import { pageConfig } from "@/components/puckConfig";
import PuckEditor from "@/components/PuckEditor";
import { Data } from "@measured/puck";
import { useUnsavedChanges } from "@/contexts/UnsavedChangesContext";
import Header from "@/components/public/Header";
import Footer from "@/components/public/Footer";
import { useModal } from "@/contexts/ModalContext";

export default function PageEditorPage() {
    const router = useRouter();
    const params = useParams();
    const isNew = params.id === "new";
    const pageId = isNew ? null : Number(params.id);

    const [title, setTitle] = useState("");
    const [slug, setSlug] = useState("");
    const [content, setContent] = useState("");
    const [initialPuckData, setInitialPuckData] = useState<Data | null>(null);
    const puckDataRef = useRef<Data>({ content: [], root: {} }); // For saving without causing re-renders
    const [status, setStatus] = useState("draft");
    const [saving, setSaving] = useState(false);
    const [isLoading, setIsLoading] = useState(!isNew);
    const [lastSyncedTitle, setLastSyncedTitle] = useState("");
    const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
    const { isDirty, setIsDirty } = useUnsavedChanges();
    const changesCount = useRef(0);

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
    const [activeTheme, setActiveTheme] = useState("default");

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
        try {
            const page = await postsApi.get(pageId!);
            setTitle(page.title);
            setSlug(page.slug);
            setContent(page.content);
            setStatus(page.status);

            // Load Puck data from meta if available
            if (page.meta && page.meta._puck_data) {
                setInitialPuckData(page.meta._puck_data);
                puckDataRef.current = page.meta._puck_data;
                if (page.meta._puck_data.root?.title) {
                    setTitle(page.meta._puck_data.root.title);
                }
            } else {
                // Seed Puck data with existing info for legacy pages
                const seededData: any = {
                    content: [],
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
            }
        } catch (error) {
            console.error("Failed to load page:", error);
        } finally {
            setIsLoading(false);
        }
    };

    const { alert } = useModal();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);

        try {
            const root = puckDataRef.current.root as any;
            const finalTitle = root?.props?.title || root?.title || title;
            const finalSlug = root?.props?.slug || root?.slug || slug;

            if (!finalTitle) {
                await alert("Title is required before saving.");
                setSaving(false);
                return;
            }

            const pageData = {
                title: finalTitle,
                slug: finalSlug,
                content,
                status,
                type: "page",
                meta: {
                    _puck_data: puckDataRef.current
                }
            };

            if (pageId) {
                await postsApi.update(pageId, pageData);
            } else {
                await postsApi.create(pageData);
            }
            // Stay in editor - no redirect
            setIsDirty(false); // Reset dirty state after successful save
        } catch (error: any) {
            console.error("Failed to save page:", error);
            await alert(`Failed to save page: ${error.message || "Unknown error"}`);
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
                config={pageConfig}
                initialData={initialPuckData || { content: [], root: {} }}
                status={status}
                onStatusChange={setStatus}
                saving={saving}
                hasChanges={isDirty}
                onSave={handleSubmit as any}
                onCancel={() => router.back()}
                pageId={pageId || undefined}
                onChange={(data) => {
                    // Ignore the first change event which is fired by Puck initialization
                    if (changesCount.current > 0) {
                        setIsDirty(true);
                    }
                    changesCount.current++;

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
                    // Generate fallback HTML
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
                        }
                    });
                    setContent(html);
                }}
            />
        </div>
    );
}

const IframePreview = ({ children, theme }: { children: React.ReactNode, theme: string }) => {
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
            title="Preview"
        >
            {mountNode && createPortal(children, mountNode)}
        </iframe>
    );
};
