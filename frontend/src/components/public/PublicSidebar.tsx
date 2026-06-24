"use client";

import { useEffect, useState } from "react";
import { widgetsApi } from "@/lib/api";
import { sanitizeHTML } from "@/lib/sanitize";

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

    // Render nothing until content resolves: most widget areas are empty, and a big placeholder would
    // flash on every page. When there are no widgets, stay invisible (no layout shift).
    if (loading || !html) return null;

    return (
        <aside
            className="widget-area space-y-8"
            suppressHydrationWarning
            dangerouslySetInnerHTML={{ __html: sanitizeHTML(html) }}
        />
    );
}
