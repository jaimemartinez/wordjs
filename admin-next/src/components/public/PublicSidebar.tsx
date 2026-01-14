"use client";

import { useEffect, useState } from "react";
import { widgetsApi } from "@/lib/api";

export default function PublicSidebar({ id, onEmpty }: { id: string, onEmpty?: () => void }) {
    const [html, setHtml] = useState<string>("");
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        widgetsApi.renderSidebar(id)
            .then(html => {
                setHtml(html);
                if (!html && onEmpty) onEmpty();
            })
            .catch(err => console.error("Failed to load sidebar", id, err))
            .finally(() => setLoading(false));
    }, [id, onEmpty]);

    if (loading) return <div className="animate-pulse bg-gray-100 h-64 rounded-xl"></div>;
    if (!html) return null;

    return (
        <aside
            className="widget-area space-y-8"
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}
