import { redirect } from "next/navigation";
import { serverFetch } from "@/lib/server-api";
import { migrationRedirectTarget } from "@/lib/siteAddress";

// Reads the visitor's session, so it is rendered per request and never cached.
export const dynamic = "force-dynamic";

/**
 * RETIRED: the "Domain Change Detected" page. It existed to adopt whatever host a request arrived on as
 * the site address (POST /setup/migrate, now 410), which let anyone who could point a name at the server
 * steer it with an admin's password. The site address is now changed in Settings -> Site address (or
 * with `npm run site` on the server), so this route only forwards old bookmarks and links:
 * administrators to that screen, everyone else home. The route itself stays one more release so those
 * links keep landing somewhere.
 */
export default async function MigrationPage() {
    const me = await serverFetch<{ role?: string }>("/auth/me", { forwardCookies: true });
    redirect(migrationRedirectTarget(me));
}
