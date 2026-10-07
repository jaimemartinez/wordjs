/**
 * The «Recently refused» label, RENDERED (review UX-2). The strings test only proves the keys exist, and
 * three mutants of the page passed every frontend test: reading `hint` instead of `source`, never
 * showing the label, and inverting the heading's condition. The label is now its own component, rendered
 * here with the real strings; siteAddressStrings.test.ts pins that the page's row renders it from
 * `entry.source`, and siteAddress.test.ts pins the heading and the IP-rule keys.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translations } from "@/lib/i18n";
import { RefusedByLabel } from "../RefusedByLabel";

const en = (key: string) => translations.en[key] ?? key;
const render = (source: "edge" | "gate" | "both" | null) => renderToStaticMarkup(<RefusedByLabel source={source} t={en} />);
/** What React writes for text in an attribute or an element. */
const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("RefusedByLabel", () => {
    it("names who refused the host, with the explanation as its tooltip", () => {
        const title = `title="${escaped(translations.en["siteAddress.refusedBy.help"])}"`;
        for (const [source, text] of [["edge", "Edge"], ["gate", "Backend"], ["both", "Edge + backend"]] as const) {
            const html = render(source);
            expect(html.startsWith("<span ")).toBe(true);
            expect(html).toContain(title);
            expect(html.endsWith(`>${escaped(text)}</span>`)).toBe(true);
        }
    });

    it("renders nothing when the backend did not say (an older version)", () => {
        expect(render(null)).toBe("");
    });
});
