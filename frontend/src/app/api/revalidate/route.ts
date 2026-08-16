import { NextRequest, NextResponse } from "next/server";
import { revalidateTag, revalidatePath } from "next/cache";
import crypto from "crypto";
import { resolveRevalidateSecret } from "@/lib/revalidateSecret";

/**
 * On-demand cache purge endpoint (Fase 1). The backend's core/frontend-purge.ts POSTs
 * { tags, paths } here when content changes, authenticated with the shared `revalidateSecret`
 * from wordjs-config.json. Purging can only force re-renders — it can never inject content —
 * and the route fails CLOSED: no configured secret means 503, never open access.
 *
 * In separate mode the request arrives from the GATEWAY (which fans one backend purge out to every
 * registered frontend node) and the secret comes from THIS node's own config, put there by cluster
 * enrollment — see lib/revalidateSecret.ts.
 */

export const dynamic = "force-dynamic";

const MAX_ENTRIES = 100;
const MAX_LEN = 200;

function timingSafeEq(a: string, b: string): boolean {
    // hash both sides to fixed length so timingSafeEqual never throws on length mismatch
    const ha = crypto.createHash("sha256").update(a).digest();
    const hb = crypto.createHash("sha256").update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

const cleanList = (v: unknown, pred: (s: string) => boolean): string[] =>
    Array.isArray(v)
        ? [...new Set(v.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= MAX_LEN && pred(s)))].slice(0, MAX_ENTRIES)
        : [];

export async function POST(req: NextRequest) {
    const secret = resolveRevalidateSecret();
    if (!secret) return NextResponse.json({ error: "revalidation not configured" }, { status: 503 });

    const given = req.headers.get("x-revalidate-secret") || "";
    if (!given || !timingSafeEq(given, secret)) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const tags = cleanList(body?.tags, () => true);
    const paths = cleanList(body?.paths, (s) => s.startsWith("/"));

    // Next 16 signature: the 'max' profile = classic revalidateTag semantics (mark stale now,
    // serve stale-while-revalidate on the next hit).
    for (const tag of tags) revalidateTag(tag, "max");
    for (const p of paths) revalidatePath(p);

    return NextResponse.json({ revalidated: { tags, paths } });
}
