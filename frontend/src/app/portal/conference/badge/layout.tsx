import type { Metadata } from "next";

// A badge page is personal (a name and the meal code): never indexed, never cached by a shared cache, and no
// Referer leaves it. The token lives in the URL fragment (#t=…), which no request carries anyway.
export const metadata: Metadata = {
    title: "Escarapela",
    robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
    referrer: "no-referrer",
};

export default function BadgeLayout({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}
