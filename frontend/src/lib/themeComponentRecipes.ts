export interface CardRecipeItem {
    image?: string;
    alt?: string;
    title?: string;
    titleTag?: string;
    hasMedia?: boolean;
    hasIcon?: boolean;
    hasText?: boolean;
    childOrder?: CardRecipeSlot[];
}

export type CardRecipeSlot = "media" | "icon" | "title" | "text";

const textOrUndefined = (value: unknown) =>
    typeof value === "string" && value.trim() ? value : undefined;

export function normalizeCardRecipeTitle(value: unknown): string {
    return String(value ?? "")
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
}

const booleanOrUndefined = (value: unknown) => {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
};

/** Normalize Stitch's structural names to the four slots WordJS can render. */
export function parseCardRecipeOrder(value: unknown): CardRecipeSlot[] {
    if (!Array.isArray(value)) return [];

    const order: CardRecipeSlot[] = [];
    const add = (slot: CardRecipeSlot) => {
        if (!order.includes(slot)) order.push(slot);
    };

    value.forEach((candidate) => {
        if (typeof candidate !== "string") return;
        const normalized = candidate.replace(/[^a-z]/gi, "").toLowerCase();
        if (normalized === "media" || normalized === "image") add("media");
        else if (normalized === "icon") add("icon");
        else if (normalized === "heading" || normalized === "title") add("title");
        else if (normalized === "text" || normalized === "description" || normalized === "body") add("text");
        else if (normalized === "content") {
            add("title");
            add("text");
        }
    });

    return order;
}

export function parseCardRecipeItems(value: unknown): CardRecipeItem[] {
    if (!Array.isArray(value)) return [];

    return value.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
        const raw = candidate as Record<string, unknown>;
        const rawMedia = raw.media && typeof raw.media === "object" && !Array.isArray(raw.media)
            ? raw.media as Record<string, unknown>
            : null;
        const childOrder = parseCardRecipeOrder(raw.childOrder ?? raw.childComponentOrder);
        const hasMedia = booleanOrUndefined(raw.hasMedia) ?? booleanOrUndefined(rawMedia?.present);

        return [{
            image: textOrUndefined(raw.image),
            alt: textOrUndefined(raw.alt),
            title: textOrUndefined(raw.title),
            titleTag: textOrUndefined(raw.titleTag),
            hasMedia,
            hasIcon: booleanOrUndefined(raw.hasIcon),
            hasText: booleanOrUndefined(raw.hasText),
            childOrder: childOrder.length ? childOrder : undefined,
        }];
    });
}

/**
 * Pick the media recipe for a Card without relying on render order or mutable state.
 * Only an exact normalized title may bind authored content to a Stitch sample. An
 * unmatched title must never inherit an arbitrary sample image just because its
 * hash happens to land on that item.
 */
export function selectCardRecipeItem(itemsValue: unknown, title: unknown): CardRecipeItem | null {
    const items = parseCardRecipeItems(itemsValue);
    if (!items.length) return null;

    const normalizedTitle = normalizeCardRecipeTitle(title);
    if (!normalizedTitle) return null;
    return items.find((item) => normalizeCardRecipeTitle(item.title) === normalizedTitle) ?? null;
}

export interface CardRecipeStructureResolution {
    selectedItem: CardRecipeItem | null;
    hasIcon: boolean;
    hasText: boolean;
    childOrder: CardRecipeSlot[];
}

export function shouldRenderCardSlot(authoredValue: unknown, recipeWantsSlot: boolean): boolean {
    const hasAuthoredValue = typeof authoredValue === "string"
        ? authoredValue.trim().length > 0
        : authoredValue !== null && authoredValue !== undefined && authoredValue !== false;
    return hasAuthoredValue || recipeWantsSlot;
}

/**
 * Resolve structural presentation hints. Missing slots are appended so a theme
 * can reorder authored content, but can never make explicit content unreachable.
 */
export function resolveCardRecipeStructure({
    items,
    title,
    hasIcon,
    hasText,
    childOrder,
}: {
    items: unknown;
    title: unknown;
    hasIcon: unknown;
    hasText: unknown;
    childOrder: unknown;
}): CardRecipeStructureResolution {
    const selectedItem = selectCardRecipeItem(items, title);
    const resolvedOrder = parseCardRecipeOrder(selectedItem?.childOrder ?? childOrder);
    (["media", "icon", "title", "text"] as const).forEach((slot) => {
        if (!resolvedOrder.includes(slot)) resolvedOrder.push(slot);
    });

    return {
        selectedItem,
        hasIcon: selectedItem?.hasIcon ?? booleanOrUndefined(hasIcon) ?? false,
        hasText: selectedItem?.hasText ?? booleanOrUndefined(hasText) ?? true,
        childOrder: resolvedOrder,
    };
}

export interface CardRecipeMediaResolution {
    src: string;
    alt: string;
    shouldRenderMedia: boolean;
    selectedItem: CardRecipeItem | null;
}

export function resolveCardRecipeMedia({
    items,
    title,
    showMedia,
    image,
    imageAlt,
}: {
    items: unknown;
    title: unknown;
    showMedia: boolean;
    image: unknown;
    imageAlt: unknown;
}): CardRecipeMediaResolution {
    const selectedItem = selectCardRecipeItem(items, title);
    const explicitImage = textOrUndefined(image) || "";
    const explicitAlt = textOrUndefined(imageAlt);
    const titleAlt = textOrUndefined(title) || "";
    const recipeImage = selectedItem?.image || "";
    const selectedHasMedia = selectedItem
        ? selectedItem.hasMedia ?? !!recipeImage
        : showMedia;

    return {
        src: explicitImage || (selectedHasMedia ? recipeImage : ""),
        alt: explicitImage
            ? explicitAlt || titleAlt
            : selectedItem?.alt || explicitAlt || titleAlt,
        shouldRenderMedia: !!explicitImage || selectedHasMedia,
        selectedItem,
    };
}

export function normalizeAuthoredCount(value: unknown, fallback: number, max = 12): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0
        ? Math.min(max, Math.max(1, Math.floor(parsed)))
        : fallback;
}

export function normalizeRecipeReferenceCount(value: unknown, max = 100): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0
        ? Math.min(max, Math.floor(parsed))
        : null;
}

/**
 * Recipes may describe how many samples Stitch used, but that number is only a
 * presentation hint. It must never slice or replace a user's authored array.
 */
export function resolveAuthoredCollection<T>({
    authored,
    fallback,
    recipeCount,
}: {
    authored: unknown;
    fallback: readonly T[];
    recipeCount?: unknown;
}): { items: readonly T[]; referenceCount: number | null } {
    return {
        items: Array.isArray(authored) && authored.length > 0
            ? authored as T[]
            : fallback,
        referenceCount: normalizeRecipeReferenceCount(recipeCount),
    };
}
