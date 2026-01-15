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

// Isolated Properties Panel component to prevent re-renders of the entire editor during drag
const FloatingPropertiesPanel = () => {
    // Local state for panel position and minimization
    // We store x/y in state only to persist it across re-renders (like minimize toggles)
    const [panelState, setPanelState] = useState({ x: 0, y: 0, minimized: true });

    // Refs for direct DOM manipulation to avoid re-rendering React during drag
    const panelRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startX: number, startY: number, initialX: number, initialY: number } | null>(null);

    const handlePanelDragStart = (e: React.MouseEvent) => {
        // Prevent drag triggers on buttons
        if ((e.target as HTMLElement).closest('button')) return;

        e.preventDefault();

        // Capture initial state
        dragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            initialX: panelState.x,
            initialY: panelState.y
        };

        const handleMouseMove = (moveEvent: MouseEvent) => {
            if (!dragRef.current || !panelRef.current) return;

            // Calculate new position
            const deltaX = moveEvent.clientX - dragRef.current.startX;
            const deltaY = moveEvent.clientY - dragRef.current.startY;
            const newX = dragRef.current.initialX + deltaX;
            const newY = dragRef.current.initialY + deltaY;

            // Direct DOM update (GPU accelerated, no React render)
            panelRef.current.style.transform = `translate(${newX}px, ${newY}px)`;

            // Store current pos in ref for mouseup
            (dragRef.current as any).currentX = newX;
            (dragRef.current as any).currentY = newY;
        };

        const handleMouseUp = () => {
            if (dragRef.current && panelRef.current) {
                // Sync final position to React state
                const finalX = (dragRef.current as any).currentX ?? dragRef.current.initialX;
                const finalY = (dragRef.current as any).currentY ?? dragRef.current.initialY;

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
            className={`absolute right-4 top-4 w-[320px] flex flex-col bg-white/95 backdrop-blur shadow-2xl rounded-2xl border border-gray-200 overflow-hidden z-30 transition-all duration-200 ${panelState.minimized ? 'h-14' : 'max-h-[80vh]'}`}
            style={{
                // Use state for initial render, but DOM updates will override this style attribute directly
                transform: `translate(${panelState.x}px, ${panelState.y}px)`
            }}
        >
            <div
                className="p-4 border-b border-gray-100 cursor-move bg-gray-50/50 flex flex-col justify-center h-14 shrink-0 select-none"
                onMouseDown={handlePanelDragStart}
            >
                <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase text-gray-500 tracking-wider flex items-center gap-2">
                        <i className="fa-solid fa-grip-vertical text-gray-300"></i>
                        Properties
                    </h3>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => setPanelState(s => ({ ...s, minimized: !s.minimized }))}
                            className="w-6 h-6 rounded hover:bg-gray-200 flex items-center justify-center text-gray-500 transition-colors"
                        >
                            <i className={`fa-solid fa-${panelState.minimized ? 'expand' : 'minus'} text-xs`}></i>
                        </button>
                    </div>
                </div>
            </div>

            {!panelState.minimized && (
                <div className="p-4 overflow-y-auto flex-1">
                    <Puck.Fields />
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
                `}} />
            )}
            <div className="puck-container absolute inset-0 bg-white">
                <Puck
                    config={editorConfig}
                    data={data}
                    onPublish={(data) => onChange(data)}
                    onChange={(newData) => {
                        onChange(newData);
                    }}
                    overrides={overrides}
                    iframe={{ enabled: true }}
                >
                    {/* Main Layout Container */}
                    <div className="flex flex-col h-screen w-full overflow-hidden">

                        {/* 1. Fixed Header (h-14 = 56px) */}
                        <div className="h-14 flex items-center justify-between border-b border-gray-200 bg-white px-4 shrink-0 z-20 relative">
                            <div className="flex items-center gap-4">
                                <span className="font-semibold text-gray-900">WordJS Editor</span>

                                <div className="h-6 w-px bg-gray-200 mx-2"></div>

                                {/* Visibility Controls */}
                                <div className="flex items-center bg-gray-100 rounded-lg p-1 gap-1">
                                    <button
                                        onClick={() => setShowSidebar(!showSidebar)}
                                        className={`p-1.5 rounded-md transition-all ${showSidebar ? 'bg-white shadow text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
                                        title={showSidebar ? "Hide Sidebar" : "Show Sidebar"}
                                    >
                                        <i className={`fa-solid fa-table-columns text-xs`}></i>
                                    </button>
                                    <button
                                        onClick={() => setShowProperties(!showProperties)}
                                        className={`p-1.5 rounded-md transition-all ${showProperties ? 'bg-white shadow text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
                                        title={showProperties ? "Hide Properties" : "Show Properties"}
                                    >
                                        <i className={`fa-solid fa-indent text-xs`}></i>
                                    </button>
                                </div>

                                <div className="h-6 w-px bg-gray-200 mx-2"></div>

                                {/* Viewport Controls */}
                                <div className="flex items-center bg-gray-100 rounded-lg p-1 gap-1">
                                    <button
                                        onClick={() => setViewport('desktop')}
                                        className={`p-1.5 rounded-md transition-all ${viewport === 'desktop' ? 'bg-white shadow text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
                                        title="Desktop"
                                    >
                                        <i className="fa-solid fa-desktop text-xs"></i>
                                    </button>
                                    <button
                                        onClick={() => setViewport('tablet')}
                                        className={`p-1.5 rounded-md transition-all ${viewport === 'tablet' ? 'bg-white shadow text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
                                        title="Tablet"
                                    >
                                        <i className="fa-solid fa-tablet-screen-button text-xs"></i>
                                    </button>
                                    <button
                                        onClick={() => setViewport('mobile')}
                                        className={`p-1.5 rounded-md transition-all ${viewport === 'mobile' ? 'bg-white shadow text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
                                        title="Mobile"
                                    >
                                        <i className="fa-solid fa-mobile-screen-button text-xs"></i>
                                    </button>
                                </div>

                                <div className="h-6 w-px bg-gray-200 mx-2"></div>

                            </div>

                            {/* Right Actions */}
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
                        </div>

                        {/* 2. Content Area (Below Header) */}
                        <div className="relative flex-1 w-full bg-slate-100 overflow-hidden flex flex-col min-h-0 md:flex-row">

                            {/* EDITOR SIDEBAR (Left) - Takes space on Desktop */}
                            <div
                                ref={sidebarRef}
                                className={`
                                flex flex-col border-r border-gray-200 bg-white z-10 shadow-sm transition-all duration-300 ease-in-out
                                ${showSidebar ? 'w-[340px] opacity-100' : 'w-0 opacity-0 overflow-hidden border-none'}
                            `}>
                                {/* Components Area - Flex 1 to fill available space */}
                                <div className="flex-1 overflow-y-auto overflow-x-hidden modern-scrollbar min-h-0 relative">
                                    <div className="p-4 w-[340px]"> {/* Fixed width inner container to prevent squashing during transition */}
                                        <h3 className="text-xs font-semibold uppercase text-gray-400 mb-4 tracking-wider sticky top-0 bg-white z-10 py-2 -mt-2">Components</h3>
                                        <Puck.Components />
                                    </div>
                                </div>

                                {/* Resizer Handle */}
                                <div
                                    className="h-1.5 bg-gray-100 hover:bg-blue-400 cursor-row-resize flex items-center justify-center transition-colors shrink-0 z-20 group"
                                    onMouseDown={startResizing}
                                >
                                    <div className="w-8 h-1 rounded-full bg-gray-300 group-hover:bg-white transition-colors"></div>
                                </div>

                                {/* Outline Area - Resizable Height */}
                                <div
                                    style={{ height: outlineHeight }}
                                    className="overflow-y-auto overflow-x-hidden modern-scrollbar bg-gray-50 flex-shrink-0 relative border-t border-gray-200"
                                >
                                    <div className="p-4 w-[340px]">
                                        <h3 className="text-xs font-semibold uppercase text-gray-400 mb-4 tracking-wider sticky top-0 bg-gray-50 z-10 py-2 -mt-2">Outline</h3>
                                        <Puck.Outline />
                                    </div>
                                </div>
                            </div>

                            {/* MAIN PREVIEW AREA - Flex-1 takes remaining space */}
                            <div className="flex-1 relative overflow-hidden bg-slate-100 h-full min-h-0 flex flex-col items-center py-8 px-8 overflow-y-auto">
                                <div
                                    className="flex-1 h-full transition-all duration-300 shadow-xl bg-white border border-gray-300 rounded-xl overflow-hidden"
                                    style={{ width: getViewportWidth() }}
                                >
                                    <Puck.Preview />
                                </div>
                            </div>

                            {/* Floating Properties Panel */}
                            {showProperties && <FloatingPropertiesPanel />}
                        </div>
                    </div>
                </Puck>
            </div>
        </EditorContext.Provider>
    );
}
