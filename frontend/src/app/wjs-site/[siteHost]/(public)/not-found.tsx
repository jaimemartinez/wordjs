import NotFoundState from "@/components/NotFoundState";
import { notFoundStrings } from "@/lib/public/uiStrings";
import { getSettings } from "@/lib/server-api";

/**
 * Multisite: the not-found boundary of another site of the network. A not-found boundary receives no
 * params, so it renders the plain state rather than a theme template; the layout around it is the
 * site's own. Its texts follow that site's language: getSettings is keyed by the request's site host.
 */
export default async function SiteNotFound() {
    const strings = notFoundStrings(await getSettings().catch(() => null));
    return <NotFoundState title={strings.title} message={strings.message} backLabel={strings.back} />;
}
