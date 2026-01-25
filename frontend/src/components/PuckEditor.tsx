"use client";

import { Puck, Config, Data, migrate, usePuck } from "@measured/puck";
import "@measured/puck/puck.css";
import React, { useState, useEffect, useRef } from "react";
import ModernSelect from "./ModernSelect";
import PublicLayout from "@/app/(public)/layout";
import { puckConfig } from "./puckConfig";
import { RichTextEditor } from "./puckConfig";

interface PuckEditorProps {
    initialData?: Data;
    onChange: (data: Data) => void;
    status?: string;
    onStatusChange?: (status: string) => void;
    saving?: boolean;
    hasChanges?: boolean;
    onSave?: () => void;
    onCancel?: () => void;
    config?: Config;
    pageId?: number;
}

// Context for Inline Editing
export const EditorContext = React.createContext<{
    updateComponent: (id: string, newProps: any) => void;
    activeEditorId: string | null;
    setActiveEditorId: (id: string | null) => void;
} | null>(null);

// Inline Text Component - Simple Textarea Swap
const InlineText = ({ id, content, title, elementId, ...props }: any) => {
    const ctx = React.useContext(EditorContext);
    // Use Puck's hook to get dispatch function
    const { dispatch } = usePuck();

    const isEditing = ctx?.activeEditorId === id;

    // Some components use 'title', some use 'content'. We handle both.
    const actualContent = content || title || "";
    const [localContent, setLocalContent] = React.useState(actualContent);

    // Sync localContent when content prop changes
    React.useEffect(() => {
        if (!isEditing) {
            setLocalContent(actualContent);
        }
    }, [actualContent, isEditing]);

    if (!ctx || !id) {
        return (
            <div
                id={elementId || undefined}
                className="prose max-w-none"
                dangerouslySetInnerHTML={{ __html: actualContent }}
            />
        );
    }

    const handleSave = () => {
        console.log('[InlineText] Saving via Puck Dispatch:', id);

        // Use Puck's internal dispatch to update data reliably
        // This ensures history, state, and UI are all synced
        dispatch({
            type: "setData",
            data: (prev: Data) => {
                const updateList = (list: any[]) => list.map(item => {
                    if (item.props?.id === id || item._id === id || item.id === id) {
                        const newProps = content !== undefined ? { content: localContent } : { title: localContent };
                        return { ...item, props: { ...item.props, ...newProps } };
                    }
                    return item;
                });

                return {
                    ...prev,
                    content: updateList(prev.content || []),
                    zones: Object.keys(prev.zones || {}).reduce((acc: any, key) => ({
                        ...acc,
                        [key]: updateList(prev.zones![key])
                    }), {})
                };
            }
        });

        // Also call legacy updateComponent for good measure (if parent listens to onChange)
        ctx.updateComponent(id, content !== undefined ? { content: localContent } : { title: localContent });
        ctx.setActiveEditorId(null);
    };

    // Edit Mode: Show RichTextEditor in-place
    if (isEditing) {
        return (
            <div
                className="relative z-[9999] isolate !pointer-events-auto min-h-[100px] border-2 border-blue-400 rounded-xl p-1 bg-transparent inline-editor-container"
                data-item-id={id}
                onMouseDownCapture={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.closest('.rich-text-editor-wrapper, .editor-action-buttons')) return;
                    e.stopPropagation();
                }}
                onPointerDownCapture={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.closest('.rich-text-editor-wrapper, .editor-action-buttons')) return;
                    e.stopPropagation();
                }}
                onClickCapture={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.closest('.rich-text-editor-wrapper, .editor-action-buttons')) return;
                    e.stopPropagation();
                }}
                onKeyDown={(e) => {
                    e.stopPropagation();
                }}
            >
                <RichTextEditor
                    value={localContent}
                    onChange={(val: string) => setLocalContent(val)}
                    onSave={handleSave}
                    onCancel={() => {
                        setLocalContent(actualContent);
                        ctx.setActiveEditorId(null);
                    }}
                    transparent={true}
                />
            </div>
        );
    }

    // View Mode: Show content clickable to edit
    return (
        <div
            onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                ctx?.setActiveEditorId(id);
            }}
            className="relative group min-h-[40px] px-1 -mx-1 border border-transparent hover:border-blue-200 hover:bg-blue-50/10 rounded-lg transition-all cursor-text inline-text-view"
        >
            <div
                id={elementId || undefined}
                className="prose max-w-none"
                dangerouslySetInnerHTML={{ __html: actualContent }}
            />
        </div>
    );
};

// Component to inject CSS into iframe to block overlays during editing
// Optimized to be surgical and self-cleaning
const OverlayBlocker = () => {
    const [activeId, setActiveId] = React.useState<string | null>(null);

    React.useEffect(() => {
        // Look for the initial state if any
        if (typeof window !== 'undefined') {
            const initialId = (window as any).puckActiveEditorId || (window.parent as any)?.puckActiveEditorId || null;
            setActiveId(initialId);
        }

        // Listen for changes from the parent or same window
        const handleIdChange = (e: any) => {
            setActiveId(e.detail);
        };
        window.addEventListener('puck-editor-change', handleIdChange);
        return () => window.removeEventListener('puck-editor-change', handleIdChange);
    }, []);

    React.useEffect(() => {
        const styleId = 'puck-overlay-blocker';
        const doc = document;

        if (!activeId) {
            const styleEl = doc.getElementById(styleId);
            if (styleEl) styleEl.remove();

            // Explicitly restore pointer events just in case
            if (doc.body) doc.body.style.pointerEvents = 'auto';
            return;
        }

        let styleEl = doc.getElementById(styleId) as HTMLStyleElement | null;
        if (!styleEl) {
            styleEl = doc.createElement('style');
            styleEl.id = styleId;
            doc.head.appendChild(styleEl);
        }

        styleEl.textContent = `
            /* Hide only Puck-specific overlays when text editing is active */
            /* Be careful NOT to hide general content - only draggable component overlays */
            [data-puck-overlay-portal],
            [data-puck-overlay] {
                pointer-events: none !important;
                opacity: 0 !important;
            }
            
            /* Hide Puck draggable overlays specifically */
            [class*="DraggableComponent-overlay"],
            [class*="DraggableComponent-actionsOverlay"] {
                display: none !important;
                visibility: hidden !important;
                pointer-events: none !important;
            }

            /* Force text cursor and selection in the editor writing area */
            .rich-text-content, .rich-text-content * {
                cursor: text !important;
            }

            /* Force pointer cursor on buttons and interactive elements */
            .inline-editor-container button, 
            .inline-editor-container button *,
            .inline-editor-container input,
            .inline-editor-container select,
            .inline-editor-container [role="button"],
            .editor-action-buttons,
            .editor-action-buttons * {
                cursor: pointer !important;
                pointer-events: auto !important;
            }

            .inline-editor-container, .inline-editor-container * {
                user-select: text !important;
                -webkit-user-select: text !important;
                pointer-events: auto !important;
            }

            /* Disable drag cursor on the component wrapper while editing */
            [data-puck-component] {
                cursor: default !important;
            }
        `;

        return () => {
            const el = doc.getElementById(styleId);
            if (el) el.remove();
        };
    }, [activeId]);

    return null;
};

// Floating Properties Panel with Premium Design
const FloatingPropertiesPanel = () => {
    const [panelState, setPanelState] = useState({ x: 0, y: 0, minimized: true });
    const panelRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startX: number, startY: number, initialX: number, initialY: number } | null>(null);

    const handlePanelDragStart = (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('button')) return;
        e.preventDefault();
        dragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            initialX: panelState.x,
            initialY: panelState.y
        };
        const handleMouseMove = (moveEvent: MouseEvent) => {
            if (!dragRef.current || !panelRef.current) return;
            const newX = dragRef.current.initialX + (moveEvent.clientX - dragRef.current.startX);
            const newY = dragRef.current.initialY + (moveEvent.clientY - dragRef.current.startY);
            panelRef.current.style.transform = `translate(${newX}px, ${newY}px)`;
            (dragRef.current as any).currentX = newX;
            (dragRef.current as any).currentY = newY;
        };
        const handleMouseUp = () => {
            if (dragRef.current) {
                const finalX = (dragRef.current as any).currentX ?? panelState.x;
                const finalY = (dragRef.current as any).currentY ?? panelState.y;
                setPanelState(prev => ({ ...prev, x: finalX, y: finalY }));
            }
            dragRef.current = null;
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    };

    return (
        <div
            ref={panelRef}
            className={`absolute right-6 top-20 w-[340px] flex flex-col bg-white/90 backdrop-blur-xl shadow-2xl shadow-blue-900/10 rounded-[32px] border border-white/50 overflow-hidden z-[4000] transition-all duration-300 ring-1 ring-black/5 ${panelState.minimized ? 'h-[72px]' : 'max-h-[80vh]'}`}
            style={{ transform: `translate(${panelState.x}px, ${panelState.y}px)` }}
        >
            <div
                className="p-5 cursor-move flex flex-col justify-center h-[72px] shrink-0 select-none group"
                onMouseDown={handlePanelDragStart}
            >
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-blue-50 text-blue-500 flex items-center justify-center shadow-inner">
                            <i className="fa-solid fa-sliders text-sm"></i>
                        </div>
                        <div>
                            <h3 className="text-sm font-black text-gray-800 italic tracking-tight">Properties</h3>
                            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Editor Controls</p>
                        </div>
                    </div>
                    <button
                        onClick={() => setPanelState(s => ({ ...s, minimized: !s.minimized }))}
                        className="w-8 h-8 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-blue-600 transition-all shadow-sm border border-transparent hover:border-gray-200"
                    >
                        <i className={`fa-solid fa-${panelState.minimized ? 'chevron-down' : 'chevron-up'} text-xs`}></i>
                    </button>
                </div>
            </div>

            {!panelState.minimized && (
                <div className="p-5 pt-0 overflow-y-auto flex-1 custom-scrollbar">
                    <div className="space-y-4">
                        <Puck.Fields />
                    </div>
                </div>
            )}
        </div>
    );
};


export default function PuckEditor({
    initialData,
    onChange,
    status = "draft",
    onStatusChange,
    saving = false,
    hasChanges = true,
    onSave,
    onCancel,
    config: passedConfig,
    pageId
}: PuckEditorProps) {
    const activeConfig = passedConfig || puckConfig;

    const [data, setData] = useState<Data>(() => {
        const baseData = initialData || {
            content: [],
            root: {},
        };
        // Apply migration from DropZones to Slots
        return migrate(baseData, activeConfig);
    });

    // Track if data has been initialized to avoid overwriting state on hot reloads
    const hasInitializedRef = useRef(false);

    useEffect(() => {
        if (initialData && !hasInitializedRef.current) {
            setData(migrate(initialData, activeConfig));
            hasInitializedRef.current = true;
        }
    }, [initialData, activeConfig]);

    // Sync data ref for the updateComponent callback
    const dataRef = useRef(data);
    useEffect(() => {
        dataRef.current = data;
    }, [data]);

    // Active Inline Editor State - Required for overlay blocking and context
    const [activeEditorId, setActiveEditorId] = useState<string | null>(null);

    // Sync activeEditorId to window and dispatch event for the iframe
    React.useEffect(() => {
        if (typeof window !== 'undefined') {
            (window as any).puckActiveEditorId = activeEditorId;
            window.dispatchEvent(new CustomEvent('puck-editor-change', { detail: activeEditorId }));
        }
    }, [activeEditorId]);
    // Expose setActiveEditorId globally (Legacy/Backup)
    useEffect(() => {
        (window as any).puckSetActiveEditorId = setActiveEditorId;
        return () => {
            delete (window as any).puckSetActiveEditorId;
        };
    }, [setActiveEditorId]);

    const updateComponent = React.useCallback((id: string, newProps: any) => {
        const currentData = dataRef.current;

        const updateList = (list: any[]) => list.map(item => {
            if (item.props?.id === id || item._id === id || item.id === id) {
                return { ...item, props: { ...item.props, ...newProps } };
            }
            return item;
        });

        const newData = {
            ...currentData,
            content: updateList(currentData.content || []),
            zones: Object.keys(currentData.zones || {}).reduce((acc: any, key) => ({
                ...acc,
                [key]: updateList(currentData.zones![key])
            }), {})
        };

        setData(newData);
        onChange(newData);
    }, [onChange]);

    // STABLE CONFIG: No dependencies on state that changes during editing
    // This prevents Puck from reloading the iframe when activeEditorId changes
    const editorConfig = React.useMemo(() => {
        // Stable PuckRoot that uses Window/Events to stay synced
        const StablePuckRoot = ({ children }: { children: React.ReactNode }) => {
            return (
                <div id="puck-root-wrapper">
                    <OverlayBlocker />
                    <EditorContext.Provider value={{
                        updateComponent: (id: string, data: any) => {
                            const fn = (window as any).puckUpdateComponent || (window.parent as any)?.puckUpdateComponent;
                            if (fn) fn(id, data);
                        },
                        activeEditorId: (window as any).puckActiveEditorId || (window.parent as any)?.puckActiveEditorId || null,
                        setActiveEditorId: (id: string | null) => {
                            const fn = (window as any).puckSetActiveEditorId || (window.parent as any)?.puckSetActiveEditorId;
                            if (fn) fn(id);
                        }
                    }}>
                        <PublicLayout>
                            {children}
                        </PublicLayout>
                    </EditorContext.Provider>
                </div>
            );
        };

        const baseConfig = activeConfig;
        const editorOverrides = {
            Text: {
                ...baseConfig.components.Text,
                render: (props: any) => {
                    return <InlineText {...props} id={props.id || props.puck?.id} />;
                }
            },
            Heading: {
                ...baseConfig.components.Heading,
                render: (props: any) => {
                    return <InlineText {...props} id={props.id || props.puck?.id} />;
                }
            }
        };

        return {
            ...baseConfig,
            root: {
                ...baseConfig.root,
                render: StablePuckRoot
            },
            components: {
                ...baseConfig.components,
                ...editorOverrides
            }
        };
    }, [activeConfig]);

    // Sync state and functions to window for the stable config to use
    React.useEffect(() => {
        if (typeof window !== 'undefined') {
            (window as any).puckActiveEditorId = activeEditorId;
            (window as any).puckSetActiveEditorId = setActiveEditorId;
            (window as any).puckUpdateComponent = updateComponent;

            const event = new CustomEvent('puck-editor-change', { detail: activeEditorId });
            window.dispatchEvent(event);

            // Also notify the iframe directly if it exists
            const iframe = document.querySelector('iframe') as HTMLIFrameElement;
            if (iframe && iframe.contentWindow) {
                iframe.contentWindow.dispatchEvent(new CustomEvent('puck-editor-change', { detail: activeEditorId }));
            }
        }
    }, [activeEditorId, updateComponent, setActiveEditorId]);

    const overrides = React.useMemo(() => ({
        button: ({ children, ...props }: any) => (
            <button
                {...props}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
            >
                {children}
            </button>
        ),
        headerActions: () => (
            <div className="flex items-center gap-3">
                {onStatusChange && (
                    <ModernSelect
                        value={status}
                        onChange={(e) => onStatusChange(e.target.value)}
                        options={[
                            { value: "draft", label: "Draft" },
                            { value: "publish", label: "Publish" },
                            { value: "pending", label: "Pending" },
                        ]}
                        className="!py-1.5 !px-3 !bg-white !border-gray-200 !rounded-md !text-sm font-normal min-w-[100px]"
                    />
                )}
                {onCancel && (
                    <button
                        type="button"
                        onClick={onCancel}
                        className="px-3 py-1.5 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                        Cancel
                    </button>
                )}
                {onSave && (
                    <button
                        type="button"
                        onClick={onSave}
                        disabled={saving || !hasChanges}
                        className={`px-3 py-1.5 rounded-md text-sm transition-colors flex items-center gap-1.5 ${hasChanges
                            ? 'bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white'
                            : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                            }`}
                        title={hasChanges ? 'Save changes' : 'No changes to save'}
                    >
                        <i className="fa-solid fa-floppy-disk text-xs"></i>
                        {saving ? "Saving..." : hasChanges ? "Save" : "Saved"}
                    </button>
                )}
            </div>
        ),
        componentOverlay: ({ children, componentId }: any) => {
            if (activeEditorId === componentId) {
                // Edit Mode: REMOVE the Overlay completely so it doesn't exist to trap clicks
                return <div className="hidden" />;
            }
            return <>{children}</>;
        },
    }), [onStatusChange, status, onCancel, onSave, saving, hasChanges, activeEditorId]);

    // Viewport State
    const [viewport, setViewport] = useState('desktop');

    const getViewportWidth = () => {
        switch (viewport) {
            case 'mobile': return '375px';
            case 'tablet': return '768px';
            case 'desktop': return '100%';
            default: return '100%';
        }
    };



    // Layout Visibility State
    const [showSidebar, setShowSidebar] = useState(true);
    const [showProperties, setShowProperties] = useState(true);
    const [isUiLoaded, setIsUiLoaded] = useState(false);

    // Persist UI preferences
    useEffect(() => {
        // Load on mount
        const savedSidebar = localStorage.getItem('puck_show_sidebar');
        const savedProps = localStorage.getItem('puck_show_properties');

        if (savedSidebar !== null) setShowSidebar(savedSidebar === 'true');
        if (savedProps !== null) setShowProperties(savedProps === 'true');

        setIsUiLoaded(true);
    }, []);

    useEffect(() => {
        if (isUiLoaded) {
            localStorage.setItem('puck_show_sidebar', String(showSidebar));
        }
    }, [showSidebar, isUiLoaded]);

    useEffect(() => {
        if (isUiLoaded) {
            localStorage.setItem('puck_show_properties', String(showProperties));
        }
    }, [showProperties, isUiLoaded]);

    // Force re-calculation of scale after sidebar transition (300ms)
    useEffect(() => {
        const timer = setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 350);
        return () => clearTimeout(timer);
    }, [showSidebar]);

    // Resizable Outline State
    const [outlineHeight, setOutlineHeight] = useState('35%');
    const sidebarRef = useRef<HTMLDivElement>(null);
    const isResizingRef = useRef(false);

    useEffect(() => {
        if (isUiLoaded) {
            const savedHeight = localStorage.getItem('puck_outline_height');
            if (savedHeight) setOutlineHeight(savedHeight);
        }
    }, [isUiLoaded]);

    const startResizing = (e: React.MouseEvent) => {
        e.preventDefault();
        isResizingRef.current = true;
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', stopResizing);
    };

    const handleMouseMove = (e: MouseEvent) => {
        if (!isResizingRef.current || !sidebarRef.current) return;

        const sidebarRect = sidebarRef.current.getBoundingClientRect();
        const newHeight = sidebarRect.bottom - e.clientY;
        const totalHeight = sidebarRect.height;

        // Min height constraints (px)
        if (newHeight > 50 && newHeight < totalHeight - 50) {
            const percentage = (newHeight / totalHeight) * 100;
            setOutlineHeight(`${percentage}%`);
        }
    };

    const stopResizing = () => {
        isResizingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', stopResizing);

        // Save current height (we need to access the state, but event listeners close over values)
        // Since we are setting state during move, we can just save the value from state in a subsequent effect
        // or just accept that the last move set the state.
        // We'll save to localStorage in a useEffect to be safe and clean.
    };

    useEffect(() => {
        if (isUiLoaded && !isResizingRef.current) {
            localStorage.setItem('puck_outline_height', outlineHeight);
        }
    }, [outlineHeight, isUiLoaded]);

    return (
        <EditorContext.Provider value={{ updateComponent, activeEditorId, setActiveEditorId }}>
            {activeEditorId && (
                <style dangerouslySetInnerHTML={{
                    __html: `
                    /* Hide only Puck-specific overlays when text editing is active */
                    [data-puck-overlay-portal], [data-puck-overlay] { pointer-events: none !important; opacity: 0 !important; }
                    [class*="DraggableComponent-overlay"], [class*="DraggableComponent-actionsOverlay"] { display: none !important; visibility: hidden !important; pointer-events: none !important; }
                `}} />
            )}
            <div className="puck-container absolute inset-0 bg-gray-50">
                <Puck
                    config={editorConfig}
                    data={data}
                    onPublish={(data) => onChange(data)}
                    onChange={(newData) => { onChange(newData); }}
                    overrides={overrides}
                    iframe={{ enabled: true }}
                >
                    <div className="flex flex-col h-screen w-full overflow-hidden">

                        {/* PREMIUM HEADER (h-20) */}
                        <div className="h-20 flex items-center justify-between bg-white/80 backdrop-blur-md px-6 md:px-8 shrink-0 z-20 relative border-b border-gray-100 shadow-sm gap-6">

                            {/* Left: Branding & Visibility */}
                            <div className="flex items-center gap-6">
                                <div className="flex items-center gap-3 text-gray-900">
                                    <div className="w-10 h-10 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
                                        <i className="fa-solid fa-pen-nib text-lg"></i>
                                    </div>
                                    <div className="hidden md:block">
                                        <h1 className="font-black italic text-xl tracking-tighter leading-none">Editor</h1>
                                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest leading-none">Visual Builder</span>
                                    </div>
                                </div>

                                <div className="h-8 w-px bg-gray-100 hidden md:block"></div>

                                {/* Visibility Controls */}
                                <div className="flex items-center bg-gray-50/50 rounded-2xl p-1.5 gap-1 border border-gray-100">
                                    <button
                                        onClick={() => setShowSidebar(!showSidebar)}
                                        className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-300 ${showSidebar ? 'bg-white shadow-md text-blue-600 font-bold' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
                                        title={showSidebar ? "Hide Sidebar" : "Show Sidebar"}
                                    >
                                        <i className={`fa-solid fa-table-columns`}></i>
                                    </button>
                                    <button
                                        onClick={() => setShowProperties(!showProperties)}
                                        className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-300 ${showProperties ? 'bg-white shadow-md text-blue-600 font-bold' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
                                        title={showProperties ? "Hide Properties" : "Show Properties"}
                                    >
                                        <i className={`fa-solid fa-sliders`}></i>
                                    </button>
                                </div>
                            </div>

                            {/* Center: Viewport Controls */}
                            <div className="hidden lg:flex items-center bg-gray-50/50 rounded-2xl p-1.5 gap-1 border border-gray-100 absolute left-1/2 -translate-x-1/2">
                                {[
                                    { mode: 'desktop', icon: 'desktop' },
                                    { mode: 'tablet', icon: 'tablet-screen-button' },
                                    { mode: 'mobile', icon: 'mobile-screen-button' }
                                ].map((v) => (
                                    <button
                                        key={v.mode}
                                        onClick={() => setViewport(v.mode)}
                                        className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-300 ${viewport === v.mode ? 'bg-white shadow-md text-blue-600 scale-105' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
                                    >
                                        <i className={`fa-solid fa-${v.icon}`}></i>
                                    </button>
                                ))}
                            </div>

                            {/* Right: Actions */}
                            <div className="flex items-center gap-4">
                                {onStatusChange && (
                                    <div className="hidden md:block">
                                        <ModernSelect
                                            value={status}
                                            onChange={(e) => onStatusChange(e.target.value)}
                                            options={[
                                                { value: "draft", label: "Draft" },
                                                { value: "publish", label: "Publish" },
                                                { value: "pending", label: "Pending" },
                                            ]}
                                            className="!py-2.5 !px-4 !bg-gray-50 !border-gray-100 !rounded-xl !text-xs !font-bold !uppercase !tracking-wider min-w-[120px]"
                                        />
                                    </div>
                                )}

                                <div className="flex items-center gap-2">
                                    {onCancel && (
                                        <button
                                            type="button"
                                            onClick={onCancel}
                                            className="px-6 py-3 rounded-xl text-gray-500 font-bold hover:bg-gray-50 hover:text-red-500 transition-colors text-xs uppercase tracking-widest"
                                        >
                                            Cancel
                                        </button>
                                    )}
                                    {onSave && (
                                        <button
                                            type="button"
                                            onClick={onSave}
                                            disabled={saving || !hasChanges}
                                            className={`px-8 py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 shadow-lg ${hasChanges
                                                ? 'bg-gray-900 hover:bg-blue-600 text-white shadow-gray-200 hover:shadow-blue-500/30 hover:-translate-y-0.5'
                                                : 'bg-gray-100 text-gray-400 cursor-not-allowed shadow-none'
                                                }`}
                                        >
                                            {saving ? (
                                                <i className="fa-solid fa-circle-notch fa-spin"></i>
                                            ) : (
                                                <i className="fa-solid fa-floppy-disk"></i>
                                            )}
                                            {saving ? "Saving..." : "Save Changes"}
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* 2. Content Area (Below Header) */}
                        <div className="relative flex-1 w-full bg-gray-50/50 overflow-hidden flex flex-col min-h-0 md:flex-row">

                            {/* EDITOR SIDEBAR (Left) */}
                            <div
                                ref={sidebarRef}
                                className={`
                                flex flex-col bg-white z-30 shadow-[4px_0_24px_-4px_rgba(0,0,0,0.05)] transition-all duration-300 ease-in-out relative
                                ${showSidebar ? 'w-[360px] opacity-100' : 'w-0 opacity-0 overflow-hidden'}
                            `}>

                                {/* Gradient Border Line */}
                                <div className="absolute top-0 bottom-0 right-0 w-px bg-gradient-to-b from-gray-100 via-gray-200 to-gray-100"></div>

                                {/* Components Area */}
                                <div className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar min-h-0 relative">
                                    <div className="p-6 w-[360px]">
                                        <div className="sticky top-0 bg-white z-10 py-3 -mt-2 mb-4 border-b border-gray-50">
                                            <h3 className="text-xs font-black uppercase text-gray-900 tracking-widest flex items-center gap-2">
                                                <i className="fa-solid fa-shapes text-blue-500"></i>
                                                Components
                                            </h3>
                                        </div>
                                        <div className="puck-components-wrapper">
                                            <Puck.Components />
                                        </div>
                                    </div>
                                </div>

                                {/* Resizer Handle */}
                                <div
                                    className="h-2 hover:bg-blue-50 cursor-row-resize flex items-center justify-center transition-colors shrink-0 z-20 group relative"
                                    onMouseDown={startResizing}
                                >
                                    <div className="absolute inset-x-0 h-px bg-gray-100 top-1/2 -translate-y-1/2 group-hover:bg-blue-200 transition-colors"></div>
                                    <div className="w-12 h-1.5 rounded-full bg-gray-300 group-hover:bg-blue-400 transition-all z-10 shadow-sm"></div>
                                </div>

                                {/* Outline Area */}
                                <div
                                    style={{ height: outlineHeight }}
                                    className="overflow-y-auto overflow-x-hidden custom-scrollbar bg-gray-50/30 flex-shrink-0 relative"
                                >
                                    <div className="p-6 w-[360px]">
                                        <div className="sticky top-0 bg-gray-50/95 backdrop-blur-sm z-10 py-3 -mt-2 mb-4 border-b border-gray-100">
                                            <h3 className="text-xs font-black uppercase text-gray-900 tracking-widest flex items-center gap-2">
                                                <i className="fa-solid fa-list-tree text-indigo-500"></i>
                                                Structure
                                            </h3>
                                        </div>
                                        <Puck.Outline />
                                    </div>
                                </div>
                            </div>

                            {/* MAIN PREVIEW AREA */}
                            <div className="flex-1 relative overflow-hidden bg-gray-100/50 h-full min-h-0 flex flex-col items-center p-4 md:py-10 md:px-12">
                                {/* Dotted Background Pattern */}
                                <div className="absolute inset-0 opacity-40 pointer-events-none" style={{ backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)', backgroundSize: '24px 24px' }}></div>

                                <div
                                    className="flex-1 h-full transition-all duration-500 shadow-2xl bg-white border-[8px] border-gray-900 rounded-[3rem] overflow-hidden relative z-10"
                                    style={{ width: getViewportWidth() }}
                                >
                                    {/* Notch decoration */}
                                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-gray-900 rounded-b-2xl z-50 pointer-events-none"></div>

                                    <Puck.Preview />
                                </div>
                            </div>

                            {/* Floating Properties Panel handled by state, rendered here for z-index context if needed */}
                            {showProperties && <FloatingPropertiesPanel />}
                        </div>
                    </div>
                </Puck>
            </div>
        </EditorContext.Provider>
    );
}
