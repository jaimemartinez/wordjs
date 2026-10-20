import { inter } from "@/app/fonts";

// The sign-in screens' shell (the same wrapper as the main site's): Inter, since the document's <body>
// carries only inter.variable.
export default function SiteAuthLayout({ children }: { children: React.ReactNode }) {
    return <div className={inter.className}>{children}</div>;
}
