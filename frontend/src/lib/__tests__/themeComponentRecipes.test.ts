import { describe, expect, it } from "vitest";
import {
    normalizeAuthoredCount,
    normalizeRecipeReferenceCount,
    normalizeCardRecipeTitle,
    parseCardRecipeOrder,
    parseCardRecipeItems,
    resolveAuthoredCollection,
    resolveCardRecipeMedia,
    resolveCardRecipeStructure,
    selectCardRecipeItem,
    shouldRenderCardSlot,
} from "../themeComponentRecipes";

const items = [
    { title: "Starter", image: "/starter.jpg", alt: "Starter desk" },
    { title: "Premium Card", image: "/premium.jpg", alt: "Premium desk" },
    { title: "Enterprise", image: "/enterprise.jpg", alt: "Enterprise desk" },
];

describe("card component recipes", () => {
    it("normalizes an authored title before selecting an exact recipe item", () => {
        expect(normalizeCardRecipeTitle("  PREMIUM   CARD ")).toBe("premium card");
        expect(selectCardRecipeItem(items, "  PREMIUM   CARD ")).toEqual(items[1]);
    });

    it("never assigns a sample image to an unmatched authored title", () => {
        expect(selectCardRecipeItem(items, "Unmatched Card")).toBeNull();
        expect(selectCardRecipeItem(items, "")).toBeNull();

        expect(resolveCardRecipeMedia({
            items,
            title: "Unmatched Card",
            showMedia: true,
            image: "",
            imageAlt: "",
        })).toMatchObject({
            src: "",
            shouldRenderMedia: true,
            selectedItem: null,
        });
    });

    it("filters malformed recipe entries and keeps canonical media metadata", () => {
        expect(parseCardRecipeItems([
            null,
            "bad",
            { title: "Valid", image: "/valid.jpg", alt: "Alt", titleTag: "h4", hasMedia: true, hasIcon: false, hasText: true, childOrder: ["media", 7, "content"] },
        ])).toMatchObject([{
            title: "Valid",
            image: "/valid.jpg",
            alt: "Alt",
            titleTag: "h4",
            hasMedia: true,
            hasIcon: false,
            hasText: true,
            childOrder: ["media", "title", "text"],
        }]);
        expect(selectCardRecipeItem([], "Anything")).toBeNull();
    });

    it("normalizes childOrder aliases and appends omitted authored slots", () => {
        expect(parseCardRecipeOrder(["image", "content", "heading", "action", 4])).toEqual([
            "media",
            "title",
            "text",
        ]);

        expect(resolveCardRecipeStructure({
            items: [{ title: "No extras", hasIcon: false, hasText: false, childOrder: ["title"] }],
            title: "No extras",
            hasIcon: true,
            hasText: true,
            childOrder: ["media", "content"],
        })).toMatchObject({
            hasIcon: false,
            hasText: false,
            childOrder: ["title", "media", "icon", "text"],
        });

        expect(shouldRenderCardSlot("fa-user", false)).toBe(true);
        expect(shouldRenderCardSlot("Authored description", false)).toBe(true);
        expect(shouldRenderCardSlot("", true)).toBe(true);
        expect(shouldRenderCardSlot("", false)).toBe(false);
    });

    it("preserves explicit media and otherwise uses the selected recipe slot", () => {
        expect(resolveCardRecipeMedia({
            items,
            title: "Premium Card",
            showMedia: true,
            image: "/authored.jpg",
            imageAlt: "Authored alt",
        })).toMatchObject({
            src: "/authored.jpg",
            alt: "Authored alt",
            shouldRenderMedia: true,
        });

        expect(resolveCardRecipeMedia({
            items,
            title: "Premium Card",
            showMedia: true,
            image: "",
            imageAlt: "",
        })).toMatchObject({
            src: "/premium.jpg",
            alt: "Premium desk",
            shouldRenderMedia: true,
        });

        expect(resolveCardRecipeMedia({
            items: [],
            title: "No media",
            showMedia: false,
            image: "",
            imageAlt: "",
        })).toMatchObject({ src: "", shouldRenderMedia: false });

        expect(resolveCardRecipeMedia({
            items: [],
            title: "Theme media slot",
            showMedia: true,
            image: "",
            imageAlt: "",
        })).toMatchObject({ src: "", shouldRenderMedia: true });

        expect(resolveCardRecipeMedia({
            items: [{ title: "Icon only", hasMedia: false }],
            title: "Icon only",
            showMedia: true,
            image: "",
            imageAlt: "",
        })).toMatchObject({ src: "", shouldRenderMedia: false });

        expect(resolveCardRecipeMedia({
            items: [{ title: "Icon only", hasMedia: false }],
            title: "Icon only",
            showMedia: false,
            image: "/authored-despite-theme.jpg",
            imageAlt: "Explicit",
        })).toMatchObject({
            src: "/authored-despite-theme.jpg",
            alt: "Explicit",
            shouldRenderMedia: true,
        });
    });
});

describe("recipe collection integrity", () => {
    it("keeps every authored plan even when a theme reference has fewer plans", () => {
        const authored = ["Basic", "Pro", "Business", "Enterprise"];
        const resolved = resolveAuthoredCollection({
            authored,
            fallback: ["Fallback"],
            recipeCount: 1,
        });

        expect(resolved.items).toBe(authored);
        expect(resolved.items).toHaveLength(4);
        expect(resolved.referenceCount).toBe(1);
    });

    it("does not replace authored tabs with a different theme's sample labels", () => {
        const authored = [
            { label: "Authored A", content: "A" },
            { label: "Authored B", content: "B" },
            { label: "Authored C", content: "C" },
        ];
        const fallback = [{ label: "Stable fallback", content: "Fallback" }];

        expect(resolveAuthoredCollection({ authored, fallback, recipeCount: 2 }).items).toBe(authored);
        expect(resolveAuthoredCollection({ authored, fallback, recipeCount: 0 }).items).toBe(authored);
        expect(authored.map((tab) => tab.label)).toEqual(["Authored A", "Authored B", "Authored C"]);
    });

    it("treats a zero-count recipe as metadata and keeps stable fallbacks visible", () => {
        const fallback = ["one", "two", "three"];
        const resolved = resolveAuthoredCollection<string>({
            authored: [],
            fallback,
            recipeCount: 0,
        });

        expect(resolved.items).toBe(fallback);
        expect(resolved.items).toHaveLength(3);
        expect(resolved.referenceCount).toBe(0);
        expect(normalizeRecipeReferenceCount(0)).toBe(0);
    });

    it("derives post limits only from the authored block setting", () => {
        expect(normalizeAuthoredCount(8, 6)).toBe(8);
        expect(normalizeAuthoredCount(0, 6)).toBe(6);
        expect(normalizeAuthoredCount(99, 6)).toBe(12);
    });
});
