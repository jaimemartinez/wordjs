"use client";

import { useState, useEffect } from "react";

interface SEOPanelProps {
    postId?: number;
    title: string;
    excerpt: string;
    slug: string;
    onChange: (seoData: SEOData) => void;
    initialData?: SEOData;
}

export interface SEOData {
    seo_title: string;
    seo_description: string;
    seo_keywords: string;
    og_image: string;
    noindex: boolean;
}

export default function SEOPanel({
    postId,
    title,
    excerpt,
    slug,
    onChange,
    initialData
}: SEOPanelProps) {
    const [seoData, setSeoData] = useState<SEOData>({
        seo_title: initialData?.seo_title || "",
        seo_description: initialData?.seo_description || "",
        seo_keywords: initialData?.seo_keywords || "",
        og_image: initialData?.og_image || "",
        noindex: initialData?.noindex || false
    });

    const [showAdvanced, setShowAdvanced] = useState(false);

    // Auto-fill from post data if empty
    useEffect(() => {
        if (!seoData.seo_title && title) {
            handleChange("seo_title", title);
        }
        if (!seoData.seo_description && excerpt) {
            handleChange("seo_description", excerpt.substring(0, 160));
        }
    }, [title, excerpt]);

    const handleChange = (field: keyof SEOData, value: string | boolean) => {
        const newData = { ...seoData, [field]: value };
        setSeoData(newData);
        onChange(newData);
    };

    // Generate preview URL
    const previewUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/blog/${slug || 'post-slug'}`;

    // Character counts
    const titleLength = (seoData.seo_title || title).length;
    const descLength = (seoData.seo_description || excerpt).length;

    const titleColor = titleLength > 60 ? "text-red-500" : titleLength > 50 ? "text-yellow-500" : "text-green-500";
    const descColor = descLength > 160 ? "text-red-500" : descLength > 140 ? "text-yellow-500" : "text-green-500";

    return (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                SEO
            </h3>

            {/* Google Preview */}
            <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border">
                <p className="text-xs text-gray-500 mb-2">Vista previa de Google</p>
                <div className="space-y-1">
                    <p className="text-blue-600 dark:text-blue-400 text-lg hover:underline cursor-pointer truncate">
                        {seoData.seo_title || title || "Título del post"}
                    </p>
                    <p className="text-green-700 dark:text-green-500 text-sm truncate">
                        {previewUrl}
                    </p>
                    <p className="text-gray-600 dark:text-gray-400 text-sm line-clamp-2">
                        {seoData.seo_description || excerpt || "Descripción del post aparecerá aquí..."}
                    </p>
                </div>
            </div>

            {/* SEO Title */}
            <div className="mb-4">
                <label className="block text-sm font-medium mb-1">
                    Título SEO
                    <span className={`ml-2 text-xs ${titleColor}`}>
                        ({titleLength}/60)
                    </span>
                </label>
                <input
                    type="text"
                    value={seoData.seo_title}
                    onChange={(e) => handleChange("seo_title", e.target.value)}
                    placeholder={title || "Título para buscadores"}
                    className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600"
                    maxLength={70}
                />
            </div>

            {/* Meta Description */}
            <div className="mb-4">
                <label className="block text-sm font-medium mb-1">
                    Meta Descripción
                    <span className={`ml-2 text-xs ${descColor}`}>
                        ({descLength}/160)
                    </span>
                </label>
                <textarea
                    value={seoData.seo_description}
                    onChange={(e) => handleChange("seo_description", e.target.value)}
                    placeholder={excerpt || "Descripción para buscadores"}
                    className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 resize-none"
                    rows={3}
                    maxLength={200}
                />
            </div>

            {/* Advanced Toggle */}
            <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-sm text-blue-600 hover:text-blue-800 mb-4"
            >
                {showAdvanced ? "▼ Ocultar opciones avanzadas" : "▶ Mostrar opciones avanzadas"}
            </button>

            {showAdvanced && (
                <div className="space-y-4 pt-2 border-t">
                    {/* Keywords */}
                    <div>
                        <label className="block text-sm font-medium mb-1">
                            Palabras clave
                        </label>
                        <input
                            type="text"
                            value={seoData.seo_keywords}
                            onChange={(e) => handleChange("seo_keywords", e.target.value)}
                            placeholder="palabra1, palabra2, palabra3"
                            className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600"
                        />
                        <p className="text-xs text-gray-500 mt-1">Separadas por comas (opcional)</p>
                    </div>

                    {/* OG Image */}
                    <div>
                        <label className="block text-sm font-medium mb-1">
                            Imagen para redes sociales
                        </label>
                        <input
                            type="text"
                            value={seoData.og_image}
                            onChange={(e) => handleChange("og_image", e.target.value)}
                            placeholder="https://ejemplo.com/imagen.jpg"
                            className="w-full px-3 py-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600"
                        />
                        <p className="text-xs text-gray-500 mt-1">URL de imagen para Open Graph (1200x630px recomendado)</p>
                    </div>

                    {/* Noindex Toggle */}
                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id="noindex"
                            checked={seoData.noindex}
                            onChange={(e) => handleChange("noindex", e.target.checked)}
                            className="w-4 h-4"
                        />
                        <label htmlFor="noindex" className="text-sm">
                            Ocultar de buscadores (noindex)
                        </label>
                    </div>
                </div>
            )}
        </div>
    );
}
