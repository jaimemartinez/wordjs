import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { headers } from 'next/headers';
import { SystemFontsLoader } from "@/components/SystemFontsLoader";
import { ModalProvider } from "@/contexts/ModalContext";

const inter = Inter({ subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
    try {
        // Zero-config default: Connect directly to the backend on port 3000 for SSR
        // Since this runs on the server, we use the internal URL.
        const apiUrl = process.env.INTERNAL_API_URL || "http://localhost:3000/api/v1";

        const res = await fetch(`${apiUrl}/settings`, {
            cache: 'no-store'
        });
        const settings = await res.json();

        const title = settings.blogname || "WordJS";
        const description = settings.blogdescription || "WordPress-like CMS Admin Dashboard";
        const icon = settings.site_icon ? `${settings.site_icon}?t=${Date.now()}` : "/favicon.ico";

        return {
            title: {
                default: title,
                template: `%s | ${title}`,
            },
            description: description,
            icons: {
                icon: icon,
                apple: icon,
            }
        };
    } catch (e) {
        return {
            title: "WordJS",
            description: "CMS",
        };
    }
}

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <link
                    rel="stylesheet"
                    href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"
                />
            </head>
            <body className={inter.className} suppressHydrationWarning>
                <ModalProvider>
                    <SystemFontsLoader />
                    {children}
                </ModalProvider>
            </body>
        </html>
    );
}
