// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client". A plain GET form to the public /search route (?q=…) — works without any JS.
export interface ChromeSearchViewProps {
    placeholder?: string;
}

export default function ChromeSearch({ placeholder = "Search…" }: ChromeSearchViewProps) {
    return (
        <form action="/search" method="get" role="search" className="wjs-chrome-search flex items-center">
            <input
                type="search"
                name="q"
                placeholder={placeholder}
                aria-label="Search"
                className="wjs-chrome-search-input px-3 py-2 rounded-lg border border-[var(--wjs-border-subtle,#e5e7eb)] bg-[var(--wjs-bg-surface,white)] text-[var(--wjs-color-text-main,#374151)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--wjs-color-primary,#2F6D86)]"
            />
        </form>
    );
}
