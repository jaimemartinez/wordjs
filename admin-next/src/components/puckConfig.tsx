"use client";

import React from "react";

import { Config, DropZone, PuckComponent } from "@measured/puck";
import { useState, useEffect } from "react";
import MediaPickerModal from "./MediaPickerModal";
import ModernSelect from "./ModernSelect";
import { categoriesApi, Category } from "@/lib/api";


// Plugin Puck Components
import { puckPluginComponents } from "../lib/puckPluginRegistry";

// Custom Category Field component
const CategoryField = ({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
    const [categories, setCategories] = useState<Category[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        categoriesApi.list().then((cats) => {
            setCategories(cats);
            setLoading(false);
        }).catch(() => setLoading(false));
    }, []);

    return (
        <ModernSelect
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={loading}
            options={[
                { value: "", label: "Select Category" },
                ...categories.map((cat) => ({
                    value: cat.name,
                    label: cat.name
                }))
            ]}
            className="!py-2 !px-3 font-normal"
        />
    );
};

// Column Style Interface
interface ColumnStyle {
    backgroundColor?: string;
    padding?: string;
    borderWidth?: string;
    borderColor?: string;
    borderRadius?: string;
}

// Column Style Accordion - for per-column styling
const ColumnStyleAccordion = ({ value, onChange, columnCount }: {
    value: ColumnStyle[];
    onChange: (styles: ColumnStyle[]) => void;
    columnCount: number;
}) => {
    const [openAccordion, setOpenAccordion] = useState<number | null>(null);

    // Initialize styles array based on column count
    const styles = value || Array(columnCount).fill({}).map(() => ({
        backgroundColor: 'transparent',
        padding: '16px',
        borderWidth: '0px',
        borderColor: '#e5e7eb',
        borderRadius: '0px'
    }));

    const updateColumnStyle = (index: number, property: keyof ColumnStyle, val: string) => {
        const newStyles = [...styles];
        if (!newStyles[index]) {
            newStyles[index] = {};
        }
        newStyles[index] = { ...newStyles[index], [property]: val };
        onChange(newStyles);
    };

    return (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
            {Array.from({ length: columnCount }).map((_, index) => (
                <div key={index} className="border-b border-gray-200 last:border-b-0">
                    <button
                        type="button"
                        className="w-full px-4 py-3 flex justify-between items-center bg-gray-50 hover:bg-gray-100 transition-colors"
                        onClick={() => setOpenAccordion(openAccordion === index ? null : index)}
                    >
                        <span className="font-medium text-sm">Columna {index + 1}</span>
                        <span className="text-gray-500">{openAccordion === index ? '▲' : '▼'}</span>
                    </button>
                    {openAccordion === index && (
                        <div className="p-4 space-y-3 bg-white">
                            <div>
                                <label className="block text-xs text-gray-600 mb-1">Color de fondo</label>
                                <div className="flex gap-2">
                                    <input
                                        type="color"
                                        value={styles[index]?.backgroundColor || '#ffffff'}
                                        onChange={(e) => updateColumnStyle(index, 'backgroundColor', e.target.value)}
                                        className="w-10 h-8 border rounded cursor-pointer"
                                    />
                                    <input
                                        type="text"
                                        value={styles[index]?.backgroundColor || 'transparent'}
                                        onChange={(e) => updateColumnStyle(index, 'backgroundColor', e.target.value)}
                                        placeholder="transparent"
                                        className="flex-1 px-2 py-1 text-sm border rounded"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="block text-xs text-gray-600 mb-1">Padding</label>
                                <input
                                    type="text"
                                    value={styles[index]?.padding || '16px'}
                                    onChange={(e) => updateColumnStyle(index, 'padding', e.target.value)}
                                    placeholder="16px"
                                    className="w-full px-2 py-1 text-sm border rounded"
                                />
                            </div>
                            <div>
                                <label className="block text-xs text-gray-600 mb-1">Borde (ancho)</label>
                                <input
                                    type="text"
                                    value={styles[index]?.borderWidth || '0px'}
                                    onChange={(e) => updateColumnStyle(index, 'borderWidth', e.target.value)}
                                    placeholder="0px"
                                    className="w-full px-2 py-1 text-sm border rounded"
                                />
                            </div>
                            <div>
                                <label className="block text-xs text-gray-600 mb-1">Color de borde</label>
                                <div className="flex gap-2">
                                    <input
                                        type="color"
                                        value={styles[index]?.borderColor || '#e5e7eb'}
                                        onChange={(e) => updateColumnStyle(index, 'borderColor', e.target.value)}
                                        className="w-10 h-8 border rounded cursor-pointer"
                                    />
                                    <input
                                        type="text"
                                        value={styles[index]?.borderColor || '#e5e7eb'}
                                        onChange={(e) => updateColumnStyle(index, 'borderColor', e.target.value)}
                                        className="flex-1 px-2 py-1 text-sm border rounded"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="block text-xs text-gray-600 mb-1">Radio de borde</label>
                                <input
                                    type="text"
                                    value={styles[index]?.borderRadius || '0px'}
                                    onChange={(e) => updateColumnStyle(index, 'borderRadius', e.target.value)}
                                    placeholder="0px"
                                    className="w-full px-2 py-1 text-sm border rounded"
                                />
                            </div>
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
};

// Column Distribution Control - buttons for count + slider for widths
interface ColumnDistribution {
    columnCount: number;
    widths: number[]; // percentages that sum to 100
}

const ColumnDistributionControl = ({ value, onChange }: {
    value: ColumnDistribution;
    onChange: (distribution: ColumnDistribution) => void;
}) => {
    const distribution = value || { columnCount: 2, widths: [50, 50] };
    const { columnCount, widths } = distribution;

    // Colors for each column section
    const colors = ['#f97316', '#22c55e', '#3b82f6']; // orange, green, blue

    // Handle column count change
    const handleColumnCountChange = (newCount: number) => {
        let newWidths: number[];
        if (newCount === 1) {
            newWidths = [100];
        } else if (newCount === 2) {
            newWidths = [50, 50];
        } else {
            newWidths = [35, 30, 35];
        }
        onChange({ columnCount: newCount, widths: newWidths });
    };

    // Snap to increments of 5
    const snapToStep = (value: number) => Math.round(value / 5) * 5;

    // Handle slider drag - calculate new widths based on handle positions
    const handleSliderChange = (handleIndex: number, newPosition: number) => {
        const newWidths = [...widths];
        const snappedPosition = snapToStep(newPosition);

        if (columnCount === 2) {
            // Single handle - position is the first column width (min 10%, max 90%)
            newWidths[0] = Math.max(10, Math.min(90, snappedPosition));
            newWidths[1] = 100 - newWidths[0];
        } else if (columnCount === 3) {
            // Two handles - each column must be at least 10%
            if (handleIndex === 0) {
                // First handle - can't go past (second handle position - 10%)
                const maxPos = (widths[0] + widths[1]) - 10;
                newWidths[0] = Math.max(10, Math.min(snapToStep(maxPos), snappedPosition));
                newWidths[1] = (widths[0] + widths[1]) - newWidths[0];
                // Ensure middle column is at least 10%
                if (newWidths[1] < 10) {
                    newWidths[1] = 10;
                    newWidths[0] = (widths[0] + widths[1]) - 10;
                }
            } else {
                // Second handle - position from start
                const minPos = widths[0] + 10;
                const adjustedPos = Math.max(snapToStep(minPos), Math.min(90, snappedPosition));
                newWidths[1] = adjustedPos - widths[0];
                newWidths[2] = 100 - adjustedPos;
                // Ensure last column is at least 10%
                if (newWidths[2] < 10) {
                    newWidths[2] = 10;
                    newWidths[1] = 90 - widths[0];
                }
            }
        }

        onChange({ columnCount, widths: newWidths });
    };

    // Calculate handle positions for rendering
    const getHandlePositions = () => {
        if (columnCount === 2) {
            return [widths[0]];
        } else if (columnCount === 3) {
            return [widths[0], widths[0] + widths[1]];
        }
        return [];
    };

    const handlePositions = getHandlePositions();

    return (
        <div className="space-y-4">
            {/* Column count buttons */}
            <div className="flex gap-2">
                {[1, 2, 3].map((count) => (
                    <button
                        key={count}
                        type="button"
                        onClick={() => handleColumnCountChange(count)}
                        className={`flex-1 py-2 px-4 rounded-md font-medium transition-colors ${columnCount === count
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                            }`}
                    >
                        {count}
                    </button>
                ))}
            </div>

            {/* Distribution slider */}
            {columnCount > 1 && (
                <div className="space-y-2">
                    <div className="text-xs text-gray-500 flex justify-between">
                        {widths.map((w, i) => (
                            <span key={i}>Col {i + 1}: {Math.round(w)}%</span>
                        ))}
                    </div>

                    {/* Slider track */}
                    <div
                        className="relative h-8 rounded-full overflow-hidden cursor-pointer"
                        onMouseDown={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            const position = ((e.clientX - rect.left) / rect.width) * 100;

                            // Find closest handle
                            let closestHandle = 0;
                            let minDistance = Math.abs(handlePositions[0] - position);
                            handlePositions.forEach((pos, i) => {
                                const distance = Math.abs(pos - position);
                                if (distance < minDistance) {
                                    minDistance = distance;
                                    closestHandle = i;
                                }
                            });

                            handleSliderChange(closestHandle, position);

                            // Setup drag
                            const handleDrag = (moveEvent: MouseEvent) => {
                                const newPos = ((moveEvent.clientX - rect.left) / rect.width) * 100;
                                handleSliderChange(closestHandle, newPos);
                            };

                            const handleUp = () => {
                                document.removeEventListener('mousemove', handleDrag);
                                document.removeEventListener('mouseup', handleUp);
                            };

                            document.addEventListener('mousemove', handleDrag);
                            document.addEventListener('mouseup', handleUp);
                        }}
                    >
                        {/* Colored sections */}
                        <div className="absolute inset-0 flex">
                            {widths.map((width, i) => (
                                <div
                                    key={i}
                                    style={{
                                        width: `${width}%`,
                                        backgroundColor: colors[i],
                                        opacity: 0.7
                                    }}
                                />
                            ))}
                        </div>

                        {/* Handles */}
                        {handlePositions.map((pos, i) => (
                            <div
                                key={i}
                                className="absolute top-1/2 -translate-y-1/2 w-6 h-6 bg-white border-2 border-gray-800 rounded-full shadow-md cursor-grab active:cursor-grabbing z-10"
                                style={{ left: `calc(${pos}% - 12px)` }}
                            >
                                <div className="absolute inset-2 bg-gray-800 rounded-full" />
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

// Memoized Rich Text Editor - prevents re-renders when parent state changes
export const RichTextEditor = React.memo(({ value, onChange, onSave, onCancel, transparent = false }: {
    value: string;
    onChange: (html: string) => void;
    onSave?: () => void;
    onCancel?: () => void;
    transparent?: boolean;
}) => {
    const editorRef = React.useRef<HTMLDivElement>(null);
    const savedSelectionRef = React.useRef<Range | null>(null);
    const [editorBg, setEditorBg] = React.useState(transparent ? 'transparent' : '#ffffff');

    const cycleEditorBg = () => {
        const bgs = ['#ffffff', '#1f2937', '#000000', '#f3f4f6'];
        const currentIdx = bgs.indexOf(editorBg);
        setEditorBg(bgs[(currentIdx + 1) % bgs.length]);
    };

    // ... (rest of logic is same, hook deps might change)

    // Set content on mount AND when value changes if not focused
    useEffect(() => {
        if (editorRef.current && document.activeElement !== editorRef.current) {
            if (editorRef.current.innerHTML !== value) {
                editorRef.current.innerHTML = value || '';
            }
        }
    }, [value]);

    useEffect(() => {
        if (editorRef.current) {
            // Prefer semantic tags (<b>, <i>) over inline styles
            try {
                document.execCommand('styleWithCSS', false, 'false');
            } catch (e) { }

            // Auto-focus on mount
            setTimeout(() => {
                editorRef.current?.focus();
            }, 50);
        }
    }, []);

    const saveSelection = () => {
        const doc = editorRef.current?.ownerDocument || document;
        const win = doc.defaultView || window;
        const sel = win.getSelection();

        if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            if (editorRef.current?.contains(range.commonAncestorContainer)) {
                savedSelectionRef.current = range.cloneRange();
            }
        }
    };

    const restoreSelection = () => {
        const doc = editorRef.current?.ownerDocument || document;
        const win = doc.defaultView || window;

        if (savedSelectionRef.current && editorRef.current) {
            editorRef.current.focus();
            const sel = win.getSelection();
            if (sel) {
                sel.removeAllRanges();
                sel.addRange(savedSelectionRef.current);
            }
        }
    };

    const execCmd = (command: string, cmdValue?: string) => {
        const doc = editorRef.current?.ownerDocument || document;
        const win = doc.defaultView || window;

        // Ensure editor is focused first
        if (editorRef.current) {
            editorRef.current.focus();
        }

        // Restore selection if we have one
        restoreSelection();

        // Check if command is enabled
        try {
            const result = doc.execCommand(command, false, cmdValue);

            if (editorRef.current) {
                onChange(editorRef.current.innerHTML);
            }
        } catch (err) {
            console.error(`[RichText] ERROR executing ${command}:`, err);
        }

        saveSelection();
    };

    const [fontSize, setFontSize] = React.useState(16);

    const updateFontSizeFromSelection = React.useCallback(() => {
        const doc = editorRef.current?.ownerDocument || document;
        const win = doc.defaultView || window;
        const sel = win.getSelection();

        if (sel && sel.rangeCount > 0) {
            const node = sel.anchorNode;
            const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
            if (element) {
                const style = win.getComputedStyle(element);
                const size = parseInt(style.fontSize);
                if (size) setFontSize(size);
            }
        }
    }, []);

    const changeFontSize = (delta: number) => {
        restoreSelection();
        const doc = editorRef.current?.ownerDocument || document;
        const win = doc.defaultView || window;
        const sel = win.getSelection();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
            try {
                const anchorEl = sel.anchorNode?.parentElement;
                const computedStyle = anchorEl ? win.getComputedStyle(anchorEl) : null;
                const currentSize = parseInt(computedStyle?.fontSize || fontSize.toString()) || 16;
                const newSize = Math.max(8, currentSize + delta);

                setFontSize(newSize);

                const range = sel.getRangeAt(0);
                const contents = range.extractContents();
                const wrapper = doc.createElement('span');
                wrapper.style.fontSize = `${newSize}px`;
                wrapper.appendChild(contents);
                range.insertNode(wrapper);

                sel.removeAllRanges();
                const newRange = doc.createRange();
                newRange.selectNodeContents(wrapper);
                sel.addRange(newRange);

                if (editorRef.current) {
                    editorRef.current.focus();
                    onChange(editorRef.current.innerHTML);
                }
            } catch (e) {
                console.warn("Font size change failed", e);
            }
        }
        saveSelection();
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        // Crucial: prevent focus loss from the editor
        e.preventDefault();
        e.stopPropagation();
    };

    const ToolbarButton = ({ icon, onClick, title, active = false }: any) => (
        <button
            type="button"
            onMouseDownCapture={(e) => {
                // Stop Puck from seeing this immediately
                e.stopPropagation();
                handleMouseDown(e);
                onClick(e);
            }}
            className={`w-8 h-8 flex items-center justify-center rounded-md transition-all duration-200 ${active
                ? 'bg-blue-50 text-blue-600'
                : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
                }`}
            title={title}
        >
            <i className={`fa-solid ${icon} text-sm`}></i>
        </button>
    );

    return (
        <div
            className={`rich-text-editor-wrapper ${transparent ? 'relative' : 'border border-gray-200 rounded-xl overflow-hidden shadow-sm bg-white group focus-within:ring-2 focus-within:ring-blue-100 focus-within:border-blue-400 transition-all duration-300'}`}
            data-editor-id="rich-text-main"
        >
            {/* Modern Toolbar */}
            <div className={`
                rich-text-toolbar flex flex-wrap items-center gap-1 p-2 border-gray-100
                ${transparent ? 'absolute -top-14 left-0 z-50 bg-white/95 backdrop-blur shadow-xl rounded-lg border w-max' : 'bg-gray-50/50 border-b'}
            `}>
                <div className="flex bg-white rounded-lg border border-gray-100 p-0.5 shadow-sm">
                    <ToolbarButton icon="fa-bold" onClick={() => execCmd('bold')} title="Negrita" />
                    <ToolbarButton icon="fa-italic" onClick={() => execCmd('italic')} title="Cursiva" />
                    <ToolbarButton icon="fa-underline" onClick={() => execCmd('underline')} title="Subrayado" />
                </div>

                <div className="w-px h-6 bg-gray-200 mx-1"></div>

                <div className="flex bg-white rounded-lg border border-gray-100 p-0.5 shadow-sm items-center gap-0.5">
                    <ToolbarButton icon="fa-minus" onClick={() => changeFontSize(-2)} title="Reducir" />
                    <div className="flex items-center px-1 min-w-[32px] justify-center">
                        <span className="text-[11px] font-bold text-gray-600 leading-none">{fontSize}</span>
                        <span className="text-[9px] font-medium text-gray-400 ml-0.5 leading-none">px</span>
                    </div>
                    <ToolbarButton icon="fa-plus" onClick={() => changeFontSize(2)} title="Aumentar" />
                </div>

                <div className="w-px h-6 bg-gray-200 mx-1"></div>

                <div className="flex bg-white rounded-lg border border-gray-100 p-0.5 shadow-sm">
                    <div
                        className="relative w-8 h-8 flex items-center justify-center hover:bg-gray-50 rounded cursor-pointer group/color"
                        onMouseDown={(e) => {
                            // Don't preventDefault here as we need the color picker to open
                            // but do stop propagation to keep Puck away
                            e.stopPropagation();
                        }}
                    >
                        <i className="fa-solid fa-palette text-gray-500 group-hover/color:text-purple-500 transition-colors text-sm"></i>
                        <input
                            type="color"
                            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                            onChange={(e) => {
                                // Important: ensure the editor is focused before running the command
                                execCmd('foreColor', e.target.value);
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                            title="Color de texto"
                        />
                    </div>
                </div>

                <div className="flex bg-white rounded-lg border border-gray-100 p-0.5 shadow-sm">
                    <ToolbarButton icon="fa-align-left" onClick={() => execCmd('justifyLeft')} title="Izquierda" />
                    <ToolbarButton icon="fa-align-center" onClick={() => execCmd('justifyCenter')} title="Centro" />
                    <ToolbarButton icon="fa-align-right" onClick={() => execCmd('justifyRight')} title="Derecha" />
                </div>

                <div className="flex-1"></div>

                <div className="flex items-center gap-1 ml-2 editor-action-buttons">
                    {onCancel && (
                        <button
                            type="button"
                            onMouseDownCapture={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                console.log("[RichText] Cancel clicked");
                                onCancel();
                            }}
                            className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md text-xs font-semibold transition-all border border-gray-200"
                        >
                            Cancelar
                        </button>
                    )}
                    {onSave && (
                        <button
                            type="button"
                            onMouseDownCapture={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                console.log("[RichText] Save clicked");
                                onSave();
                            }}
                            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-xs font-semibold shadow-sm flex items-center gap-1.5 transition-all"
                        >
                            <i className="fa-solid fa-check text-[10px]"></i>
                            Guardar
                        </button>
                    )}
                </div>
            </div>

            {/* Editor Area */}
            <div
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                className="rich-text-content p-4 min-h-[160px] max-h-[400px] overflow-y-auto focus:outline-none text-gray-700 leading-relaxed text-sm selection:bg-blue-100 transition-colors duration-200 !select-text cursor-text"
                style={{ backgroundColor: transparent ? 'transparent' : editorBg }}
                onSelect={() => {
                    saveSelection();
                    updateFontSizeFromSelection();
                }}
                onMouseUp={() => {
                    saveSelection();
                    updateFontSizeFromSelection();
                }}
                onKeyUp={(e) => {
                    saveSelection();
                    updateFontSizeFromSelection();
                }}
                onInput={(e) => {
                    saveSelection();
                    onChange(e.currentTarget.innerHTML);
                }}
                onMouseDownCapture={(e) => {
                    // Block Puck's drag/click while selecting
                    e.stopPropagation();
                }}
                onPointerDownCapture={(e) => {
                    e.stopPropagation();
                }}
                onClickCapture={(e) => {
                    e.stopPropagation();
                }}
                onBlur={(e) => {
                    saveSelection();
                    onChange(e.currentTarget.innerHTML);
                }}
                onKeyDown={(e) => {
                    e.stopPropagation();
                }}
            />
        </div>
    );
});
RichTextEditor.displayName = 'RichTextEditor';


const baseConfig = {
    categories: {
        layout: "Layout",
        content: "Content",
        'Card Gallery': "Card Gallery",
        'Video Gallery': "Video Gallery",
        'Photo Carousel': "Photo Carousel",
    },
    components: {
        Heading: {
            category: "content",
            fields: {
                title: { type: "text" },
                level: {
                    type: "select",
                    options: [
                        { label: "H1", value: "h1" },
                        { label: "H2", value: "h2" },
                        { label: "H3", value: "h3" },
                    ],
                },
                elementId: { type: "text", label: "ID / Ancla (opcional)" },
            },
            defaultProps: {
                title: "Heading",
                level: "h2",
                elementId: "",
            },
            render: ({ title, level, elementId }: any) => {
                const Tag = level as any;
                const sizeClass = level === 'h1' ? 'text-4xl' : level === 'h2' ? 'text-2xl' : 'text-xl';
                return <Tag id={elementId || undefined} className={`font-bold ${sizeClass} my-6 text-gray-900 border-b border-gray-100 pb-2`}>{title}</Tag>;
            },
        },
        Text: {
            category: "content",
            fields: {
                content: { type: "textarea", label: "Content" },
                elementId: { type: "text", label: "ID / Ancla (opcional)" },
            },
            defaultProps: {
                content: "Escribe aquí...",
                elementId: "",
            },
            render: ({ content, elementId }: any) => (
                <div
                    id={elementId || undefined}
                    className="prose max-w-none"
                    dangerouslySetInnerHTML={{ __html: content }}
                />
            ),
        },
        Image: {
            category: "content",
            fields: {
                src: {
                    type: "custom",
                    render: ({ name, onChange, value }: any) => {
                        const [isModalOpen, setIsModalOpen] = useState(false);
                        return (
                            <div className="flex flex-col gap-2">
                                <input
                                    className="p-2 border rounded text-sm w-full"
                                    value={value || ""}
                                    onChange={(e) => onChange(e.target.value)}
                                    placeholder="Image URL"
                                />
                                <button
                                    type="button"
                                    className="px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded text-sm text-gray-700 border"
                                    onClick={() => setIsModalOpen(true)}
                                >
                                    Select from Media
                                </button>
                                <MediaPickerModal
                                    isOpen={isModalOpen}
                                    onClose={() => setIsModalOpen(false)}
                                    onSelect={(item) => {
                                        onChange(item.guid);
                                        setIsModalOpen(false);
                                    }}
                                />
                            </div>
                        );
                    }
                },
                alt: { type: "text" },
                borderRadius: {
                    type: "number",
                    label: "Border Radius (px)"
                },
                elementId: { type: "text", label: "ID / Ancla (opcional)" }
            },
            defaultProps: {
                src: "https://via.placeholder.com/600x400",
                alt: "Image",
                borderRadius: 0,
                elementId: ""
            },
            render: ({ src, alt, borderRadius, elementId }: any) => (
                <img
                    id={elementId || undefined}
                    src={src}
                    alt={alt}
                    style={{ borderRadius: borderRadius ? `${borderRadius}px` : undefined }}
                    className="max-w-full h-auto shadow-sm"
                />
            )
        },
        Columns: {
            category: "layout",
            fields: {
                distribution: {
                    type: "custom",
                    label: "Distribución de columnas",
                    render: ({ value, onChange }: any) => {
                        return (
                            <ColumnDistributionControl
                                value={value}
                                onChange={onChange}
                            />
                        );
                    }
                },
                gap: { type: "number", label: "Espacio entre columnas (px)" },
                minHeight: { type: "text", label: "Altura mínima" },
                backgroundColor: { type: "text", label: "Color de fondo contenedor" },
                borderRadius: { type: "number", label: "Radio de borde contenedor (px)" },
                columnStyles: {
                    type: "custom",
                    label: "Estilos de columnas",
                    render: ({ value, onChange }: any) => {
                        // Get column count from distribution
                        const currentStyles = value || [];
                        return (
                            <ColumnStyleAccordion
                                value={currentStyles}
                                onChange={onChange}
                                columnCount={currentStyles.length || 2}
                            />
                        );
                    }
                },
                "col-0": { type: "slot" },
                "col-1": { type: "slot" },
                "col-2": { type: "slot" },
                elementId: { type: "text", label: "ID / Ancla (opcional)" },
            },
            // Use resolveData to sync columnStyles array with distribution column count
            resolveData: async ({ props }: any) => {
                const distribution = props.distribution || { columnCount: 2, widths: [50, 50] };
                const columnCount = distribution.columnCount || 2;

                // Ensure columnStyles array has correct length
                let columnStyles = props.columnStyles || [];
                const defaultStyle = {
                    backgroundColor: 'transparent',
                    padding: '16px',
                    borderWidth: '0px',
                    borderColor: '#e5e7eb',
                    borderRadius: '0px'
                };

                // Add missing styles
                while (columnStyles.length < columnCount) {
                    columnStyles.push({ ...defaultStyle });
                }
                // Remove extra styles
                columnStyles = columnStyles.slice(0, columnCount);

                return {
                    props: {
                        ...props,
                        columnStyles
                    }
                };
            },
            defaultProps: {
                distribution: { columnCount: 2, widths: [50, 50] },
                gap: 24,
                minHeight: "auto",
                backgroundColor: "transparent",
                borderRadius: 0,
                columnStyles: [
                    { backgroundColor: 'transparent', padding: '16px', borderWidth: '0px', borderColor: '#e5e7eb', borderRadius: '0px' },
                    { backgroundColor: 'transparent', padding: '16px', borderWidth: '0px', borderColor: '#e5e7eb', borderRadius: '0px' }
                ],
                "col-0": [],
                "col-1": [],
                "col-2": [],
                elementId: ""
            },
            render: ({ distribution, gap, minHeight, backgroundColor, borderRadius, columnStyles, elementId, "col-0": Col0, "col-1": Col1, "col-2": Col2 }: any) => {
                // ... same logic
                const Slots = [Col0, Col1, Col2];
                // Convert percentages to grid template columns
                const dist = distribution || { columnCount: 2, widths: [50, 50] };
                const columnCount = dist.columnCount || 2;
                const widths = dist.widths || [50, 50];
                const gridTemplateColumns = widths.slice(0, columnCount).map((w: number) => `${w}%`).join(' ');
                const styles = columnStyles || [];

                // Generate unique ID for responsive styles
                const gridId = `columns-grid-${Math.random().toString(36).substr(2, 9)}`;

                return (
                    <>
                        {/* Responsive CSS - stack columns on mobile */}
                        <style>{`
                            @media (max-width: 768px) {
                                .${gridId} {
                                    grid-template-columns: 1fr !important;
                                }
                            }
                        `}</style>
                        <div
                            id={elementId || undefined}
                            className={gridId}
                            style={{
                                display: "grid",
                                gridTemplateColumns: gridTemplateColumns,
                                gap: `${gap}px`,
                                minHeight: minHeight,
                                width: '100%',
                                backgroundColor: backgroundColor || 'transparent',
                                borderRadius: borderRadius ? `${borderRadius}px` : undefined,
                                margin: 0
                            }}
                        >
                            {Array.from({ length: columnCount }).map((_, i) => {
                                const colStyle = styles[i] || {};
                                const Slot = Slots[i];
                                return (
                                    <div
                                        key={i}
                                        className="flex flex-col min-h-[100px]"
                                        style={{
                                            padding: colStyle.padding || '16px',
                                            backgroundColor: colStyle.backgroundColor || 'transparent',
                                            borderWidth: colStyle.borderWidth || '0px',
                                            borderColor: colStyle.borderColor || '#e5e7eb',
                                            borderStyle: colStyle.borderWidth && colStyle.borderWidth !== '0px' ? 'solid' : 'none',
                                            borderRadius: colStyle.borderRadius || '0px'
                                        }}
                                    >
                                        <Slot />
                                    </div>
                                );
                            })}
                        </div>
                    </>
                );
            }
        },
        Button: {
            category: "content",
            fields: {
                label: { type: "text" },
                href: { type: "text" },
                variant: {
                    type: "radio",
                    options: [
                        { label: "Primary", value: "primary" },
                        { label: "Secondary", value: "secondary" },
                        { label: "Outline", value: "outline" }
                    ]
                },
                align: {
                    type: "radio",
                    options: [
                        { label: "Left", value: "left" },
                        { label: "Center", value: "center" },
                        { label: "Right", value: "right" }
                    ]
                }
            },
            defaultProps: {
                label: "Click Me",
                href: "#",
                variant: "primary",
                align: "left"
            },
            render: ({ label, href, variant, align }: any) => {
                const baseClass = "inline-block px-6 py-2 rounded-lg font-medium transition-colors duration-200";
                const variants = {
                    primary: "bg-blue-600 text-white hover:bg-blue-700",
                    secondary: "bg-gray-600 text-white hover:bg-gray-700",
                    outline: "border-2 border-blue-600 text-blue-600 hover:bg-blue-50"
                };
                const alignments = {
                    left: "text-left",
                    center: "text-center",
                    right: "text-right"
                };

                return (
                    <div className={`my-4 ${alignments[align as keyof typeof alignments]}`}>
                        <a
                            href={href}
                            className={`${baseClass} ${variants[variant as keyof typeof variants]}`}
                            onClick={(e) => e.preventDefault()} // Prevent navigation in editor
                        >
                            {label}
                        </a>
                    </div>
                );
            }
        },
        Spacer: {
            category: "layout",
            fields: {
                height: {
                    type: "number",
                    label: "Height (px)"
                }
            },
            defaultProps: {
                height: 24
            },
            render: ({ height }: any) => (
                <div style={{ height: `${height}px` }} />
            )
        },
        ...puckPluginComponents,
    }
};

export const postConfig: any = {
    ...baseConfig,
    root: {
        fields: {
            title: { type: "text", label: "Title" },
            slug: { type: "text", label: "Slug (Permalink)" },
            category: {
                type: "custom",
                label: "Category",
                render: ({ value, onChange }: any) => <CategoryField value={value} onChange={onChange} />
            },
            allowComments: {
                type: "radio",
                label: "Allow Comments",
                options: [
                    { label: "Yes", value: "open" },
                    { label: "No", value: "closed" }
                ]
            }
        },
        render: ({ children, title }: any) => {
            return (
                <article className="max-w-4xl mx-auto py-12 px-4">
                    <div className="mb-12 text-center">
                        {title && (
                            <h1 className="text-4xl md:text-5xl font-bold text-gray-900 leading-tight mb-6">
                                {title}
                            </h1>
                        )}
                    </div>
                    <div className="bg-white p-8 md:p-12 rounded-2xl shadow-sm border border-gray-100">
                        <div className="puck-children">
                            {children}
                        </div>
                    </div>
                </article>
            );
        }
    }
};

export const pageConfig: any = {
    ...baseConfig,
    root: {
        fields: {
            title: { type: "text", label: "Title" },
            slug: { type: "text", label: "Slug (Permalink)" },
        },
        render: ({ children, title }: any) => {
            return (
                <div className="container mx-auto px-4">
                    {/* Full width within container, components can break out if needed */}
                    <div className="puck-children w-full">
                        {children}
                    </div>
                </div>
            );
        }
    }
};

// Default export for backward compatibility if needed, though mostly used named imports now
export const puckConfig = postConfig;
