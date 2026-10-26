import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { marketplaceSourceKey, marketplaceSourceKeysPayload, normMarketplaceSource } from "@/lib/api";
import { SourceStatusBadges } from "../MarketplaceTab";
import { t as translate } from "@/lib/i18n";

/**
 * Signed marketplace catalogs in the sources editor: the administrator pins an optional Ed25519 public key
 * per source (PUT /sources `keys`), and each source shows whether its catalog verified, was unsigned, or was
 * refused (with the server's error).
 */

const en = (key: string) => translate(key, "en");

describe("marketplace source keys", () => {
    it("looks a row's key up by the server's normalized URL", () => {
        expect(normMarketplaceSource("https://Catalog.Example/dist//")).toBe("https://catalog.example/dist");
        const keys = { "https://catalog.example/dist": "KEY" };
        expect(marketplaceSourceKey(keys, "https://Catalog.Example/dist/")).toBe("KEY");
        expect(marketplaceSourceKey(keys, "https://other.example")).toBe("");
        expect(marketplaceSourceKey(undefined, "https://catalog.example/dist")).toBe("");
    });

    it("sends one trimmed key per listed URL ('' unpins) and never a URL outside the list", () => {
        const payload = marketplaceSourceKeysPayload(
            ["https://a.example", "https://b.example"],
            { "https://a.example": "  KEY-A \n", "https://removed.example": "KEY-R" },
        );
        expect(payload).toEqual({ "https://a.example": "KEY-A", "https://b.example": "" });
    });
});

describe("source status badges", () => {
    const html = (status: Parameters<typeof SourceStatusBadges>[0]["status"]) =>
        renderToStaticMarkup(<SourceStatusBadges status={status} t={en} />);

    it("shows Signed (verified) or Unsigned for a loaded source", () => {
        const verified = html({ url: "https://a.example", isLocal: false, ok: true, count: 3, signature: "verified" });
        expect(verified).toContain(`data-signature="verified"`);
        expect(verified).toContain(en("plugins.marketplace.signatureVerified"));
        const unsigned = html({ url: "https://a.example", isLocal: false, ok: true, count: 3, signature: "unsigned" });
        expect(unsigned).toContain(`data-signature="unsigned"`);
        expect(unsigned).toContain(en("plugins.marketplace.signatureUnsigned"));
    });

    it("a refused source shows the error, not a signature", () => {
        const out = html({ url: "https://a.example", isLocal: false, ok: false, error: "signature missing" });
        expect(out).toContain("signature missing");
        expect(out).not.toContain("data-signature");
        expect(html(undefined)).toBe("");
    });
});
