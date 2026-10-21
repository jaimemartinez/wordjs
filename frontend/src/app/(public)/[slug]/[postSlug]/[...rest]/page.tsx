import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";
import { getPostBySlug, getPostById, contentNotFound } from "@/lib/server-api";
import { ancestryMatches, ownPath } from "@/lib/public/nestedPath";

/**
 * `/<a>/<b>/<c>…` — a WordPress nested page address (`/level-1/level-2/level-3`). Every page is served
 * at its own slug here, so an address whose segments are exactly the page's ancestry redirects there
 * permanently (old links and search results keep working); anything else is a 404.
 */

export const revalidate = 60;

interface RouteParams {
    slug: string;
    postSlug: string;
    rest: string[];
}

async function nestedTarget(params: Promise<RouteParams>): Promise<string | null> {
    const { slug, postSlug, rest } = await params;
    const segments = [slug, postSlug, ...(rest || [])].filter(Boolean);
    const last = segments[segments.length - 1];
    const entry = last ? await getPostBySlug(last) : null;
    if (!entry || entry.type === "post") return null;
    return (await ancestryMatches(entry, segments.slice(0, -1), getPostById)) ? ownPath("", entry.slug || String(entry.id)) : null;
}

export async function generateMetadata(): Promise<Metadata> {
    // Every answer is a redirect or a 404; neither is indexed.
    return { robots: { index: false } };
}

export default async function NestedPageRedirect({ params }: { params: Promise<RouteParams> }): Promise<null> {
    const target = await nestedTarget(params);
    if (!target) contentNotFound();
    permanentRedirect(target);
    return null;
}
