// Composable-chrome block (contract v1): a widget area (the widgets the admin places under Widgets),
// e.g. "footer-1" — the area the legacy footer rendered above its columns. Server shell around the
// SAME client island the legacy footer used (PublicSidebar): it fetches the area's rendered HTML and
// sanitizes it before it touches the DOM, and renders NOTHING while loading or when the area is empty,
// so an empty area costs no space. It only reads; any number of instances is fine.
import PublicSidebar from "@/components/public/PublicSidebar";

export interface ChromeWidgetsViewProps {
    area: string;
}

export default function ChromeWidgets({ area }: ChromeWidgetsViewProps) {
    return (
        <div className="wjs-chrome-widgets w-full empty:hidden">
            <PublicSidebar id={area} />
        </div>
    );
}
