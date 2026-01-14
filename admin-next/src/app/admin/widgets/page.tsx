"use client";

import { useEffect, useState } from "react";
import {
    DndContext,
    DragOverlay,
    closestCenter,
    KeyboardSensor,

    useSensor,
    useSensors,
    DragStartEvent,
    DragEndEvent,
    useDroppable,
    MouseSensor,
    TouchSensor
} from "@dnd-kit/core";
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
    useSortable
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { widgetsApi, Widget, Sidebar } from "@/lib/api";
import ConfirmationModal from "@/components/ConfirmationModal";

// --- Components ---

function DraggableWidget({ widget }: { widget: Widget }) {
    const { attributes, listeners, setNodeRef, transform } = useSortable({
        id: `available-${widget.id}`,
        data: { type: 'available-widget', widget }
    });

    const style = {
        transform: CSS.Translate.toString(transform),
    };

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...listeners}
            {...attributes}
            className="p-3 bg-white border rounded shadow-sm mb-2 cursor-grab hover:bg-gray-50 flex justify-between items-center"
        >
            <div>
                <span className="font-semibold block">{widget.name}</span>
                <span className="text-xs text-gray-500">{widget.description}</span>
            </div>
            <i className="fa-solid fa-grip-vertical text-gray-400"></i>
        </div>
    );
}

function SidebarItem({
    instanceKey,
    widgetId,
    sidebarId,
    onRemove
}: {
    instanceKey: string,
    widgetId: string,
    sidebarId: string,
    onRemove: (id: string, key: string) => void
}) {
    const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
        id: instanceKey,
        data: { type: 'sidebar-item', instanceKey, sidebarId, widgetId }
    });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
    };

    const [isExpanded, setIsExpanded] = useState(false);
    const [settings, setSettings] = useState<any>({}); // Load settings here later

    // Parse widget name from ID for display (simplified)
    const displayId = widgetId.charAt(0).toUpperCase() + widgetId.slice(1);

    return (
        <div ref={setNodeRef} style={style} className="mb-2 bg-white border rounded shadow-sm">
            <div className="p-3 flex justify-between items-center bg-gray-50 border-b">
                <div className="flex items-center gap-2">
                    <button className="cursor-grab text-gray-400 hover:text-gray-600" {...listeners} {...attributes}>
                        <i className="fa-solid fa-grip-vertical"></i>
                    </button>
                    <span className="font-medium select-none">{displayId} Widget</span>
                </div>
                <div className="flex gap-2">
                    <button
                        className="text-gray-500 hover:text-blue-600"
                        onClick={(e) => {
                            e.stopPropagation();
                            setIsExpanded(!isExpanded);
                        }}
                    >
                        <i className={`fa-solid fa-chevron-${isExpanded ? 'up' : 'down'}`}></i>
                    </button>
                    <button
                        className="text-gray-500 hover:text-red-600"
                        onClick={(e) => {
                            e.stopPropagation();
                            onRemove(sidebarId, instanceKey);
                        }}
                    >
                        <i className="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>

            {isExpanded && (
                <div className="p-4">
                    {/* Config form placeholder - to be implemented fully */}
                    <p className="text-sm text-gray-500 mb-2">Detailed settings for {widgetId}...</p>
                    <div className="text-sm text-yellow-600 bg-yellow-50 p-2 rounded">
                        Settings editing coming soon.
                    </div>
                </div>
            )}
        </div>
    );
}

function SidebarContainer({ sidebar, onRemove }: { sidebar: Sidebar, onRemove: (sid: string, key: string) => void }) {
    const { setNodeRef } = useDroppable({
        id: sidebar.id,
        data: { type: 'sidebar-container', sidebarId: sidebar.id }
    });

    return (
        <div ref={setNodeRef} className="bg-gray-100 p-4 rounded-lg min-h-[100px]">
            <h3 className="font-bold text-lg mb-1">{sidebar.name}</h3>
            <p className="text-xs text-gray-500 mb-4">{sidebar.description}</p>

            <SortableContext
                items={sidebar.widgets}
                strategy={verticalListSortingStrategy}
                id={sidebar.id} // Important: Context ID matches Sidebar ID for dropping
            >
                <div className="min-h-[50px]">
                    {sidebar.widgets.length === 0 && (
                        <div className="text-center text-gray-400 py-4 border-2 border-dashed border-gray-300 rounded">
                            Drag widgets here
                        </div>
                    )}
                    {sidebar.widgets.map(key => {
                        const [wId] = key.split('-');
                        return (
                            <SidebarItem
                                key={key}
                                instanceKey={key}
                                widgetId={wId}
                                sidebarId={sidebar.id}
                                onRemove={onRemove}
                            />
                        );
                    })}
                </div>
            </SortableContext>
        </div>
    );
}

// --- Main Page ---

export default function WidgetsPage() {
    const [widgets, setWidgets] = useState<Widget[]>([]);
    const [sidebars, setSidebars] = useState<Sidebar[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [deletingItem, setDeletingItem] = useState<{ sidebarId: string, instanceKey: string } | null>(null);

    const sensors = useSensors(
        useSensor(MouseSensor, {
            activationConstraint: {
                distance: 10,
            },
        }),
        useSensor(TouchSensor, {
            activationConstraint: {
                delay: 250,
                tolerance: 5,
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        try {
            const [wData, sData] = await Promise.all([
                widgetsApi.listWidgets(),
                widgetsApi.listSidebars()
            ]);
            setWidgets(wData);
            setSidebars(sData);
        } catch (e) {
            console.error(e);
            alert("Failed to load widgets/sidebars");
        } finally {
            setLoading(false);
        }
    };

    const handleDragStart = (event: DragStartEvent) => {
        setActiveId(String(event.active.id));
    };

    const handleDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event;
        setActiveId(null);

        if (!over) return;

        // Dropping an available widget onto a sidebar
        if (String(active.id).startsWith("available-") && !String(over.id).startsWith("available-")) {
            const widgetId = active.data.current?.widget.id;

            // Find target sidebar
            // over.id could be a sidebar ID (if empty) or an item ID instanceKey
            let targetSidebarId: string | undefined;

            // Check if over is a sidebar container
            const sidebar = sidebars.find(s => s.id === over.id);
            if (sidebar) {
                targetSidebarId = sidebar.id;
            } else {
                // Or it's over an item in the sidebar
                const overKey = String(over.id);
                // Need to find which sidebar contains this key
                targetSidebarId = sidebars.find(s => s.widgets.includes(overKey))?.id;
            }

            if (targetSidebarId && widgetId) {
                // Optimistic UI Update (or simply reload)
                // Since valid instanceKeys are generated by backend, we must call API then reload
                // Or create temp key.

                try {
                    setLoading(true); // crude flicker prevention
                    await widgetsApi.addToSidebar(targetSidebarId, widgetId);
                    await loadData(); // Reload everything to get clean new state
                } catch (e) {
                    console.error("Add failed", e);
                } finally {
                    setLoading(false);
                }
            }
        }
    };

    const handleRemove = async (sidebarId: string, instanceKey: string) => {
        try {
            await widgetsApi.removeFromSidebar(sidebarId, instanceKey);
            // Optimistic update
            setSidebars(prev => prev.map(s => {
                if (s.id === sidebarId) {
                    return { ...s, widgets: s.widgets.filter(w => w !== instanceKey) };
                }
                return s;
            }));
        } catch (e) {
            console.error("Remove failed", e);
            loadData(); // Revert on error
        }
    };

    if (loading && sidebars.length === 0) return <div className="p-8">Loading Widgets...</div>;

    return (
        <div className="p-6 h-full overflow-auto">
            <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
            >
                <div className="flex justify-between items-center mb-6">
                    <h1 className="text-2xl font-bold text-gray-800">Widgets</h1>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                    {/* Available Widgets Column */}
                    <div className="bg-white p-4 rounded-lg shadow h-fit">
                        <h2 className="font-bold text-gray-700 mb-4 border-b pb-2">Available Widgets</h2>
                        <div className="space-y-2">
                            {/* We treat this list as separate Draggables, NOT a SortableContext because we clone them */}
                            {widgets.map(w => (
                                <DraggableWidget key={w.id} widget={w} />
                            ))}
                        </div>
                    </div>

                    {/* Sidebars Column */}
                    <div className="col-span-2 space-y-6">
                        {sidebars.map(sidebar => (
                            <SidebarContainer
                                key={sidebar.id}
                                sidebar={sidebar}
                                onRemove={(sid, key) => setDeletingItem({ sidebarId: sid, instanceKey: key })}
                            />
                        ))}
                    </div>
                </div>

                <DragOverlay>
                    {activeId ? (
                        <div className="p-3 bg-white border border-blue-500 rounded shadow-lg opacity-80 w-[200px]">
                            Plugin/Item Dragging...
                        </div>
                    ) : null}
                </DragOverlay>

                <ConfirmationModal
                    isOpen={!!deletingItem}
                    onClose={() => setDeletingItem(null)}
                    onConfirm={() => {
                        if (deletingItem) {
                            handleRemove(deletingItem.sidebarId, deletingItem.instanceKey);
                        }
                    }}
                    title="Remove Widget"
                    message="Are you sure you want to remove this widget? This action cannot be undone."
                    confirmText="Remove"
                    isDanger={true}
                />
            </DndContext>
        </div>
    );
}
