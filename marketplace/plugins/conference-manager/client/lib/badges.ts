/**
 * «Escarapelas» (2.19.0) — the admin's side: the API, the badge renderer and the PLATE compositor.
 *
 * The server computes each badge as a DISPLAY LIST (server/badge-layout.js: rectangles, text runs and the
 * code's QR modules in millimetres); `BadgeSvg` only draws it, like the PDF and the core portal's credential page
 * (frontend/src/app/portal/conference/badge/BadgeCard.tsx — a test keeps the two renderers equal). Text is
 * drawn in Helvetica / Arial, the metrics the server fitted it with. (The renderer itself is admin/BadgeSvg.tsx.)
 *
 * The PLATE is the card's static layer — background colour or image (cover-cropped), the legibility panel and
 * the logo — composited here on a canvas from the layout's zones, as two JPEGs: `plate_print` (300 dpi, what
 * the PDF embeds) and `plate_screen` (1080 px wide, the credential page). No plate is needed when the design
 * has no image, no logo and no panel: the background colour is filled.
 */
import { apiGet, apiPost, apiPut, apiDelete } from "../../../../../frontend/src/lib/api";

const BASE = '/plugin/conference-manager';

export type BadgeField = { key: string; show_label: boolean; label?: string };
export type BadgeDesign = {
    layout: 'horizontal' | 'vertical';
    title: string;
    colors: { background: string; text: string; label: string; accent: string };
    panel: 'none' | 'light' | 'dark';
    fields: BadgeField[];
};
/** «Mi inscripción» (2.23.0): on / off and the document fields (null = detected by their label). */
export type SelfPagePolicy = { enabled: boolean; type_field: string | null; number_field: string | null };
export type BadgePolicy = { enabled: boolean; portal_enabled: boolean; expires_on: string | null; country_code: string; self_page?: SelfPagePolicy };
export type BadgeConfig = { configured: boolean; design: BadgeDesign; policy: BadgePolicy; rev: number };
export type Zone = { x: number; y: number; w: number; h: number };
export type Zones = { w: number; h: number; logo: Zone; header: Zone; accent: Zone; panel: Zone; name: Zone; lines: Zone; code: Zone };
export type AvailableField = { key: string; label: string; builtin: boolean; type?: string; sensitive?: boolean };
// The display list (v1 layouts and 2.29.0's free-form designs): the renderer's own type.
export type { DisplayItem, DisplayList } from '../admin/BadgeSvg';
import type { DisplayList } from '../admin/BadgeSvg';
export type BadgeLink = { inscription_id: number; token: string; created_at: string | null; view_count: number; last_viewed_at: string | null };
/** Why the links show nothing right now: badges turned off, or past their expiry date (null = they work). */
export type LinksState = 'disabled' | 'expired' | null;

export const badgesApi = {
    getConfig: (conferenceId: number) => apiGet<{ config: BadgeConfig; available_fields: AvailableField[]; assets: { kind: string; sha: string; width: number | null; height: number | null }[]; zones: { horizontal: Zones; vertical: Zones }; max_rows: { horizontal: number; vertical: number }; self_page?: { fields: { name: string; label: string; type: string }[]; type_field: string | null; number_field: string | null; link: string | null } }>(`${BASE}/badges/config?conference_id=${conferenceId}`),
    /** 2.36.0: `sticker` = the printable sticker's design (server/badge-design.js, layout 'sticker'). */
    saveConfig: (conferenceId: number, design: BadgeDesign, policy: BadgePolicy, sticker?: any) => apiPut<{ success: boolean; config: BadgeConfig }>(`${BASE}/badges/config`, { conference_id: conferenceId, design, policy, ...(sticker ? { sticker } : {}) }),
    getAsset: (conferenceId: number, kind: string) => apiGet<{ data_url: string; width: number | null; height: number | null; sha: string }>(`${BASE}/badges/assets/${kind}?conference_id=${conferenceId}`),
    putAsset: (conferenceId: number, kind: string, dataUrl: string, width: number, height: number) => apiPut<{ success: boolean; sha: string }>(`${BASE}/badges/assets`, { conference_id: conferenceId, kind, data_url: dataUrl, width, height }),
    deleteAsset: (conferenceId: number, kind: string) => apiDelete<{ success: boolean }>(`${BASE}/badges/assets?conference_id=${conferenceId}&kind=${encodeURIComponent(kind)}`),
    preview: (conferenceId: number, design?: BadgeDesign | null, inscriptionId?: number | null) => apiPost<{ badge: DisplayList; images?: Record<string, string> }>(`${BASE}/badges/preview`, { conference_id: conferenceId, ...(design ? { design } : {}), ...(inscriptionId ? { inscription_id: inscriptionId } : {}) }),
    /** 2.29.0: one image for the free-form designer (stored once by its content) → its id, as image elements use it. */
    putImage: (conferenceId: number, dataUrl: string, width: number, height: number) => apiPut<{ success: boolean; id: string; width: number; height: number }>(`${BASE}/badges/assets`, { conference_id: conferenceId, kind: 'image', data_url: dataUrl, width, height }),
    /** The links that exist (none is created): the person list refreshes with it after a regenerate or a revoke. */
    existingLinks: (conferenceId: number) => apiGet<{ links: BadgeLink[] }>(`${BASE}/badges/links?conference_id=${conferenceId}`),
    links: (conferenceId: number, scope: { inscription_ids?: number[]; location_id?: number; all?: boolean }) => apiPost<{ links: BadgeLink[]; state: LinksState; country_code: string }>(`${BASE}/badges/links`, { conference_id: conferenceId, ...scope }),
    rotate: (inscriptionId: number) => apiPost<{ link: BadgeLink | null }>(`${BASE}/badges/links/${inscriptionId}/rotate`, {}),
    revoke: (inscriptionId: number) => apiDelete<{ success: boolean }>(`${BASE}/badges/links/${inscriptionId}`),
    /** sheet 'sticker' (2.36.0): the printable stickers, one label per PDF page at the label's exact size. */
    ticket: (conferenceId: number, scope: { inscription_id?: number; inscription_ids?: number[]; location_id?: number; all?: boolean }, sheet: 'single' | 'letter' | 'sticker') =>
        apiPost<{ d: string }>(`${BASE}/badges/ticket`, { conference_id: conferenceId, ...scope, sheet }),
};

/** The credential page of a token — the token in the FRAGMENT, so it never reaches a log or a link preview. */
export const badgeUrl = (token: string, origin?: string): string =>
    `${origin || (typeof window !== 'undefined' ? window.location.origin : '')}/portal/conference/badge#t=${token}`;
/**
 * What is opened, copied and sent for a link (2.28.0): the person's «Mi inscripción» page (`self`, where they
 * confirm their document) — the bare badge link no longer shows a badge.
 */
export const linkUrl = (l: { token: string; self?: string | null }, origin?: string): string =>
    l.self ? `${origin || (typeof window !== 'undefined' ? window.location.origin : '')}${l.self}` : badgeUrl(l.token, origin);
/**
 * The core portal's file route for a ticket: /portal/<the portal's slug>/file (app/portal/[slug]/file). 2.36.3: it
 * was still the pre-2.30 /portal/conference/badge/file, which the portal page answers «no existe», so every PDF
 * button of the admin (badge, sheet, stickers) opened that page instead of the file.
 */
export const badgeFileUrl = (d: string): string => `/portal/conference/file?d=${encodeURIComponent(d)}`;

/**
 * The address links are sent with: the site's public address (Ajustes › siteurl), else this page's origin — an
 * admin working from a LAN address or an alias must not send people a link they cannot open. Read once.
 */
let publicBaseP: Promise<string> | null = null;
export function publicBase(): Promise<string> {
    const here = typeof window !== 'undefined' ? window.location.origin : '';
    if (!publicBaseP) {
        publicBaseP = apiGet<any>('/settings')
            .then((st) => { const u = String((st && (st.siteurl || st.home)) || '').trim(); return /^https?:\/\/[^/\s]+/i.test(u) ? u.replace(/\/+$/, '') : here; })
            .catch(() => here);
    }
    return publicBaseP;
}

/**
 * Open a PDF in a NEW tab: the tab opens now, inside the click (a popup blocker allows that), and goes to the
 * file once the ticket arrives — the admin keeps its page and any unsaved edit. Without a tab (blocked), the
 * file opens through a link in a new tab.
 */
export async function openBadgeFileFrom(ticket: () => Promise<string>): Promise<void> {
    const w = typeof window !== 'undefined' ? window.open('', '_blank') : null;
    try {
        const url = badgeFileUrl(await ticket());
        if (w && !w.closed) { try { w.opener = null; } catch { /* ignore */ } w.location.href = url; return; }
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
    } catch (e) {
        if (w && !w.closed) w.close();
        throw e;
    }
}

/**
 * The WhatsApp number of a phone as typed in the form: the first number of a list («300… / 310…»), its digits,
 * an international «+» / «00» number as it is, a national one given the country code (`cc`, 2.33.2: any national
 * number, its trunk «0» dropped — before, only a 10-digit Colombian mobile). null
 * when nothing usable remains (WhatsApp then opens without a recipient). The portal keeps a copy (badges.ts).
 */
export function waNumber(phone: unknown, cc = '57'): string | null {
    const first = String(phone == null ? '' : phone).split(/[/,;|]|\s+y\s+|\s+o\s+/i)[0] || '';
    let digits = first.replace(/\D/g, '');
    // 2.33.2: «+» / «00» numbers keep their country code; a national one takes `cc` and loses its trunk «0».
    if (first.trim().startsWith('+')) { /* already international */ }
    else if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits) {
        const code = String(cc || '57').replace(/\D/g, '') || '57';
        const national = digits.replace(/^0+/, '');
        // Already carrying the code without «+» («573001234567»): not prefixed twice.
        digits = national.startsWith(code) && national.length >= code.length + 9 ? national : `${code}${national}`;
    }
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
}
/** wa.me with a message, to the person's number when there is one. */
export function whatsappUrl(phone: unknown, text: string, cc = '57'): string {
    const n = waNumber(phone, cc);
    const q = `text=${encodeURIComponent(text)}`;
    return n ? `https://wa.me/${n}?${q}` : `https://wa.me/?${q}`;
}

/**
 * Copy text that is still being fetched — call it IN the click: Safari lets a page write the clipboard only
 * inside the gesture, so the write starts now with a promise of the text (ClipboardItem). Elsewhere it waits and
 * copies. false when nothing could be copied: the caller then shows the text to copy by hand.
 */
export async function copyLater(text: Promise<string>): Promise<boolean> {
    const CI = typeof window !== 'undefined' ? (window as any).ClipboardItem : undefined;
    const clip: any = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    if (CI && clip && typeof clip.write === 'function' && window.isSecureContext) {
        try { await clip.write([new CI({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })]); return true; }
        catch { /* fall back */ }
    }
    try { return await copyText(await text); } catch { return false; }
}

/** Copy to the clipboard, with the old execCommand fallback (an http LAN address has no Clipboard API). */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* fall back */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch { return false; }
}

/** The Web Share sheet (a phone); false when the browser has none (the caller copies instead). */
export async function nativeShare(data: { title?: string; text?: string; url?: string }): Promise<boolean> {
    try {
        if (typeof navigator !== 'undefined' && typeof (navigator as any).share === 'function') { await (navigator as any).share(data); return true; }
    } catch (e: any) {
        if (e && e.name === 'AbortError') return true;     // the person closed the sheet: nothing to fall back to
    }
    return false;
}

// ── images and the plate ──────────────────────────────────────────────────────────────────────────
export function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('No se pudo leer la imagen.'));
        img.src = src;
    });
}
export function readFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(new Error('No se pudo leer el archivo.'));
        r.readAsDataURL(file);
    });
}
/** A source image scaled to fit `max` px (never up), re-encoded: the background as JPEG, the logo as PNG. */
export async function scaledSource(dataUrl: string, max: number, mime: 'image/jpeg' | 'image/png'): Promise<{ url: string; w: number; h: number }> {
    const img = await loadImage(dataUrl);
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    if (mime === 'image/jpeg') { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); }
    g.drawImage(img, 0, 0, w, h);
    return { url: c.toDataURL(mime, 0.86), w, h };
}

export const needsPlate = (design: BadgeDesign, hasBackground: boolean, hasLogo: boolean): boolean =>
    hasBackground || hasLogo || design.panel !== 'none';

/**
 * The plate at `pxPerMm`: background colour, the background image cover-cropped, the legibility panel
 * (rounded, translucent) and the logo contained in its zone. Returns a JPEG data URL.
 */
export function composePlate(design: BadgeDesign, zones: Zones, pxPerMm: number, bg: HTMLImageElement | null, logo: HTMLImageElement | null, quality = 0.9): { url: string; w: number; h: number } {
    const c = composePlateCanvas(design, zones, pxPerMm, bg, logo);
    return { url: c.toDataURL('image/jpeg', quality), w: c.width, h: c.height };
}
/** The plate as a canvas (the contrast check samples it). */
export function composePlateCanvas(design: BadgeDesign, zones: Zones, pxPerMm: number, bg: HTMLImageElement | null, logo: HTMLImageElement | null): HTMLCanvasElement {
    const W = Math.round(zones.w * pxPerMm), H = Math.round(zones.h * pxPerMm);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    g.fillStyle = design.colors.background;
    g.fillRect(0, 0, W, H);
    if (bg) {
        const k = Math.max(W / bg.naturalWidth, H / bg.naturalHeight);
        const dw = bg.naturalWidth * k, dh = bg.naturalHeight * k;
        g.drawImage(bg, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
    if (design.panel !== 'none') {
        const p = zones.panel;
        g.fillStyle = design.panel === 'light' ? 'rgba(255,255,255,0.82)' : 'rgba(0,0,0,0.5)';
        roundRect(g, p.x * pxPerMm, p.y * pxPerMm, p.w * pxPerMm, p.h * pxPerMm, 2 * pxPerMm);
        g.fill();
    }
    if (logo) {
        const z = zones.logo;
        const k = Math.min((z.w * pxPerMm) / logo.naturalWidth, (z.h * pxPerMm) / logo.naturalHeight);
        const dw = logo.naturalWidth * k, dh = logo.naturalHeight * k;
        g.drawImage(logo, z.x * pxPerMm + (z.w * pxPerMm - dw) / 2, z.y * pxPerMm + (z.h * pxPerMm - dh) / 2, dw, dh);
    }
    return c;
}
/** The average colour of a zone of a composed plate (what the text is drawn over). */
export function zoneAverage(c: HTMLCanvasElement, pxPerMm: number, zone: Zone): string {
    const g = c.getContext('2d')!;
    const x = Math.max(0, Math.floor(zone.x * pxPerMm)), y = Math.max(0, Math.floor(zone.y * pxPerMm));
    const w = Math.max(1, Math.min(c.width - x, Math.floor(zone.w * pxPerMm))), h = Math.max(1, Math.min(c.height - y, Math.floor(zone.h * pxPerMm)));
    const d = g.getImageData(x, y, w, h).data;
    let r = 0, gg = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    const n = Math.max(1, d.length / 4);
    const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(gg)}${hex(b)}`;
}
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
}
/** 300 dpi for the PDF; ~1080 px wide for the page. */
export const PRINT_PX_PER_MM = 300 / 25.4;
export const screenPxPerMm = (zones: Zones) => 1080 / zones.w;

/**
 * Relative luminance contrast between two colours (WCAG): the designer warns under 4.5 for the text on its
 * background colour (an image background is judged by its average colour under the text zone).
 */
export function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
        const n = parseInt(hex.replace('#', ''), 16);
        const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
}
