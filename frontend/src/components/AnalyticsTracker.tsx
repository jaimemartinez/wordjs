"use client";

import { useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

export function AnalyticsTracker() {
    const pathname = usePathname();
    const searchParams = useSearchParams();
    // Use ref to debounce or prevent double-firing in Strict Mode
    const lastTracked = useRef<string>('');

    useEffect(() => {
        const url = `${pathname}${searchParams.toString() ? '?' + searchParams.toString() : ''}`;

        // Simple logic to avoid double-tracking the exact same URL instantly (Strict Mode quirk)
        if (lastTracked.current === url) return;
        lastTracked.current = url;

        // Fire and forget
        const track = async () => {
            try {
                // We use the raw fetch here or api helper. 
                // Since this is public, we might not need auth headers, but if `api` handles it, great.
                // The backend /track endpoint is public (no authenticate middleware).

                await fetch('/api/v1/analytics/track', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'page_view',
                        resource: url
                    })
                });
            } catch (e) {
                // Ignore tracking errors
            }
        };

        track();
    }, [pathname, searchParams]);

    return null;
}
