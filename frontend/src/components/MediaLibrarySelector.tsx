"use client";

import { useEffect, useState } from "react";
import { mediaApi, MediaItem } from "@/lib/api";

interface MediaLibrarySelectorProps {
    onSelect: (item: MediaItem) => void;
    selectedId?: number | null;
}

export default function MediaLibrarySelector({ onSelect, selectedId }: MediaLibrarySelectorProps) {
    const [media, setMedia] = useState<MediaItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");

    useEffect(() => {
        loadMedia();
    }, []);

    const loadMedia = async () => {
        try {
            const data = await mediaApi.list();
            setMedia(data);
        } catch (error) {
            console.error("Failed to load media:", error);
        } finally {
            setLoading(false);
        }
    };

    const filteredMedia = media.filter(item =>
        item.title.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="flex flex-col h-full bg-white rounded-lg">
            {/* Toolbar */}
            <div className="p-4 border-b flex justify-between items-center bg-gray-50 rounded-t-lg">
                <input
                    type="text"
                    placeholder="Search media..."
                    className="px-3 py-2 border rounded-md text-sm w-full max-w-xs"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
                <button
                    onClick={loadMedia}
                    className="text-gray-500 hover:text-blue-600"
                    title="Refresh"
                >
                    <i className="fa-solid fa-sync"></i>
                </button>
            </div>

            {/* Grid */}
            <div className="flex-1 overflow-y-auto p-4 min-h-[300px] max-h-[500px]">
                {loading ? (
                    <div className="flex justify-center items-center h-40">
                        <i className="fa-solid fa-circle-notch fa-spin text-4xl text-gray-300"></i>
                    </div>
                ) : filteredMedia.length === 0 ? (
                    <div className="text-center text-gray-400 py-10">
                        <i className="fa-solid fa-images text-4xl mb-2"></i>
                        <p>No media found.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                        {filteredMedia.map((item) => (
                            <div
                                key={item.id}
                                onClick={() => onSelect(item)}
                                className={`
                                    group relative aspect-square bg-gray-100 rounded-lg overflow-hidden cursor-pointer border-2 transition-all
                                    ${selectedId === item.id ? 'border-blue-500 ring-2 ring-blue-200' : 'border-transparent hover:border-gray-300'}
                                `}
                            >
                                {item.mimeType.startsWith('image/') ? (
                                    <img src={item.guid} alt={item.title} className="w-full h-full object-cover" />
                                ) : (
                                    <div className="flex items-center justify-center h-full w-full">
                                        <i className="fa-solid fa-file text-4xl text-gray-400"></i>
                                    </div>
                                )}

                                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                    <span className="text-white font-medium text-sm px-2 py-1 bg-black/50 rounded">Select</span>
                                </div>

                                {selectedId === item.id && (
                                    <div className="absolute top-2 right-2 bg-blue-500 text-white w-6 h-6 rounded-full flex items-center justify-center shadow-sm">
                                        <i className="fa-solid fa-check text-xs"></i>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
