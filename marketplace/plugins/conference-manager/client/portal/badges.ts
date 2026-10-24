/**
 * «Escarapelas» in the coordinator portal (conference-manager 2.19.0): the location's people's badges, while the
 * conference lets coordinators share them (the plugin advertises `features.badges` on /portal/login and
 * /portal/me). A badge link opens the person's credential page (/portal/conference/badge#t=…) on the site's
 * public address. 2.36.6: it is shared by WhatsApp (the server's number), copied, or e-mailed by the server — no PDF
 * from the portal any more. The portal LIST still never carries a reg_code: only the per-person badge call returns
 * what the badge shows.
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
export const portalBadgeLink = async (headers: Headers, inscriptionId: number): Promise<{ link: PortalBadgeLink; countryCode: string; conference: string; phoneWa: string; emailMasked: string }> => {
    const r = await post<{ link: PortalBadgeLink | null; country_code?: string; conference?: string; phone_wa?: string; email_masked?: string }>(headers, "/link", { inscription_id: inscriptionId });
    if (!r.link) throw new Error("Esta inscripción no tiene escarapela.");
    // 2.36.6: the WhatsApp number as the consent message builds it (the server's E.164), and the masked e-mail.
    return { link: r.link, countryCode: r.country_code || "57", conference: r.conference || "", phoneWa: r.phone_wa || "", emailMasked: r.email_masked || "" };
};
/** «Enviar» (2.36.6): the person's badge link and how to use it, by e-mail. Throws the server's message (no e-mail, wait, mail off). */
export const portalBadgeEmail = async (headers: Headers, inscriptionId: number): Promise<{ sent: boolean; email_masked: string }> =>
    post<{ sent: boolean; email_masked: string }>(headers, "/email", { inscription_id: inscriptionId });

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
