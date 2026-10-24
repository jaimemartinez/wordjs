/**
 * «Escarapelas» in the coordinator portal (conference-manager 2.19.0): the location's people's badges, while the
 * conference lets coordinators share them (the plugin advertises `features.badges` on /portal/login and
 * /portal/me). A badge link opens the person's credential page (/portal/conference/badge#t=…) on the site's
 * public address; the PDF goes through a short-lived ticket and the file route, in a new tab. The portal LIST
 * still never carries a reg_code: only the per-person badge call returns what the badge shows.
 */
const API = "/api/v1/plugin/conference-manager/portal/badges";

export const hasBadges = (loc: { features?: unknown } | null | undefined): boolean => {
    const f = loc && typeof loc.features === "object" && loc.features ? (loc.features as Record<string, unknown>) : {};
    return !!Number(f.badges);
};

/**
 * The address links are sent with: the site's public address (siteurl, from the public settings), else this
 * page's origin — a link sent to a person must not carry a LAN host. Read once.
 */
let publicBaseP: Promise<string> | null = null;
export function publicBase(): Promise<string> {
    const here = typeof window !== "undefined" ? window.location.origin : "";
    if (!publicBaseP) {
        publicBaseP = fetch("/api/v1/settings", { credentials: "include" })
            .then((r) => (r.ok ? r.json() : null))
            .then((st) => { const u = String((st && (st.siteurl || st.home)) || "").trim(); return /^https?:\/\/[^/\s]+/i.test(u) ? u.replace(/\/+$/, "") : here; })
            .catch(() => here);
    }
    return publicBaseP;
}
/** The credential page of a token — in the URL fragment, so it never reaches a log or a link preview. */
export const badgePageUrl = (token: string, base?: string): string =>
    `${base || (typeof window !== "undefined" ? window.location.origin : "")}/portal/conference/badge#t=${token}`;
/** What is opened, copied and sent (2.28.0): the person's «Mi inscripción» page when the plugin gives it. */
export const portalLinkUrl = (l: { token: string; self?: string | null }, base?: string): string =>
    l.self && /^\/portal\/conference\/yo#c=[A-Z0-9]{10}$/.test(l.self)
        ? `${base || (typeof window !== "undefined" ? window.location.origin : "")}${l.self}`
        : badgePageUrl(l.token, base);

/**
 * The WhatsApp number of a phone as typed in the form (the plugin admin keeps the same rule, client/lib/badges.ts
 * waNumber): the first number of a list, its digits, an «00» prefix dropped, a 10-digit Colombian mobile (3…)
 * given the country code. null when nothing usable remains.
 */
export function waNumber(phone: unknown, cc = "57"): string | null {
    const first = String(phone == null ? "" : phone).split(/[/,;|]|\s+y\s+|\s+o\s+/i)[0] || "";
    let digits = first.replace(/\D/g, "");
    // 2.33.2: «+» / «00» numbers keep their country code; a national one takes `cc` and loses its trunk «0».
    if (first.trim().startsWith("+")) { /* already international */ }
    else if (digits.startsWith("00")) digits = digits.slice(2);
    else if (digits) {
        const code = String(cc || "57").replace(/\D/g, "") || "57";
        const national = digits.replace(/^0+/, "");
        // Already carrying the code without «+» («573001234567»): not prefixed twice.
        digits = national.startsWith(code) && national.length >= code.length + 9 ? national : `${code}${national}`;
    }
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
}
/** wa.me with the badge message, to the person's number when there is one. */
export function whatsappUrl(phone: unknown, text: string, cc = "57"): string {
    const n = waNumber(phone, cc);
    const q = `text=${encodeURIComponent(text)}`;
    return n ? `https://wa.me/${n}?${q}` : `https://wa.me/?${q}`;
}

type Headers = (extra?: Record<string, string>) => Record<string, string>;
async function post<T>(headers: Headers, path: string, body: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
        method: "POST", credentials: "include", cache: "no-store",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error) || "No se pudo completar la acción.");
    return data as T;
}
export type PortalBadgeLink = { inscription_id: number; token: string; view_count: number; self?: string | null };
export const portalBadgeLink = async (headers: Headers, inscriptionId: number): Promise<{ link: PortalBadgeLink; countryCode: string; conference: string }> => {
    const r = await post<{ link: PortalBadgeLink | null; country_code?: string; conference?: string }>(headers, "/link", { inscription_id: inscriptionId });
    if (!r.link) throw new Error("Esta inscripción no tiene escarapela.");
    return { link: r.link, countryCode: r.country_code || "57", conference: r.conference || "" };
};

/**
 * Open a person's badge PDF in a NEW tab: the tab opens now, inside the tap (a popup
 * blocker allows that), and goes to the file once the ticket arrives — the coordinator keeps the portal.
 */
export async function openPortalBadgePdf(headers: Headers, scope: { inscription_id?: number }, sheet: "single" | "letter"): Promise<void> {
    const w = typeof window !== "undefined" ? window.open("", "_blank") : null;
    try {
        const r = await post<{ d: string }>(headers, "/ticket", { ...scope, sheet });
        const url = `/portal/conference/file?d=${encodeURIComponent(r.d)}`;
        if (w && !w.closed) { try { w.opener = null; } catch { /* ignore */ } w.location.href = url; return; }
        const a = document.createElement("a");
        a.href = url; a.target = "_blank"; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
    } catch (e) {
        if (w && !w.closed) w.close();
        throw e;
    }
}

/** Copy text, with the execCommand fallback (an http LAN address has no Clipboard API). */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* fall back */ }
    try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
    } catch { return false; }
}
