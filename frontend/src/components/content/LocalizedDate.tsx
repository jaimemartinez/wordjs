"use client";
/**
 * Hydration-safe date: the server (and first client render) show the deterministic ISO slice so
 * SSR markup matches; after mount it localizes to the visitor's locale — exactly the behavior the
 * old client PostContent had, packaged as the smallest possible island.
 */
import { useEffect, useState } from "react";

export default function LocalizedDate({ date }: { date?: string | null }) {
    const [dateStr, setDateStr] = useState(() => (date ? String(date).slice(0, 10) : ""));
    useEffect(() => {
        if (date) setDateStr(new Date(date).toLocaleDateString());
    }, [date]);
    return <>{dateStr}</>;
}
