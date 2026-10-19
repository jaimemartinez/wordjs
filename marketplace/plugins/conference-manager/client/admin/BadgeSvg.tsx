// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * The badge (2.19.0), drawn from the server's DISPLAY LIST (lib/badges.ts DisplayList). The core portal's
 * credential pages draw it with their own copy (frontend/src/app/portal/conference/badge/BadgeCard.tsx — a plugin
 * bundle cannot import it); a test keeps the two producing the SAME markup, and the PDF prints the same list.
 * 2.29.0: free-form designs — ellipses, lines, strokes, images (clipped, rounded or circular), the shipped
 * typefaces (fetched once from /public/badge/font and registered with the browser), rotation and opacity.
 */
import React, { useEffect, useId } from "react";

type Common = { rot?: number; cx?: number; cy?: number; op?: number; el?: string };
export type DisplayItem =
    | ({ t: "rect" | "ellipse"; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; sw?: number; r?: number } & Common)
    | ({ t: "line"; x1: number; y1: number; x2: number; y2: number; stroke: string; sw: number } & Common)
    | ({ t: "image"; sha: string; x: number; y: number; w: number; h: number; dx: number; dy: number; dw: number; dh: number; r?: number; clip?: "ellipse" } & Common)
    | ({ t: "text"; x: number; y: number; size: number; bold: boolean; fill: string; text: string; face?: string | null; ls?: number } & Common)
    | ({ t: "qr"; x: number; y: number; module: number; size: number; rows: string[] } & Common);
export type DisplayList = {
    version?: number; layout: string; w_mm: number; h_mm: number; background: string; plate: { sha: string } | null;
    items: DisplayItem[]; faces?: string[]; images?: string[];
};

const PT_MM = 25.4 / 72;
const HELVETICA = "Helvetica, Arial, 'Liberation Sans', sans-serif";
const FONT_API = "/api/v1/plugin/conference-manager/public/badge/font";

/** The CSS family a shipped face is registered under. */
export const badgeFontFamily = (face: string) => `cmb-${face}`;

// Each face fetched and registered once per page; the SVG repaints by itself when it arrives.
const facePromises = new Map<string, Promise<boolean>>();
/** Register a shipped face with the browser (FontFace API); resolves false when it cannot. */
export function loadBadgeFace(face: string): Promise<boolean> {
    if (!/^[a-z]+-(400|700)$/.test(face) || typeof window === "undefined" || typeof FontFace === "undefined") return Promise.resolve(false);
    let p = facePromises.get(face);
    if (!p) {
        p = (async () => {
            try {
                const res = await fetch(`${FONT_API}?f=${encodeURIComponent(face)}`, { credentials: "omit" });
                if (!res.ok) return false;
                const { b64 } = await res.json();
                const bin = atob(String(b64 || ""));
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const ff = new FontFace(badgeFontFamily(face), bytes.buffer);
                await ff.load();
                document.fonts.add(ff);
                return true;
            } catch { return false; }
        })();
        facePromises.set(face, p);
        p.then((ok) => { if (!ok) facePromises.delete(face); });
    }
    return p;
}

/** A face another loader already registered (the plugin's designer, which also parses it): never fetched twice. */
export function adoptBadgeFace(face: string, loaded: Promise<boolean>) {
    if (!facePromises.has(face)) facePromises.set(face, loaded);
}

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

/** Rotation and opacity of an item, as attributes of the group around it (none when it has neither). */
function wrap(it: Common, key: string, node: React.ReactNode): React.ReactNode {
    const transform = it.rot ? `rotate(${it.rot} ${it.cx ?? 0} ${it.cy ?? 0})` : undefined;
    const opacity = it.op != null && it.op < 1 ? it.op : undefined;
    if (!transform && opacity == null) return <React.Fragment key={key}>{node}</React.Fragment>;
    return <g key={key} transform={transform} opacity={opacity}>{node}</g>;
}

/**
 * `plate` = a v1 design's plate image (data URL) or null; `images` = a free-form design's images (id → data URL).
 */
export function BadgeSvg({ badge, plate, images, title, className }: { badge: DisplayList; plate?: string | null; images?: Record<string, string> | null; title?: string; className?: string }) {
    const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
    const faces = (badge.faces || []).join(",");
    useEffect(() => { for (const f of faces ? faces.split(",") : []) loadBadgeFace(f); }, [faces]);
    const defs: React.ReactNode[] = [];
    const body = badge.items.map((it, i) => {
        const key = `i${i}`;
        if (it.t === "rect" || it.t === "ellipse") {
            const fill = it.fill || "none";
            const stroke = it.stroke && it.sw ? { stroke: it.stroke, strokeWidth: it.sw } : {};
            return wrap(it, key, it.t === "ellipse"
                ? <ellipse cx={round(it.x + it.w / 2)} cy={round(it.y + it.h / 2)} rx={round(it.w / 2)} ry={round(it.h / 2)} fill={fill} {...stroke} />
                : <rect x={it.x} y={it.y} width={it.w} height={it.h} rx={it.r || 0} fill={fill} {...stroke} />);
        }
        if (it.t === "line") return wrap(it, key, <line x1={it.x1} y1={it.y1} x2={it.x2} y2={it.y2} stroke={it.stroke} strokeWidth={it.sw} />);
        if (it.t === "image") {
            const href = images && images[it.sha];
            if (!href) return null;
            const clipId = `${uid}c${i}`;
            defs.push(
                <clipPath key={clipId} id={clipId}>
                    {it.clip === "ellipse"
                        ? <ellipse cx={round(it.x + it.w / 2)} cy={round(it.y + it.h / 2)} rx={round(it.w / 2)} ry={round(it.h / 2)} />
                        : <rect x={it.x} y={it.y} width={it.w} height={it.h} rx={it.r || 0} />}
                </clipPath>,
            );
            return wrap(it, key, <image href={href} x={it.dx} y={it.dy} width={it.dw} height={it.dh} preserveAspectRatio="none" clipPath={`url(#${clipId})`} />);
        }
        if (it.t === "text") {
            const face = it.face || null;
            return wrap(it, key, (
                <text x={it.x} y={it.y} fill={it.fill} fontSize={it.size * PT_MM} fontWeight={face ? 400 : it.bold ? 700 : 400}
                    fontFamily={face ? `'${badgeFontFamily(face)}', ${HELVETICA}` : HELVETICA}
                    letterSpacing={it.ls ? round(it.ls * PT_MM) : undefined}
                    style={face ? { whiteSpace: "pre", fontKerning: "none" } : { whiteSpace: "pre" }}>{it.text}</text>
            ));
        }
        if (it.t === "qr") {
            return wrap(it, key, (
                <g shapeRendering="crispEdges" data-badge-qr="">
                    {qrRuns(it.rows).map(([x, y, w]) => <rect key={`q${y}-${x}`} x={round(it.x + x * it.module)} y={round(it.y + y * it.module)} width={round(w * it.module)} height={round(it.module)} fill="#000" />)}
                </g>
            ));
        }
        return null;
    });
    return (
        <svg viewBox={`0 0 ${badge.w_mm} ${badge.h_mm}`} className={className} role="img" aria-label={title || "Escarapela"} data-badge-svg="" style={{ display: "block", width: "100%", height: "auto" }}>
            {defs.length > 0 && <defs>{defs}</defs>}
            <rect x={0} y={0} width={badge.w_mm} height={badge.h_mm} fill={badge.background} />
            {plate && <image href={plate} x={0} y={0} width={badge.w_mm} height={badge.h_mm} preserveAspectRatio="none" />}
            {body}
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
