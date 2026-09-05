import { cache } from "react";
import type { Metadata } from "next";
import type { Post } from "@/lib/api";
import { getSettings, serverFetch } from "@/lib/server-api";

/**
 * ARCHIVE DATA ACCESS — the query layer behind /category, /tag, /author, /archive/{yyyy}/{mm} and
 * /taxonomy/{taxonomy}/{term}.
 *
 * THE BACKEND DOES THE NARROWING. `GET /posts` really filters on `?categories=`, `?tags=` and
 * `?author=` — each value is an id or a slug, parsed by the list route and pushed into BOTH
 * `Post.findAllWithRelations` and the matching `Post.count`, as a parameterised subquery over the
 * taxonomy / `users` tables (backend/src/routes/posts.ts, `Post._taxonomyCondition` /
 * `Post._authorCondition`). It used to accept all three and silently ignore them, so this module read
 * the whole published set and narrowed it in memory — which capped every archive at the newest
 * MAX_POST_PAGES x 100 posts on the SITE and, worse, capped it silently: a `/category/x` on a big blog
 * dropped older posts, `total`/`totalPages` under-reported, and a date archive whose year had fallen
 * out of that window 404'd. Asking the server the question it can now answer removes the whole class:
 * the walk below is bounded by the size of THIS archive rather than by the size of the site, and every
 * row it fetches is a row the archive shows.
 *
 * THE DATE ARCHIVE IS THE ONE EXCEPTION, and not by preference: `GET /posts` has no date filter at
 * all, so `/archive/{yyyy}[/{mm}]` still reads the published set and narrows on the date STRING
 * (`filterPostsByDate`). Its MAX_POST_PAGES ceiling is therefore real and is documented as such in
 * documentation/frontend.md; closing it needs a backend `?year=`/`?month=` (or `?after=`/`?before=`).
 *
 * WHY THE WHOLE NARROWED LIST AND NOT ONE PAGE. The routes hand `ArchivePage` every post the archive
 * is about, not the current slice: a `PostsGrid`/`CategoryPosts` block a theme places on `archive.json`
 * carries its OWN count, and giving it a slice would cap it at `posts_per_page` and show page 3's
 * posts on page 3 (see archiveRoute.tsx). That is also what makes `paginate()`'s `total` exact without
 * reading `X-WP-Total`, which `serverFetch` cannot see because it returns parsed JSON, not a Response.
 *
 * CACHING IS THE SAME DEAL THE PUBLIC INDEX MADE. Every read goes through `serverFetch` with an ISR
 * window and the `posts` purge tag, so an archive costs zero SQL on a warm route and is purged the
 * instant a post is published (backend/src/core/frontend-purge.ts enqueues `posts` for every content
 * change). Nothing here reads request headers or searchParams — pagination lives in the PATH
 * (`/page/2`) precisely so these routes stay in the Full-Route Cache like `/[slug]` does.
 */

/** ISR window for the archive reads. Matches `getPosts` in server-api.ts. */
const POSTS_REVALIDATE = 30;
/** Terms change far less often than posts, and nothing purges them by tag (see the note below). */
const TERMS_REVALIDATE = 300;

/** The backend clamps `per_page` at 100 (routes/posts.ts). Ask for exactly that. */
const API_MAX_PER_PAGE = 100;
/** Hard ceiling on the paging walk, so a huge site cannot turn one render into an unbounded fan-out. */
const MAX_POST_PAGES = 20;   // ≤ 2000 posts
const MAX_TERM_PAGES = 10;   // ≤ 1000 terms
/** The list grammar refuses a longer slug (MAX_IDENTITY_SLUG_LENGTH, backend/src/routes/posts.ts). */
const MAX_FILTER_SELECTOR = 200;

/** WordPress's own default when the option is unset or unusable (backend/src/core/options.ts:249). */
export const DEFAULT_POSTS_PER_PAGE = 10;

/** The two taxonomies whose terms AND post relations the public API actually exposes. */
export const ARCHIVE_TAXONOMIES = ["category", "post_tag"] as const;
export type ArchiveTaxonomy = (typeof ARCHIVE_TAXONOMIES)[number];

export interface ArchiveTerm {
    id: number;
    name: string;
    slug: string;
    taxonomy?: string;
    description?: string;
    count?: number;
}

export interface Paginated<T> {
    items: T[];
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Loaders
 */

/**
 * Walk one published-post query to the end, newest first.
 *
 * The page size is CONSTANT for the whole walk. The backend derives `offset` from each request's own
 * `per_page` (`offset = (page - 1) * limit`), so a walk that shrinks the size as it approaches its
 * target moves the window backwards and returns duplicates while never reaching the tail — the exact
 * defect `getPosts` in server-api.ts carried.
 *
 * Each page is its own `fetch`, so each is its own Data Cache entry under the same `posts` tag: a
 * publish purges the whole walk at once, and a warm archive makes zero backend calls.
 */
async function walkPublishedPosts(query: string, type: string): Promise<Post[]> {
    const out: Post[] = [];
    for (let page = 1; page <= MAX_POST_PAGES; page++) {
        const batch = await serverFetch<Post[]>(
            `/posts?${query}&per_page=${API_MAX_PER_PAGE}&page=${page}&orderby=date&order=desc`,
            { revalidate: POSTS_REVALIDATE, tags: ["posts", `posts:${type}`] },
        );
        if (!Array.isArray(batch) || batch.length === 0) break;
        out.push(...batch);
        if (batch.length < API_MAX_PER_PAGE) break;
    }
    // The status filter is the backend's, but it is applied against a caller-supplied string; keep the
    // same belt-and-braces check the blog roll makes so a draft can never reach a public listing.
    return out.filter((p) => p && p.status === "publish");
}

/** The three list filters `GET /posts` resolves against ids or slugs. */
export type PostFilterField = "categories" | "tags" | "author";

/**
 * The published posts matching ONE list filter, asked of the backend rather than sorted out here.
 *
 * The selector is an id or a slug — `?categories=news`, `?categories=12`, `?author=jane-roe`,
 * `?author=4` — and the routes pass the id whenever they already resolved the term, because an id
 * cannot collide with anything. A COMMA is refused rather than sent: the list grammar splits on it
 * into an OR-list, so a single value containing one would silently widen the archive to several
 * terms. An empty archive is a real answer (a term with no posts is a page, not a 404), so this
 * returns `[]` rather than null and the routes decide what an empty listing means.
 *
 * Cached on the PRIMITIVE arguments so `generateMetadata()` and the page body share one walk — an
 * object argument would be a new identity per call and defeat `cache()` entirely.
 */
export const getPostsBy = cache(async (field: PostFilterField, selector: string, type = "post"): Promise<Post[]> => {
    const value = String(selector ?? "").trim();
    if (!value || value.includes(",") || value.length > MAX_FILTER_SELECTOR) return [];
    const query = `type=${encodeURIComponent(type)}&status=publish&${field}=${encodeURIComponent(value)}`;
    return walkPublishedPosts(query, type);
});

/**
 * Every published post of one type.
 *
 * ONLY the date archive should use this: `GET /posts` has no date filter, so `/archive/{yyyy}` has to
 * read the set and narrow on the date string. Every other archive asks the backend (`getPostsBy`) and
 * is bounded by its own size rather than by the site's.
 */
export const getAllPublishedPosts = cache((type = "post"): Promise<Post[]> =>
    walkPublishedPosts(`type=${encodeURIComponent(type)}&status=publish`, type),
);

/**
 * Every term of one taxonomy.
 *
 * There is no "find a term by slug" endpoint: `GET /categories?search=` LIKEs on `terms.name`
 * (backend/src/models/Term.ts:209), not on the slug, so searching for `my-post-title` finds nothing
 * whenever the name and the slug differ at all (an accent, an ampersand, a manual slug). Listing and
 * matching locally is the only correct lookup, and it is one cached call for a typical site.
 *
 * The tag list is `posts` on purpose even though these are terms: nothing in frontend-purge.ts emits a
 * term tag, so riding the (very frequently purged) content tag plus a 5-minute window is strictly
 * fresher than a time window alone.
 */
export const getTerms = cache(async (taxonomy: ArchiveTaxonomy): Promise<ArchiveTerm[]> => {
    const endpoint = taxonomy === "category" ? "categories" : "tags";
    const out: ArchiveTerm[] = [];
    for (let page = 1; page <= MAX_TERM_PAGES; page++) {
        const batch = await serverFetch<ArchiveTerm[]>(
            `/${endpoint}?per_page=${API_MAX_PER_PAGE}&page=${page}&hide_empty=false`,
            { revalidate: TERMS_REVALIDATE, tags: ["terms", "posts"] },
        );
        if (!Array.isArray(batch) || batch.length === 0) break;
        out.push(...batch);
        if (batch.length < API_MAX_PER_PAGE) break;
    }
    return out;
});

export interface TaxonomyInfo {
    name: string;
    label?: string;
    public?: boolean;
    hierarchical?: boolean;
    postTypes?: string[];
    /** `{ slug }` — the URL base the taxonomy's own archive lives under (`category`, `tag`, …). */
    rewrite?: { slug?: string };
}

/**
 * One registered taxonomy, from the public `GET /taxonomies/{name}` (no auth — routes/taxonomies.ts).
 *
 * This is the ONLY part of the custom-taxonomy story the public API can answer. See the header of
 * `(public)/taxonomy/[taxonomy]/[term]/[[...paged]]/page.tsx` for what is missing on either side of it.
 */
export const getTaxonomy = cache((name: string): Promise<TaxonomyInfo | null> =>
    serverFetch<TaxonomyInfo>(`/taxonomies/${encodeURIComponent(name)}`, {
        revalidate: TERMS_REVALIDATE,
        tags: ["taxonomies", "settings"],
    }),
);

/** The URL base a taxonomy's archive lives at: its `rewrite.slug`, falling back to its own name. */
export function taxonomyBase(taxonomy: TaxonomyInfo): string {
    const slug = String(taxonomy.rewrite?.slug || taxonomy.name || "").trim();
    return /^[a-z0-9][a-z0-9_-]*$/i.test(slug) ? slug : "";
}

/**
 * Where the scoped RSS channel for one taxonomy term is served.
 *
 * The PUBLIC URL — `/category/news/feed.xml`, the one a reader guesses and the one the channel now
 * prints as its own `self` link (`publicSeoUrl`, backend/src/core/feeds.ts). It used to be
 * `/api/v1/seo/{base}/{slug}/feed.xml`, the backend mount, because a link to the pretty URL really
 * would have landed on the archive route's own optional catch-all and 404'd. It no longer does:
 * `(public)/{category,tag,author}/[slug]/feed.xml/route.ts` proxies the backend document, and Next's
 * own sorter puts that static segment ahead of `[[...paged]]` — asserted in archiveRoutes.test.tsx.
 * Autodiscovery pointing at a prefix the site's own robots.txt disallows was the remaining half of
 * the "advertised a feed nothing serves" bug the public layout fixed for its site-wide links.
 *
 * Only `category` and `tag` have a backend channel behind them (plus `author`, which the archive
 * routes reach directly). A custom taxonomy's base produces a URL nothing serves — a 404, exactly as
 * it was before, since the backend never had a route for it either.
 */
export function taxonomyFeedPath(base: string, termSlug: string): string {
    return `/${base}/${encodeURIComponent(termSlug)}/feed.xml`;
}

/**
 * What to send as `?categories=` / `?tags=` for a term the route has already resolved.
 *
 * The ID when the term list gave us one, because an id denotes exactly one row: it cannot be widened
 * by a comma, cannot be shadowed by a case-insensitive collation, and cannot be confused with another
 * taxonomy's identically-slugged term. The slug is the fallback for a term list that omitted the id.
 */
export function termSelector(term: ArchiveTerm): string {
    return Number.isInteger(term.id) && term.id > 0 ? String(term.id) : String(term.slug ?? "");
}

/** The term with this slug, or null. Slug comparison is case-insensitive, like the block resolvers'. */
export async function findTermBySlug(taxonomy: ArchiveTaxonomy, slug: string): Promise<ArchiveTerm | null> {
    const wanted = normalizeSlug(slug);
    if (!wanted) return null;
    const terms = await getTerms(taxonomy);
    return terms.find((t) => normalizeSlug(t.slug) === wanted) || null;
}

/** `posts_per_page` from the site options, clamped to something a page can actually render. */
export async function getPostsPerPage(): Promise<number> {
    const settings = await getSettings();
    // The settings endpoint JSON-parses option values, so this arrives as a NUMBER on a normal site and
    // as a string from raw/legacy sources — the same both-shapes handling the public layout does.
    const raw = (settings as Record<string, unknown> | null)?.posts_per_page;
    const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_POSTS_PER_PAGE;
    return Math.min(Math.floor(n), API_MAX_PER_PAGE);
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Narrowing
 */

const normalizeSlug = (v: unknown): string => String(v ?? "").trim().toLowerCase();

/**
 * THE AUTHOR READERS BELOW ARE DUAL-SHAPE ON PURPOSE.
 *
 * `Post.toJSON()` now serialises `author: { id, displayName, slug }` — the shape the generated client
 * has always declared, and the one that lets a public page link to `/author/<slug>` and narrow
 * `GET /posts?author=<slug>` with the very value it was handed. It used to emit a bare NUMBER, so the
 * number branch is not dead code: it is what a response cached before the change, an imported row, or
 * a caller that synthesises posts (the editor canvas preview) still looks like. Reading both shapes
 * costs three lines; picking a side costs an archive that renders empty against the other one.
 */

/** A post's author id, whichever shape the payload is in. */
export function postAuthorId(post: Post): number | null {
    const raw: unknown = (post as unknown as { author?: unknown }).author;
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    if (raw && typeof raw === "object") {
        const id = (raw as { id?: unknown }).id;
        const n = typeof id === "number" ? id : parseInt(String(id ?? ""), 10);
        return Number.isFinite(n) ? n : null;
    }
    const n = parseInt(String(raw ?? ""), 10);
    return Number.isFinite(n) ? n : null;
}

/** The author's display name, or "" on a payload that carries only the id. */
export function postAuthorName(post: Post): string {
    const raw: unknown = (post as unknown as { author?: unknown }).author;
    if (raw && typeof raw === "object") {
        const name = (raw as { displayName?: unknown }).displayName;
        if (typeof name === "string" && name.trim()) return name.trim();
    }
    return "";
}

/**
 * The author's public slug (`user_nicename`, falling back to the login server-side), or "".
 *
 * This is the value `/author/<slug>` is addressed by and the one `?author=` resolves, so the archive
 * canonicalises to it when the payload carries one. A slug with a comma is refused for the same
 * reason `getPostsBy` refuses one: the list grammar would read it as two authors.
 */
export function postAuthorSlug(post: Post): string {
    const raw: unknown = (post as unknown as { author?: unknown }).author;
    if (raw && typeof raw === "object") {
        const slug = (raw as { slug?: unknown }).slug;
        if (typeof slug === "string" && slug.trim() && !slug.includes(",")) return slug.trim();
    }
    return "";
}

/**
 * `YYYY-MM` for a post, read off the STRING rather than through `new Date()`.
 *
 * `post_date` is stored as site-local wall time (`2026-03-01 00:15:00`); parsing it into a Date and
 * asking for `getFullYear()` reinterprets it in the SERVER's zone, which moves a post published just
 * after midnight into the previous month for anyone west of UTC — a date archive that silently omits
 * posts. A prefix match cannot drift.
 */
export function postYearMonth(post: Post): { year: string; month: string } | null {
    const raw = (post as unknown as { date?: unknown; dateGmt?: unknown });
    for (const candidate of [raw.date, raw.dateGmt]) {
        const m = /^(\d{4})-(\d{2})/.exec(String(candidate ?? ""));
        if (m) return { year: m[1], month: m[2] };
    }
    return null;
}

/** `month` omitted ⇒ the whole year. */
export function filterPostsByDate(posts: Post[], year: string, month?: string): Post[] {
    return posts.filter((p) => {
        const ym = postYearMonth(p);
        if (!ym) return false;
        if (ym.year !== year) return false;
        return month ? ym.month === month : true;
    });
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Pagination
 */

/**
 * Slice one page out of a narrowed list.
 *
 * `totalPages` is at least 1 so an EMPTY archive is page 1 of 1 rather than page 1 of 0 — a term that
 * exists but has no posts is a real page (it renders "no posts yet"), not a 404, exactly as WordPress
 * treats it.
 */
export function paginate<T>(items: T[], page: number, perPage: number): Paginated<T> {
    const size = Math.max(1, Math.floor(perPage) || DEFAULT_POSTS_PER_PAGE);
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / size));
    const current = Math.max(1, Math.floor(page) || 1);
    const start = (current - 1) * size;
    return { items: items.slice(start, start + size), page: current, perPage: size, total, totalPages };
}

/**
 * The `/page/N` tail of an archive URL.
 *
 * Returns null — meaning 404 — for anything that is not exactly nothing or exactly `page/<N≥2>`.
 * `page/1` is refused on purpose: it is a second URL for the archive's own address, and letting both
 * render would publish the identical listing under two canonical-competing paths. Leading zeros and
 * `+2`/` 2` are refused for the same reason — one page, one URL.
 */
export function parsePagedSegments(segments: string[] | undefined): number | null {
    if (!segments || segments.length === 0) return 1;
    if (segments.length !== 2) return null;
    if (segments[0] !== "page") return null;
    if (!/^[1-9][0-9]{0,4}$/.test(segments[1])) return null;
    const n = parseInt(segments[1], 10);
    return n >= 2 ? n : null;
}

/** `/category/news` for page 1, `/category/news/page/3` after that. */
export function pageHref(basePath: string, page: number): string {
    return page <= 1 ? basePath : `${basePath}/page/${page}`;
}

/**
 * A four-digit year and a two-digit month, or null.
 *
 * The year is bounded to 1000–9999 because it is a path segment that becomes a `<link rel=canonical>`
 * and a template-hierarchy input; the month must be 01–12 so `/archive/2026/13` is a 404 rather than an
 * empty listing that looks like a site with no posts that month.
 */
export function parseYear(raw: string): string | null {
    return /^[1-9][0-9]{3}$/.test(raw) ? raw : null;
}

export function parseMonth(raw: string): string | null {
    return /^(0[1-9]|1[0-2])$/.test(raw) ? raw : null;
}

const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

/** "March 2026" / "2026". Locale-independent by design: a server locale must not leak into the HTML. */
export function dateArchiveTitle(year: string, month?: string): string {
    if (!month) return year;
    return `${MONTH_NAMES[parseInt(month, 10) - 1]} ${year}`;
}

/**
 * "March 4, 2026" for one post — read off the date STRING, for the same two reasons `postYearMonth`
 * is, and it is the archive card's date.
 *
 * `toLocaleDateString()` formats with the SERVER's locale AND zone and the result is baked into ISR
 * HTML, so every visitor sees whatever the host happens to be configured as, and a post published just
 * after midnight shows the previous day for readers on the other side of UTC. `post_date` is site-local
 * wall time; a prefix match on it cannot drift, and this module already renders dates that way
 * (`dateArchiveTitle`). Returns "" for a date it cannot read, which renders as the blank the card
 * showed before.
 */
export function postDateLabel(post: Post): string {
    const raw = (post as unknown as { date?: unknown; dateGmt?: unknown });
    for (const candidate of [raw.date, raw.dateGmt]) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(candidate ?? ""));
        if (!m) continue;
        const month = MONTH_NAMES[parseInt(m[2], 10) - 1];
        if (!month) continue;
        return `${month} ${parseInt(m[3], 10)}, ${m[1]}`;
    }
    return "";
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Metadata
 */

export interface ArchiveMetadataInput {
    /** The archive's page-1 path, e.g. `/category/news`. Always absolute, always without a trailing `/`. */
    basePath: string;
    /** The page being rendered — the canonical is SELF-referential, so page 3 canonicalises to page 3. */
    page: number;
    /** Term name / author / "March 2026". */
    title: string;
    description?: string;
    siteName?: string;
    /**
     * Where the per-archive RSS lives. Emitted as `<link rel="alternate" type="application/rss+xml">`
     * so a reader (and every feed autodiscovery tool) finds it from the archive page itself. Omit for
     * archives that have no feed.
     */
    feedPath?: string;
    /**
     * Overrides the self-referential canonical. Used by `/taxonomy/{category}/{slug}`, which is a second
     * address for `/category/{slug}` — the two must not compete as duplicate content, so the alias
     * points at the dedicated URL rather than at itself.
     */
    canonicalPath?: string;
}

/**
 * `<title>`, description, canonical and the feed link for one archive page.
 *
 * PAGE 2+ STAYS INDEXABLE. WordPress noindexes nothing here and neither do we: a paged archive is how
 * a crawler reaches older posts on a site with no other listing. What it must not do is claim page 1's
 * address — hence the self-referential canonical and the "Page N" title suffix, which together are what
 * stop the pages reading as duplicates of each other.
 */
export function buildArchiveMetadata(input: ArchiveMetadataInput): Metadata {
    const { basePath, page, title, description, siteName, feedPath, canonicalPath } = input;
    const paged = page > 1 ? `${title} — Page ${page}` : title;
    const canonical = canonicalPath ?? pageHref(basePath, page);
    return {
        title: paged,
        ...(description ? { description } : {}),
        alternates: {
            canonical,
            ...(feedPath
                ? { types: { "application/rss+xml": [{ url: feedPath, title: siteName ? `${title} — ${siteName}` : title }] } }
                : {}),
        },
        openGraph: {
            title: paged,
            ...(description ? { description } : {}),
            type: "website",
            url: canonical,
            ...(siteName ? { siteName } : {}),
        },
        twitter: { card: "summary", title: paged, ...(description ? { description } : {}) },
    };
}
