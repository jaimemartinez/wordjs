// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * The badge (2.19.0), drawn from the server's DISPLAY LIST (lib/badges.ts DisplayList). The core portal's
 * credential page draws it with its own copy (frontend/src/app/portal/conference/badge/BadgeCard.tsx); a test
 * keeps the two equal, and the PDF prints the same list. 2.22.0: the code is a QR (one rect per run of dark
 * modules in a row).
 */
import React from "react";
import type { DisplayList } from "../lib/badges";

const PT_MM = 25.4 / 72;
/** The badge, drawn from its display list. `plate` = the plate image URL (data URL) or null. */
export function BadgeSvg({ badge, plate, className, title }: { badge: DisplayList; plate?: string | null; className?: string; title?: string }) {
    const qr: React.ReactNode[] = [];
    badge.items.forEach((it, idx) => {
        if (it.t !== 'qr') return;
        it.rows.forEach((row, y) => {
            for (let x = 0; x < row.length; x++) {
                if (row[x] !== '1') continue;
                let w = 1;
                while (x + w < row.length && row[x + w] === '1') w++;
                qr.push(<rect key={`q${idx}-${y}-${x}`} x={round(it.x + x * it.module)} y={round(it.y + y * it.module)} width={round(w * it.module)} height={round(it.module)} fill="#000" />);
                x += w - 1;
            }
        });
    });
    return (
        <svg viewBox={`0 0 ${badge.w_mm} ${badge.h_mm}`} className={className} role="img" aria-label={title || 'Escarapela'} data-badge-svg="" style={{ display: 'block', width: '100%', height: 'auto' }}>
            <rect x={0} y={0} width={badge.w_mm} height={badge.h_mm} fill={badge.background} />
            {plate && <image href={plate} x={0} y={0} width={badge.w_mm} height={badge.h_mm} preserveAspectRatio="none" />}
            {badge.items.map((it, i) => {
                if (it.t === 'rect') return <rect key={i} x={it.x} y={it.y} width={it.w} height={it.h} rx={it.r || 0} fill={it.fill} />;
                if (it.t === 'text') return (
                    <text key={i} x={it.x} y={it.y} fill={it.fill} fontSize={it.size * PT_MM} fontWeight={it.bold ? 700 : 400}
                        fontFamily="Helvetica, Arial, 'Liberation Sans', sans-serif" style={{ whiteSpace: 'pre' }}>{it.text}</text>
                );
                return null;
            })}
            <g shapeRendering="crispEdges" data-badge-qr="">{qr}</g>
        </svg>
    );
}

const round = (n: number) => Math.round(n * 10000) / 10000;
