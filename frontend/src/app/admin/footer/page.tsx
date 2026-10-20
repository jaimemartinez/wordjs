// The footer settings page was retired: everything it edited now lives in the header & footer editor
// (/admin/chrome) — the footer text and copyright were converted into the footer composition, and the
// social profiles have their own panel there. Old bookmarks and links land on the footer part.
import { redirect } from "next/navigation";

export default function LegacyFooterRedirect() {
    redirect("/admin/chrome?part=footer");
}
