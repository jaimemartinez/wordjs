// Plain-language validation messages for the header/footer editor.
//
// Two validators guard a composition and both speak "developer": the local parser (lib/chromeData.ts,
// strings like `editor: content[0].items[1]: ChromeButton.href must be a relative '/…' path…`) and the
// backend write authority (entries `{ code: "CHROME_UNSAFE_HREF", path: "content[0].props.items[1].props.href" }`).
// This turns either form into a sentence an editor can act on — WHICH block (by its name in the
// palette, and where it sits) and WHAT to do — and falls back to the original text for anything it
// does not recognise, so no problem is ever hidden behind a vaguer message.

type Translate = (key: string) => string;

export interface ChromeProblem {
    /** Human-readable block name ("Button"), when the path names one. */
    block?: string;
    /** "Row 1 › block 2" — where the block sits. */
    where?: string;
    message: string;
}

interface ParsedLocation {
    indexes: number[];
    prop?: string;
    type?: string;
}

/** Pull the block indexes (and the offending prop) out of either validator's path form. */
function parseLocation(text: string, path: string): ParsedLocation {
    const indexes = Array.from(text.matchAll(/(?:content|items)\[(\d+)\]/g)).map((m) => Number(m[1]));
    const backendProp = /\.props\.([A-Za-z][\w-]*)$/.exec(path.trim());
    const localProp = /:\s*(Chrome[A-Za-z]+)\.([A-Za-z][\w-]*)\s/.exec(text);
    const localType = /:\s*(Chrome[A-Za-z]+)[\s.]/.exec(text) || /block type "(Chrome[A-Za-z]+|[^"]*)"/.exec(text);
    return {
        indexes,
        prop: localProp?.[2] ?? (backendProp && backendProp[1] !== "items" ? backendProp[1] : undefined),
        type: localProp?.[1] ?? localType?.[1],
    };
}

/** Walk the composition along the indexes to find the block type the path points at. */
function blockTypeAt(data: unknown, indexes: number[]): string | undefined {
    let list = (data as { content?: unknown[] } | null)?.content;
    let type: string | undefined;
    for (const i of indexes) {
        const node = Array.isArray(list) ? (list[i] as { type?: unknown; props?: { items?: unknown[] } } | undefined) : undefined;
        if (!node) return type;
        type = typeof node.type === "string" ? node.type : type;
        list = node.props?.items;
    }
    return type;
}

const BLOCK_KEY: Record<string, string> = {
    ChromeLogo: "chrome.block.logo",
    ChromeSiteTitle: "chrome.block.siteTitle",
    ChromeNav: "chrome.block.nav",
    ChromeSearch: "chrome.block.search",
    ChromeSocials: "chrome.block.socials",
    ChromeText: "chrome.block.text",
    ChromeButton: "chrome.block.button",
    ChromeSpacer: "chrome.block.spacer",
    ChromeRow: "chrome.block.row",
    ChromeColumns: "chrome.block.columns",
    ChromeHeading: "chrome.block.heading",
    ChromeRichText: "chrome.block.richText",
    ChromeCopyright: "chrome.block.copyright",
    ChromeLanguageSwitcher: "chrome.block.languages",
    ChromeWidgets: "chrome.block.widgets",
};

function whereLabel(indexes: number[], t: Translate): string | undefined {
    if (indexes.length === 0) return undefined;
    const [top, ...rest] = indexes;
    const parts = [`${t("chrome.error.where.top")} ${top + 1}`, ...rest.map((i) => `${t("chrome.error.where.inner")} ${i + 1}`)];
    return parts.join(" › ");
}

function classify(raw: string, code: string | undefined): string {
    if (code) return code;
    if (/must be a relative|navigation|http\(s\)|site-relative/.test(raw)) return "CHROME_UNSAFE_HREF";
    if (/is required|requires "/.test(raw)) return "CHROME_MISSING_PROP";
    if (/nesting depth|maximum depth/.test(raw)) return "CHROME_TOO_DEEP";
    if (/exceeds \d+ blocks|block budget/.test(raw)) return "CHROME_TOO_MANY_BLOCKS";
    if (/exceeds \d+ bytes|bytes — the budget/.test(raw)) return "CHROME_TOO_LARGE";
    if (/may not appear in/.test(raw)) return "CHROME_BLOCK_NOT_IN_PART";
    if (/unknown block type/.test(raw)) return "CHROME_UNKNOWN_TYPE";
    if (/unknown prop|is not a prop of/.test(raw)) return "CHROME_UNKNOWN_PROP";
    if (/must be/.test(raw)) return "CHROME_INVALID_PROP";
    return "";
}

/**
 * Describe one validation problem in plain language. `entry` is a local error string or a backend
 * `{ code, path, message }`; `data` is the composition that was being saved (to name the block).
 */
export function describeChromeProblem(entry: unknown, data: unknown, t: Translate): ChromeProblem {
    let raw = "";
    let code: string | undefined;
    let path = "";
    if (typeof entry === "string") {
        raw = entry;
        path = entry;
    } else if (entry && typeof entry === "object") {
        const e = entry as { code?: unknown; path?: unknown; message?: unknown };
        raw = typeof e.message === "string" ? e.message : typeof e.code === "string" ? e.code : "";
        code = typeof e.code === "string" ? e.code : undefined;
        path = typeof e.path === "string" ? e.path : "";
    }
    if (!raw && !code) return { message: t("chrome.admin.validationUnknown") };

    const loc = parseLocation(`${path} ${typeof entry === "string" ? "" : raw}`, typeof entry === "string" ? "" : path);
    const type = blockTypeAt(data, loc.indexes) ?? loc.type;
    const block = type && BLOCK_KEY[type] ? t(BLOCK_KEY[type]) : undefined;
    const where = whereLabel(loc.indexes, t);
    const field = loc.prop ? t(`chrome.field.${loc.prop}`) : "";
    const fieldName = field && !field.startsWith("chrome.field.") ? field : loc.prop || "";

    const kind = classify(raw, code);
    const known: Record<string, string> = {
        CHROME_UNSAFE_HREF: t("chrome.error.unsafeHref"),
        CHROME_MISSING_PROP: t("chrome.error.missing").replace("{field}", fieldName),
        CHROME_INVALID_PROP: t("chrome.error.invalid").replace("{field}", fieldName),
        CHROME_TOO_DEEP: t("chrome.error.tooDeep"),
        CHROME_TOO_MANY_BLOCKS: t("chrome.error.tooMany"),
        CHROME_TOO_LARGE: t("chrome.error.tooLarge"),
        CHROME_BLOCK_NOT_IN_PART: t("chrome.error.notHere"),
        CHROME_UNKNOWN_TYPE: t("chrome.error.unknownType"),
        CHROME_UNKNOWN_PROP: t("chrome.error.unknownProp").replace("{field}", fieldName),
    };
    const message = known[kind] && !known[kind].startsWith("chrome.error.") ? known[kind] : raw;
    return { block, where, message };
}

/** One line per problem: "Button (Row 1 › block 2): The link must start with / or https://." */
export function formatChromeProblem(problem: ChromeProblem): string {
    const subject = [problem.block, problem.where ? `(${problem.where})` : ""].filter(Boolean).join(" ");
    return subject ? `${subject}: ${problem.message}` : problem.message;
}
