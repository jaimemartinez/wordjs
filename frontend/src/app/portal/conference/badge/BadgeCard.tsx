/**
 * The badge (conference-manager 2.19.0), drawn from the DISPLAY LIST the plugin computes (its
 * server/badge-layout.js: rectangles, text runs and the code's QR in millimetres). The plugin's admin draws the
 * same list with its own copy (client/admin/BadgeSvg.tsx; a test keeps the two equal) and its PDF prints it, so
 * the page, the admin and the PDF agree. Text is drawn in Helvetica / Arial, the metrics it was fitted with on
 * the server. 2.22.0: the code is a QR (one rect per run of dark modules in a row) instead of Code 128 bars.
 */
import React from "react";

export type DisplayItem =
    | { t: "rect"; x: number; y: number; w: number; h: number; fill: string; r?: number }
    | { t: "text"; x: number; y: number; size: number; bold: boolean; fill: string; text: string }
    | { t: "qr"; x: number; y: number; module: number; size: number; rows: string[] };
export type DisplayList = { layout: string; w_mm: number; h_mm: number; background: string; plate: { sha: string } | null; items: DisplayItem[] };

const PT_MM = 25.4 / 72;

/** The dark modules of '0'/'1' rows, one [x, y, width] (in modules) per horizontal run. */
function qrRuns(rows: string[]): [number, number, number][] {
    const runs: [number, number, number][] = [];
    rows.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
            if (row[x] !== "1") continue;
            let w = 1;
            while (x + w < row.length && row[x + w] === "1") w++;
            runs.push([x, y, w]);
            x += w - 1;
        }
    });
    return runs;
}
const round = (n: number) => Math.round(n * 10000) / 10000;

export function BadgeCard({ badge, plate, title }: { badge: DisplayList; plate?: string | null; title?: string }) {
    const qr: React.ReactNode[] = [];
    badge.items.forEach((it, idx) => {
        if (it.t !== "qr") return;
        for (const [x, y, w] of qrRuns(it.rows)) {
            qr.push(<rect key={`q${idx}-${y}-${x}`} x={round(it.x + x * it.module)} y={round(it.y + y * it.module)} width={round(w * it.module)} height={round(it.module)} fill="#000" />);
        }
    });
    return (
        <svg viewBox={`0 0 ${badge.w_mm} ${badge.h_mm}`} role="img" aria-label={title || "Escarapela"} data-badge-svg="" style={{ display: "block", width: "100%", height: "auto" }}>
            <rect x={0} y={0} width={badge.w_mm} height={badge.h_mm} fill={badge.background} />
            {plate && <image href={plate} x={0} y={0} width={badge.w_mm} height={badge.h_mm} preserveAspectRatio="none" />}
            {badge.items.map((it, i) => {
                if (it.t === "rect") return <rect key={i} x={it.x} y={it.y} width={it.w} height={it.h} rx={it.r || 0} fill={it.fill} />;
                if (it.t === "text") return (
                    <text key={i} x={it.x} y={it.y} fill={it.fill} fontSize={it.size * PT_MM} fontWeight={it.bold ? 700 : 400}
                        fontFamily="Helvetica, Arial, 'Liberation Sans', sans-serif" style={{ whiteSpace: "pre" }}>{it.text}</text>
                );
                return null;
            })}
            <g shapeRendering="crispEdges" data-badge-qr="">{qr}</g>
        </svg>
    );
}

/** Only the QR of a badge, large, for the scanner («Mostrar para escanear»): whole modules of `px` pixels. */
export function ScanQr({ badge, px }: { badge: DisplayList; px: number }) {
    const item = badge.items.find((i): i is Extract<DisplayItem, { t: "qr" }> => i.t === "qr");
    if (!item) return null;
    const quiet = 4;
    const side = (item.size + 2 * quiet) * px;
    return (
        <svg width={side} height={side} viewBox={`0 0 ${side} ${side}`} shapeRendering="crispEdges" role="img" aria-label="Código QR" data-scan-qr="" style={{ display: "block", maxWidth: "100%", height: "auto", background: "#fff" }}>
            {qrRuns(item.rows).map(([x, y, w]) => <rect key={`${y}-${x}`} x={(x + quiet) * px} y={(y + quiet) * px} width={w * px} height={px} fill="#000" />)}
        </svg>
    );
}
