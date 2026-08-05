// Recursive, server-compatible renderer for a VALIDATED composable-chrome composition (contract
// v1). It receives the parsed data plus a bindings object with data the shell ALREADY fetched
// (menus by location, settings) and resolves each block's data-binding here — blocks stay purely
// presentational and never fetch.
//
// DECISION — why NOT @wordjs/puck's ./rsc <Render>: its dist/rsc entry drags the shared
// chunk-XMPBAEGW.mjs (~30KB) which imports useMemo/forwardRef from React plus the flat and
// fast-deep-equal deps, and its API requires a full Puck `Config` object per component. The public
// tree must NOT grow with Puck runtime this phase (perf program F3 budget), and our allowlist is 9
// closed blocks with renderer-resolved bindings — this hand-rolled mapper is dependency-free and
// RSC-safe by construction. Revisit only if chrome blocks ever need Puck slot/metadata semantics.
import type { ChromeBindings, ChromeBlock, ChromeData } from "@/lib/chromeData";
import { parseChromeSocials } from "@/lib/chromeData";
import ChromeButton from "./ChromeButton";
import ChromeLogo from "./ChromeLogo";
import ChromeNav from "./ChromeNav";
import ChromeRow from "./ChromeRow";
import ChromeSearch from "./ChromeSearch";
import ChromeSiteTitle from "./ChromeSiteTitle";
import ChromeSocials from "./ChromeSocials";
import ChromeSpacer from "./ChromeSpacer";
import ChromeText from "./ChromeText";

export interface ChromeRendererProps {
    data: ChromeData;
    bindings: ChromeBindings;
    // Chrome slot this composition fills. Blocks that have no location prop of their own (logo, site
    // title) need it to decide whether to emit the themes' header CSS hooks — those rules are written
    // for the masthead and must not leak into a footer. Defaults to the header, the slot compositions
    // target and the only one with theme hooks to preserve; the footer call site passes "footer".
    location?: "header" | "footer";
}

export default function ChromeRenderer({ data, bindings, location = "header" }: ChromeRendererProps) {
    return <>{data.content.map((block, i) => renderBlock(block, bindings, `c${i}`, location))}</>;
}

function renderBlock(block: ChromeBlock, bindings: ChromeBindings, fallbackKey: string, location: "header" | "footer"): React.ReactNode {
    const props = (block.props || {}) as Record<string, any>;
    const settings = bindings.settings || {};
    // The editor stamps a stable string id on every block; fall back to the positional key.
    const key = typeof props.id === "string" ? props.id : fallbackKey;

    switch (block.type) {
        case "ChromeLogo":
            return <ChromeLogo key={key} size={props.size} location={location} logoUrl={settings.site_logo || null} siteTitle={settings.blogname || ""} />;
        case "ChromeSiteTitle":
            return <ChromeSiteTitle key={key} showTagline={props.showTagline} location={location} siteTitle={settings.blogname || ""} tagline={settings.blogdescription || ""} />;
        case "ChromeNav": {
            const items = props.location === "footer" ? bindings.menus.footer : bindings.menus.header;
            return <ChromeNav key={key} location={props.location} orientation={props.orientation} items={items || []} />;
        }
        case "ChromeSearch":
            return <ChromeSearch key={key} placeholder={props.placeholder} />;
        case "ChromeSocials":
            return <ChromeSocials key={key} links={parseChromeSocials(settings)} />;
        case "ChromeText":
            return <ChromeText key={key} text={props.text ?? ""} />;
        case "ChromeButton":
            return <ChromeButton key={key} label={props.label ?? ""} href={props.href ?? ""} variant={props.variant} />;
        case "ChromeSpacer":
            return <ChromeSpacer key={key} size={props.size} />;
        case "ChromeRow":
            return (
                <ChromeRow key={key} align={props.align} gap={props.gap} wrap={props.wrap}>
                    {(Array.isArray(props.items) ? (props.items as ChromeBlock[]) : []).map((child, i) => renderBlock(child, bindings, `${fallbackKey}.${i}`, location))}
                </ChromeRow>
            );
        default:
            // Unreachable for validated data: parseChromeData is fail-closed on unknown types.
            return null;
    }
}
