import { AuthScreen } from "@/app/_root/AuthScreen";

// The sign-in screens' shell, the same as the main site's (_root/AuthScreen.tsx): Inter and the admin
// language provider. It reads the request's language cookie, so these screens render per request.
export const dynamic = "force-dynamic";

export default async function SiteAuthLayout({ children }: { children: React.ReactNode }) {
    return AuthScreen({ children });
}
