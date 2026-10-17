/**
 * A post's date in the SITE's language (lib/public/siteDate). It used to localize after mount to the
 * VISITOR's browser locale, so an English site showed `2/3/2024` to a Spanish reader; the formatting
 * is deterministic now, so the server renders the final text and no client island is needed.
 */
import { formatSiteDate } from "@/lib/public/siteDate";

export default function LocalizedDate({ date, lang }: { date?: string | null; lang?: string | null }) {
    return <>{formatSiteDate(date, lang)}</>;
}
