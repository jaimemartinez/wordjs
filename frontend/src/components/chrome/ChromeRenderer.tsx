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
import type { ChromeBindings, ChromeBlock, ChromeBlockType, ChromeData } from "@/lib/chromeData";
import { parseChromeSocials } from "@/lib/chromeData";
import ChromeButton from "./ChromeButton";
import ChromeColumns from "./ChromeColumns";
import ChromeCopyright from "./ChromeCopyright";
import ChromeHeading from "./ChromeHeading";
import ChromeLanguageSwitcher from "./ChromeLanguageSwitcher";
import ChromeLogo from "./ChromeLogo";
import ChromeNav from "./ChromeNav";
import ChromeRichText from "./ChromeRichText";
import ChromeRow from "./ChromeRow";
import ChromeWidgets from "./ChromeWidgets";
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

interface ChromeRenderContext {
    bindings: ChromeBindings;
    fallbackKey: string;
    key: string;
    location: "header" | "footer";
    props: Record<string, any>;
    settings: Record<string, any>;
}

type ChromeBlockRenderer = (context: ChromeRenderContext) => React.ReactNode;

const childrenOf = (props: Record<string, any>, bindings: ChromeBindings, fallbackKey: string, location: "header" | "footer") =>
    (Array.isArray(props.items) ? (props.items as ChromeBlock[]) : []).map((child, i) =>
        renderBlock(child, bindings, `${fallbackKey}.${i}`, location),
    );

const CHROME_RENDERERS = {
    ChromeLogo: ({ key, location, props, settings }) => (
        <ChromeLogo key={key} size={props.size} showTitle={props.showTitle === true} location={location} logoUrl={settings.site_logo || null} siteTitle={settings.blogname || ""} />
    ),
    ChromeSiteTitle: ({ key, location, props, settings }) => (
        <ChromeSiteTitle key={key} showTagline={props.showTagline} location={location} siteTitle={settings.blogname || ""} tagline={settings.blogdescription || ""} />
    ),
    ChromeNav: ({ bindings, key, props }) => {
        const items = props.location === "footer" ? bindings.menus.footer : bindings.menus.header;
        return <ChromeNav key={key} location={props.location} orientation={props.orientation} collapse={props.collapse} title={props.title} items={items || []} />;
    },
    ChromeSearch: ({ key, props }) => <ChromeSearch key={key} placeholder={props.placeholder} />,
    ChromeSocials: ({ key, props, settings }) => <ChromeSocials key={key} title={props.title} links={parseChromeSocials(settings)} />,
    ChromeText: ({ key, props }) => <ChromeText key={key} text={props.text ?? ""} />,
    ChromeButton: ({ key, props }) => <ChromeButton key={key} label={props.label ?? ""} href={props.href ?? ""} variant={props.variant} />,
    ChromeSpacer: ({ key, props }) => <ChromeSpacer key={key} size={props.size} />,
    ChromeRow: ({ bindings, fallbackKey, key, location, props }) => (
        <ChromeRow key={key} align={props.align} gap={props.gap} wrap={props.wrap} direction={props.direction} stack={props.stack} tone={props.tone}>
            {childrenOf(props, bindings, fallbackKey, location)}
        </ChromeRow>
    ),
    ChromeColumns: ({ bindings, fallbackKey, key, location, props }) => (
        <ChromeColumns key={key} columns={props.columns} gap={props.gap}>
            {childrenOf(props, bindings, fallbackKey, location)}
        </ChromeColumns>
    ),
    ChromeHeading: ({ key, props }) => <ChromeHeading key={key} text={props.text ?? ""} level={props.level} />,
    ChromeRichText: ({ key, props, settings }) => <ChromeRichText key={key} html={props.html ?? ""} siteTitle={settings.blogname || ""} />,
    ChromeCopyright: ({ key, props, settings }) => <ChromeCopyright key={key} text={props.text} siteTitle={settings.blogname || ""} />,
    ChromeLanguageSwitcher: ({ key, props }) => <ChromeLanguageSwitcher key={key} style={props.style} labels={props.labels} />,
    ChromeWidgets: ({ key, props }) => <ChromeWidgets key={key} area={props.area} />,
} satisfies Record<ChromeBlockType, ChromeBlockRenderer>;

// Per-breakpoint visibility (contract commonProps). The block is wrapped in a `display: contents` box
// that disappears from layout — the block stays a direct flex/grid child of its row — and that box is
// switched to `display: none` in the hidden ranges. Breakpoints are the site's own: phone < 768px
// (md), tablet 768–1023px, desktop ≥ 1024px (lg). Static literal classes so Tailwind sees them.
const HIDE_CLASS = { hideMobile: "max-md:hidden", hideTablet: "md:max-lg:hidden", hideDesktop: "lg:hidden" } as const;

export function chromeVisibilityClass(props: Record<string, unknown>): string {
    return (Object.keys(HIDE_CLASS) as (keyof typeof HIDE_CLASS)[])
        .filter((flag) => props[flag] === true)
        .map((flag) => HIDE_CLASS[flag])
        .join(" ");
}

function renderBlock(block: ChromeBlock, bindings: ChromeBindings, fallbackKey: string, location: "header" | "footer"): React.ReactNode {
    const props = (block.props || {}) as Record<string, any>;
    const settings = bindings.settings || {};
    // The editor stamps a stable string id on every block; fall back to the positional key.
    const key = typeof props.id === "string" ? props.id : fallbackKey;
    const renderer = CHROME_RENDERERS[block.type as ChromeBlockType];
    if (!renderer) return null;
    const hidden = chromeVisibilityClass(props);
    if (!hidden) return renderer({ bindings, fallbackKey, key, location, props, settings });
    return (
        <div key={key} className={`wjs-chrome-visibility contents ${hidden}`}>
            {renderer({ bindings, fallbackKey, key: "block", location, props, settings })}
        </div>
    );
}
