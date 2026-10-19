import type { Metadata } from "next";

// «Mi inscripción» (conference-manager 2.23.0) is personal: never indexed, never cached by a shared cache, and no
// Referer leaves it (the map tiles opt in to sending this site's origin only). The code lives in the URL fragment
// (#c=…), which no request carries anyway.
// Rendered on every request and never stored by a browser (2.29.0): a phone kept an old copy of this page
// (and its old scripts) after an update, drawing the badge with a renderer that predates the new designs.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Mi inscripción",
    robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
    referrer: "no-referrer",
    // 2.27.0: installable to the home screen — what iPhone needs before it delivers the bus notices.
    manifest: "/portal/conference/yo.webmanifest",
    appleWebApp: { capable: true, title: "Mi inscripción", statusBarStyle: "default" },
};

export default function MyRegistrationLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}
