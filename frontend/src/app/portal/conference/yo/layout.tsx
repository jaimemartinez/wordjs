import type { Metadata } from "next";

// «Mi inscripción» (conference-manager 2.23.0) is personal: never indexed, never cached by a shared cache, and no
// Referer leaves it (the map tiles opt in to sending this site's origin only). The code lives in the URL fragment
// (#c=…), which no request carries anyway.
export const metadata: Metadata = {
    title: "Mi inscripción",
    robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
    referrer: "no-referrer",
};

export default function MyRegistrationLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}
