import NotFoundState from "@/components/NotFoundState";
import ThemeTemplate from "@/components/content/ThemeTemplate";
import { notFoundStrings } from "@/lib/public/uiStrings";
import { getSettings } from "@/lib/server-api";

/**
 * Not-found boundary for the public site. Rendered (with a real HTTP 404 status) whenever a public
 * page calls notFound() — e.g. an unknown post/page slug — inside the public layout chrome, so
 * crawlers get a 404 instead of a soft-200 empty page.
 *
 * IT TAKES A THEME TEMPLATE (`404.json` → `page.json`), which is WordPress's 404.php and the reason a
 * theme can now own the one page it could never touch. Two Next constraints shaped how:
 *
 *   · a not-found boundary receives NO props (no params, no searchParams), so there is nothing more
 *     specific than `404` to ask for — the chain is exactly two names long;
 *   · it may be async and fetch, and the 404 STATUS is set by the boundary mechanism itself, not by
 *     anything this component renders — so wrapping the message in a template cannot soften a 404 into
 *     a 200. The template resolves through the same fail-closed path as every other route: a theme with
 *     no 404.json and no page.json renders exactly what this file rendered before.
 */
export default async function PublicNotFound() {
    // The texts follow the SITE language (WPLANG, like <html lang>); getSettings is cache()d — the
    // layout already fetched it for this request.
    const strings = notFoundStrings(await getSettings().catch(() => null));
    return (
        <ThemeTemplate kind="notFound">
            <NotFoundState title={strings.title} message={strings.message} backLabel={strings.back} />
        </ThemeTemplate>
    );
}
