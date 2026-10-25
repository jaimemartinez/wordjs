// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/** A person's authorization status as a chip with its color and icon (2.36.16, lib/consentStatus). */
import React from "react";
import { STATUS_LOOK } from "../lib/consentStatus";

export function ConsentStatusChip({ status, t, size = "sm" }: { status: string; t: (k: string, v?: any) => string; size?: "sm" | "lg" }) {
    const look = STATUS_LOOK[status] || STATUS_LOOK.none;
    return (
        <span className={`inline-flex items-center gap-1.5 border rounded-full font-bold whitespace-nowrap ${look.tone} ${size === "lg" ? "px-3 py-1 text-sm" : "px-2.5 py-0.5 text-xs"}`} data-consent-status={status}>
            <i className={`fa-solid ${look.icon}`} aria-hidden="true"></i>{t(`ux.status.${status}`)}
        </span>
    );
}

export default ConsentStatusChip;
