"use client";

import { Puck, Config, Data } from "@measured/puck";
import "@measured/puck/puck.css";
import React, { useState, useEffect, useRef } from "react";
import ModernSelect from "./ModernSelect";
import PublicLayout from "@/app/(public)/layout";
import { puckConfig } from "./puckConfig";

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

/**
 * SSR Preview Component - Renders an iframe with the actual public page
 * This guarantees 100% visual fidelity with the live site
 */


import { RichTextEditor } from "./puckConfig";

// Context for Inline Editing
export const EditorContext = React.createContext<{
    updateComponent: (id: string, newProps: any) => void;
    activeEditorId: string | null;
    setActiveEditorId: (id: string | null) => void;
} | null>(null);

// Inline Text Component
const InlineText = ({ id, content, elementId, ...props }: any) => {
    const ctx = React.useContext(EditorContext);
    const isEditing = ctx?.activeEditorId === id;

    // Fallback if no context/id
    if (!ctx || !id) {
        return (
            <div
                id={elementId || undefined}
                className="prose max-w-none"
                dangerouslySetInnerHTML={{ __html: content }}
            />
        );
    }

    // Edit Mode
    if (isEditing) {
        return (
            <div
                className="relative group min-h-[40px] z-[50] cursor-text isolate"
                onMouseDownCapture={(e) => e.stopPropagation()}
                onClickCapture={(e) => e.stopPropagation()}
                onDoubleClickCapture={(e) => e.stopPropagation()}
                onPointerDownCapture={(e) => e.stopPropagation()}
                onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
                draggable={false}
            >
                <RichTextEditor
                    value={content}
                    onChange={(val) => ctx.updateComponent(id, { content: val })}
                    transparent={true}
                />

                {/* Done Button */}
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        ctx.setActiveEditorId(null);
                    }}
                    className="absolute -top-12 right-0 z-[60] w-8 h-8 bg-green-500 hover:bg-green-600 text-white rounded-full shadow-lg flex items-center justify-center transition-all transform hover:scale-105"
                    title="Finalizar edición"
                >
                    <i className="fa-solid fa-check text-sm"></i>
                </button>
            </div>
        );
    }

    // View Mode with Toolbar Button Hack
    const ref = React.useRef<HTMLDivElement>(null);

    // HACK: Force parent Puck wrapper to have overflow visible so our button can "break out"
    React.useLayoutEffect(() => {
        if (ref.current) {
            // Traverse up to find the Draggable wrapper (usually direct parent or grandparent)
            let parent = ref.current.parentElement;
            while (parent && !parent.classList.contains('puck-root')) { // Stop at root
                // Look for class indicating drag wrapper or just unlock close parents
                const style = window.getComputedStyle(parent);
                if (style.overflow === 'hidden' || style.overflowY === 'hidden' || style.overflowX === 'hidden') {
                    parent.style.overflow = 'visible';
                    // Also bump z-index if needed to sit above siblings
                    if (style.zIndex === 'auto') parent.style.zIndex = '10';
                }
                if (parent.getAttribute('data-rbd-draggable-id')) {
                    // Found the main wrapper
                    parent.style.overflow = 'visible';
                    parent.style.zIndex = '20'; // Ensure it stays on top
                    break;
                }
                parent = parent.parentElement;
                // Safety break to not go too far
                if (parent?.tagName === 'BODY') break;
            }
        }
    }, []);

    return (
        <div
            ref={ref}
            className="relative group min-h-[40px] px-1 -mx-1 border border-transparent hover:border-blue-200 hover:bg-blue-50/10 rounded-lg transition-all"
        >
            <div
                id={elementId || undefined}
                className="prose max-w-none"
                dangerouslySetInnerHTML={{ __html: content }}
            />


        </div>
    );
};

// Component to inject CSS into iframe to block overlays during editing
const OverlayBlocker = ({ activeEditorId }: { activeEditorId: string | null }) => {
    React.useEffect(() => {
        if (!activeEditorId) {
            // Clear the style when not editing
            const styleEl = document.getElementById('puck-overlay-blocker');
            if (styleEl) styleEl.textContent = '';
            return;
        }

        const styleId = 'puck-overlay-blocker';
        let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;

        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = styleId;
            document.head.appendChild(styleEl);
        }

        styleEl.textContent = `
            /* Hide ALL Puck overlays when text editing is active */
            [data-puck-overlay-portal],
            [data-puck-overlay],
            [class*="DraggableComponent-overlay"],
            [class*="DraggableComponent-actionsOverlay"],
            [class*="_DraggableComponent"],
            div[style*="position: fixed"][style*="pointer-events"] {
                display: none !important;
                visibility: hidden !important;
                opacity: 0 !important;
                pointer-events: none !important;
            }
        `;

        return () => {
            if (styleEl) styleEl.textContent = '';
        };
    }, [activeEditorId]);

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
    const [data, setData] = useState<Data>(initialData || {
        content: [],
        root: {},
    });

    // Use a Ref to hold data for stable callbacks to avoid re-initializing Puck config on every data change
    const activeConfig = passedConfig || puckConfig;

    // Track if data has been initialized to avoid overwriting state on hot reloads
    const hasInitializedRef = useRef(false);

    useEffect(() => {
        if (initialData && !hasInitializedRef.current) {
            setData(initialData);
            hasInitializedRef.current = true;
        }
    }, [initialData]);

    // Sync data ref for the updateComponent callback
    const dataRef = useRef(data);
    useEffect(() => {
        dataRef.current = data;
    }, [data]);

    // Active Inline Editor State - Required for overlay blocking and context
    const [activeEditorId, setActiveEditorId] = useState<string | null>(null);

    // Sync state synchronously for the patched library to read during render
    if (typeof window !== 'undefined') {
        (window as any).puckActiveEditorId = activeEditorId;
    }

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

    // Extend the config to include the Root Layout (Header, Footer, Theme)
    // This injects the "Preview" look and feel directly into the Editor Iframe
    const editorConfig: Config = React.useMemo(() => ({
        ...activeConfig,
        components: {
            ...activeConfig.components,
            Text: {
                ...activeConfig.components.Text,
                render: (props: any) => <InlineText {...props} />
            }
        },
        root: {
            render: ({ children }: { children: React.ReactNode }) => (
                <div id="puck-root-wrapper">
                    <OverlayBlocker activeEditorId={activeEditorId} />
                    <EditorContext.Provider value={{ updateComponent, activeEditorId, setActiveEditorId }}>
                        <PublicLayout>
                            {children}
                        </PublicLayout>
                    </EditorContext.Provider>
                </div>
            )
        }
    }), [activeConfig, activeEditorId, updateComponent, setActiveEditorId]);

    const overrides = React.useMemo(() => ({
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

    const getViewportWidth = () => {
        switch (viewport) {
            case 'mobile': return '375px';
            case 'tablet': return '768px';
            case 'desktop': return '1280px'; // Always fixed width for desktop simulation
            default: return '1280px';
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

    return (
        <EditorContext.Provider value={{ updateComponent, activeEditorId, setActiveEditorId }}>
            {activeEditorId && (
                <style dangerouslySetInnerHTML={{
                    __html: `
                    /* Hide ALL Puck overlays when text editing is active */
                    [data-puck-overlay-portal],
                    [data-puck-overlay],
                    [data-puck-dnd],
                    [class*="DraggableComponent-overlay"],
                    [class*="DraggableComponent-actionsOverlay"],
                    [class*="DraggableComponent--isSelected"],
                    [class*="DraggableComponent--hover"],
                    [class*="_DraggableComponent"],
                    [class*="overlay"][style*="position: fixed"] {
                        display: none !important;
                        visibility: hidden !important;
                        pointer-events: none !important;
                        opacity: 0 !important;
                    }
                `}} />
            )}
            <div className="puck-container h-full w-full relative bg-white overflow-hidden">
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
                    <div className="flex flex-col h-full w-full overflow-hidden">

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
                        <div className="relative flex-1 w-full bg-slate-100 overflow-hidden">

                            {/* ABSOLUTE SIDEBAR (Left, Top, Bottom) */}
                            <div className={`absolute top-0 left-0 bottom-0 w-[340px] flex flex-col border-r border-gray-200 bg-white z-10 shadow-sm transition-transform duration-300 ${showSidebar ? 'translate-x-0' : '-translate-x-full'}`}>
                                {/* Components Area - Flex 1 to fill available space */}
                                <div className="flex-1 overflow-y-auto min-h-0 relative">
                                    <div className="p-4">
                                        <h3 className="text-xs font-semibold uppercase text-gray-400 mb-4 tracking-wider sticky top-0 bg-white z-10 py-2 -mt-2">Components</h3>
                                        <Puck.Components />
                                    </div>
                                </div>

                                {/* Outline Area - Fixed % Header at bottom */}
                                <div className="h-[35%] overflow-y-auto bg-gray-50 flex-shrink-0 relative border-t border-gray-200">
                                    <div className="p-4">
                                        <h3 className="text-xs font-semibold uppercase text-gray-400 mb-4 tracking-wider sticky top-0 bg-gray-50 z-10 py-2 -mt-2">Outline</h3>
                                        <Puck.Outline />
                                    </div>
                                </div>
                            </div>

                            {/* MAIN PREVIEW AREA - Simplified to library defaults */}
                            <div className="flex-1 relative overflow-hidden bg-slate-100">
                                <Puck.Preview />
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
