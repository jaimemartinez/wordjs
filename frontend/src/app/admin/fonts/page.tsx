'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { PageHeader, EmptyState, Button } from '@/components/ui';

// --- FontFamilyCard Component ---
interface FontVariant {
    family: string;
    variant: string;
    url: string;
    filename: string;
    protected: boolean;
}

interface FontFamilyCardProps {
    family: string;
    variants: FontVariant[];
    isSystem: boolean;
    onDelete: (filename: string) => void;
}

const FontFamilyCard = ({ family, variants, isSystem, onDelete }: FontFamilyCardProps) => {
    // Sort variants: Regular/Normal first, then by name
    const sortedVariants = [...variants].sort((a, b) => {
        const priority = ['regular', 'normal', 'medium', 'bold', 'light'];
        const aIndex = priority.indexOf(a.variant.toLowerCase());
        const bIndex = priority.indexOf(b.variant.toLowerCase());

        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;
        return a.variant.localeCompare(b.variant);
    });

    const [activeVariant, setActiveVariant] = useState<FontVariant>(sortedVariants[0]);

    // Update active variant if variants list changes (e.g. after deletion)
    useEffect(() => {
        if (!variants.find(v => v.filename === activeVariant.filename)) {
            setActiveVariant(sortedVariants[0] || null);
        }
    }, [variants, activeVariant.filename, sortedVariants]);

    if (!activeVariant) return null;

    return (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden hover:shadow-md transition-shadow flex flex-col h-full">
            {/* Header */}
            <div className="p-5 border-b border-gray-100 flex justify-between items-start bg-gray-50/50">
                <div>
                    <h3 className="text-xl font-bold text-gray-900 leading-tight">{family}</h3>
                    <p className="text-sm text-gray-500 mt-1">{variants.length} style{variants.length !== 1 ? 's' : ''} available</p>
                </div>
                {isSystem && (
                    <span className="text-[10px] font-bold bg-amber-100 text-amber-700 px-2 py-1 rounded border border-amber-200 flex items-center gap-1.5 shadow-sm">
                        <i className="fa-solid fa-lock text-[8px]"></i> SYSTEM
                    </span>
                )}
            </div>

            {/* Preview Area */}
            <div className="p-8 flex-1 flex items-center justify-center min-h-[160px] bg-white relative group">
                <div className="text-center w-full">
                    <p
                        className="text-4xl md:text-5xl text-gray-800 transition-all duration-300 break-words leading-tight"
                        style={{
                            fontFamily: activeVariant.family,
                            fontWeight: activeVariant.variant.toLowerCase().includes('bold') ? 700 : activeVariant.variant.toLowerCase().includes('light') ? 300 : activeVariant.variant.toLowerCase().includes('medium') ? 500 : 400,
                            fontStyle: activeVariant.variant.toLowerCase().includes('italic') ? 'italic' : 'normal'
                        }}
                    >
                        Aa
                    </p>
                    <p className="mt-4 text-lg text-gray-400 font-light truncate px-4">The quick brown fox jumps over the lazy dog</p>

                    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-gray-900/80 text-white text-xs px-2 py-1 rounded backdrop-blur-sm pointer-events-none">
                        Now showing: {activeVariant.variant}
                    </div>
                </div>
            </div>

            {/* Variants Selector */}
            <div className="p-4 bg-gray-50 border-t border-gray-100">
                <div className="flex flex-wrap gap-2">
                    {sortedVariants.map((font) => {
                        const isActive = activeVariant.filename === font.filename;
                        const isProtected = font.protected;

                        return (
                            <div
                                key={font.filename}
                                onClick={() => setActiveVariant(font)}
                                className={`
                                    relative group/pill flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-full text-sm font-medium transition-all cursor-pointer border select-none
                                    ${isActive
                                        ? 'bg-blue-600 text-white border-blue-600 shadow-sm ring-2 ring-blue-100'
                                        : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                                    }
                                `}
                            >
                                <span>{font.variant}</span>

                                {isProtected ? (
                                    <i className={`fa-solid fa-lock text-[10px] ml-1 ${isActive ? 'text-blue-200' : 'text-gray-300'}`}></i>
                                ) : (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onDelete(font.filename);
                                        }}
                                        className={`
                                            w-5 h-5 flex items-center justify-center rounded-full transition-colors ml-1
                                            ${isActive
                                                ? 'hover:bg-blue-500 text-blue-100 hover:text-white'
                                                : 'text-gray-400 hover:text-red-500 hover:bg-red-50'
                                            }
                                        `}
                                        title="Delete variant"
                                    >
                                        <i className="fa-solid fa-xmark text-[10px]"></i>
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

import { apiGet, api, apiDelete } from '@/lib/api';
import { useModal } from "@/contexts/ModalContext";

// ... (imports remain)

export default function FontsPage() {
    const [fonts, setFonts] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const { alert, confirm } = useModal();

    const fetchFonts = useCallback(async () => {
        setLoading(true);
        try {
            const data = await apiGet<any[]>('/fonts');
            setFonts(data);

            // Inject font styles for preview
            data.forEach((font: any) => {
                const styleId = `font-preview-${font.filename}`;
                if (!document.getElementById(styleId)) {
                    const style = document.createElement('style');
                    style.id = styleId;
                    style.textContent = `
                        @font-face {
                            font-family: '${font.family}';
                            src: url('${font.url}');
                        }
                    `;
                    document.head.appendChild(style);
                }
            });
        } catch (error) {
            console.error('Error fetching fonts:', error);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchFonts();
    }, [fetchFonts]);

    const onDrop = useCallback(async (acceptedFiles: File[]) => {
        setUploading(true);
        try {
            for (const file of acceptedFiles) {
                const formData = new FormData();
                formData.append('file', file);

                // Use api helper which handles FormData and Auth automatically
                await api('/fonts', {
                    method: 'POST',
                    body: formData
                });
            }
            await fetchFonts();
        } catch (err: any) {
            console.error(err);
            await alert(`Upload failed: ${err.message}`);
        } finally {
            setUploading(false);
        }
    }, [fetchFonts]);

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
        onDrop,
        accept: {
            'font/ttf': ['.ttf'],
            'font/otf': ['.otf'],
            'font/woff': ['.woff'],
            'font/woff2': ['.woff2']
        }
    });

    const deleteFont = async (filename: string) => {
        if (!await confirm('Are you sure you want to delete this font variant?', 'Delete Font', true)) return;

        try {
            await apiDelete(`/fonts/${filename}`);

            // Remove style tag
            const styleId = `font-preview-${filename}`;
            const styleEl = document.getElementById(styleId);
            if (styleEl) styleEl.remove();

            fetchFonts();
        } catch (err) {
            console.error(err);
            await alert('Failed to delete font');
        }
    };

    // Filter fonts based on search query
    const filteredFonts = React.useMemo(() => {
        if (!searchQuery) return fonts;
        const lowerQuery = searchQuery.toLowerCase();
        return fonts.filter(font =>
            font.family.toLowerCase().includes(lowerQuery) ||
            font.variant.toLowerCase().includes(lowerQuery)
        );
    }, [fonts, searchQuery]);

    // Group fonts by family
    const groupedFonts = React.useMemo(() => {
        const groups: Record<string, typeof fonts> = {};
        filteredFonts.forEach(font => {
            if (!groups[font.family]) {
                groups[font.family] = [];
            }
            groups[font.family].push(font);
        });
        return groups;
    }, [filteredFonts]);

    // Helper to determine if a family is protected (if any variant is protected)
    const isFamilyProtected = (familyFonts: typeof fonts) => {
        return familyFonts.some(f => f.protected);
    };

    return (
        <div className="flex-1 bg-gray-50/50 h-full overflow-y-auto p-8 md:p-12 animate-in fade-in duration-500">
            <div className="max-w-6xl mx-auto space-y-8">
                {/* Header */}
                <PageHeader
                    title="Font Manager"
                    subtitle="Manage custom typefaces and system typography"
                    actions={
                        <div className="relative w-full md:w-72">
                            <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"></i>
                            <input
                                type="text"
                                placeholder="Search fonts..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full pl-12 pr-4 py-4 bg-white border-2 border-gray-100 rounded-2xl focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500 transition-all font-medium"
                            />
                        </div>
                    }
                />

                {/* Upload Area */}
                <div
                    {...getRootProps()}
                    className={`border-2 border-dashed rounded-2xl p-10 text-center transition-all cursor-pointer group ${isDragActive
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-white border-gray-200 hover:border-gray-300 hover:bg-white shadow-sm'
                        }`}
                >
                    <input {...getInputProps()} />
                    <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4 group-hover:scale-110 transition-transform">
                        <i className="fa-solid fa-cloud-arrow-up text-2xl"></i>
                    </div>
                    {uploading ? (
                        <p className="text-blue-600 font-bold animate-pulse">Uploading fonts...</p>
                    ) : (
                        <>
                            <p className="text-lg font-bold text-gray-700">Drop font files here</p>
                            <p className="text-sm text-gray-400 mt-1">Supports TTF, OTF, WOFF, WOFF2</p>
                        </>
                    )}
                </div>

                {/* Font List Groups */}
                <div className="space-y-6">
                    <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                        Installed Families
                        <span className="bg-gray-200 text-gray-600 text-xs px-2 py-0.5 rounded-full">{Object.keys(groupedFonts).length}</span>
                    </h2>

                    {Object.entries(groupedFonts).length === 0 ? (
                        <div className="text-center py-20 bg-white rounded-2xl border border-gray-200 border-dashed">
                            <i className="fa-regular fa-folder-open text-4xl text-gray-300 mb-4 block"></i>
                            <p className="text-gray-400 font-medium">No fonts installed yet.</p>
                            <p className="text-sm text-gray-300">Upload some files to get started.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            {Object.entries(groupedFonts).map(([family, variants]) => (
                                <FontFamilyCard
                                    key={family}
                                    family={family}
                                    variants={variants}
                                    isSystem={isFamilyProtected(variants)}
                                    onDelete={deleteFont}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
