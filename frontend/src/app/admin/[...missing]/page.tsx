import { notFound } from "next/navigation";

/**
 * Any /admin/… address no screen answers. Without this catch-all the URL fell through to the PUBLIC
 * site's 404 — the site's header and footer, no way back into the panel. notFound() here renders
 * app/admin/not-found.tsx inside the admin shell instead. Every real screen (and /admin/plugin/[slug])
 * is a more specific route and wins over it.
 */
export default function AdminMissingPage(): never {
    notFound();
}
