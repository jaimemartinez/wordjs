import Link from "next/link";
import type { PostTermsStrings } from "@/lib/public/uiStrings";

interface TermRef { id: number; name: string; slug: string }

/**
 * A single post's categories and tags, linked to their archives — the post page showed neither, so a
 * reader could not get from an entry to the rest of its topic. Server component; `wjs-post-terms*` are
 * theme hooks like the rest of the post frame.
 */
export default function PostTerms({ categories, tags, strings }: { categories?: TermRef[]; tags?: TermRef[]; strings: PostTermsStrings }) {
    const cats = (categories || []).filter((c) => c && c.slug);
    const tagList = (tags || []).filter((c) => c && c.slug);
    if (!cats.length && !tagList.length) return null;
    const row = (label: string, icon: string, base: string, items: TermRef[], cls: string) => items.length > 0 && (
        <div className={`wjs-post-terms-${cls} flex flex-wrap items-center gap-2`}>
            <span className="font-semibold text-[var(--wjs-color-text-muted,#6b7280)] inline-flex items-center gap-1.5">
                <i className={`fa-solid ${icon}`} aria-hidden="true"></i>{label}
            </span>
            {items.map((term) => (
                <Link
                    key={term.id}
                    href={`${base}/${encodeURIComponent(term.slug)}`}
                    className="inline-flex items-center min-h-8 px-3 rounded-full border border-[var(--wjs-border-subtle,#e5e7eb)] text-[var(--wjs-color-text,#374151)] hover:text-[var(--wjs-color-primary,#2563eb)] hover:border-[var(--wjs-color-primary,#2563eb)] transition-colors"
                >
                    {term.name}
                </Link>
            ))}
        </div>
    );
    return (
        <nav className="wjs-post-terms max-w-3xl mx-auto mt-8 px-4 flex flex-col gap-3 text-sm" aria-label={`${strings.categories} / ${strings.tags}`}>
            {row(strings.categories, "fa-folder", "/category", cats, "categories")}
            {row(strings.tags, "fa-tag", "/tag", tagList, "tags")}
        </nav>
    );
}
