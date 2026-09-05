/**
 * GATE — the `<picture>` path is REACHABLE from the editor that is actually mounted.
 *
 * The responsive-image props (srcSet / srcSetModern / imgWidth / imgHeight) used to be written by a
 * `resolveData` hook on the Image block of components/versoConfig.tsx. Verso's registry models no
 * such hook and nothing but the anti-drift gate imports that module, so on every production path the
 * props were never written at all: `_puck_data` carried a bare `src`, the renderer's `<picture>`
 * branch was dead code, and the WebP/AVIF derivatives the upload pipeline spends time and disk on
 * could not reach a single visitor.
 *
 * This test drives the REAL producer — the Image block's media field out of lib/verso/coreBlocks, the
 * one both admin editors mount — over a REAL editor store, and then feeds the props it produced to
 * the REAL renderer. The chain is what matters: pick an image, and the public HTML gains a
 * `<picture>` with a `<source type="image/webp">`. Any link that breaks (a field that stops writing
 * the props, a store that drops them, a renderer that stops offering the format) fails here.
 *
 * ENVIRONMENT: node, like the rest of the Verso tests — no DOM, so nothing can be clicked. SSR keeps
 * no event handlers, but a MOCKED CHILD sees its props: MediaPickerModal is replaced by a component
 * that captures the `onSelect` the field hands it, which is the exact callback a click on a library
 * item would invoke.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const picker = vi.hoisted(() => ({ onSelect: null as ((item: unknown) => void) | null }));

vi.mock("@/components/MediaPickerModal", () => ({
    default: (props: { onSelect: (item: unknown) => void }) => {
        picker.onSelect = props.onSelect;
        return null;
    },
}));

import { coreBlockDefinitions } from "../coreBlocks";
import { createEditor, type EditorHandle } from "../store";
import type { CustomVersoField } from "../registry";
import { VersoPanelHandleContext } from "@/components/verso/fields/versoPanelHandleContext";
import { imageMediaPropsFor, imageMediaPropsForItem, rememberPickedMedia } from "@/lib/imageSrcset";
import { ImageBlock } from "@/components/content/blocks";
import type { MediaItem } from "@/lib/api";

/* ------------------------------------------------------------------ */
/* Fixtures — the shape backend/src/models/Media.ts really serialises.  */
/* ------------------------------------------------------------------ */

const PHOTO_URL = "/uploads/2026/09/playa-ab12cd34.jpg";

/** A raster upload with the full size ladder AND the modern derivatives beside every entry. */
const PHOTO = {
    id: 42,
    title: "Playa",
    mimeType: "image/jpeg",
    date: "2026-09-01T00:00:00.000Z",
    guid: "http://localhost:8000/uploads/2026/09/playa-ab12cd34.jpg",
    sourceUrl: PHOTO_URL,
    mediaDetails: {
        width: 1600,
        height: 900,
        file: "2026/09/playa-ab12cd34.jpg",
        filesize: 400_000,
        sources: { "image/webp": { file: "playa-ab12cd34.webp", width: 1600, height: 900 } },
        sizes: {
            medium: {
                file: "playa-ab12cd34-300x300.jpg", width: 300, height: 169,
                mimeType: "image/jpeg", filesize: 20_000,
                sources: { "image/webp": { file: "playa-ab12cd34-300x300.webp", width: 300, height: 169 } },
            },
            large: {
                file: "playa-ab12cd34-1024x1024.jpg", width: 1024, height: 576,
                mimeType: "image/jpeg", filesize: 180_000,
                sources: { "image/webp": { file: "playa-ab12cd34-1024x1024.webp", width: 1024, height: 576 } },
            },
        },
    },
} as unknown as MediaItem;

/**
 * An address the picker cannot describe: no `mediaDetails` at all, and an absolute host that is not
 * this install's uploads directory. `rememberPickedMedia` refuses it (nothing to remember), which is
 * exactly the state a hand-typed external URL reaches.
 */
const EXTERNAL = {
    id: 0,
    title: "",
    mimeType: "image/jpeg",
    date: "",
    guid: "https://cdn.example.com/hero.jpg",
    sourceUrl: "https://cdn.example.com/hero.jpg",
} as unknown as MediaItem;

/** The props the editor produced for PHOTO, as they would be stored in `_puck_data`. */
const PHOTO_PROPS = {
    srcSet:
        `${"/uploads/2026/09"}/playa-ab12cd34-300x300.jpg 300w, ` +
        `/uploads/2026/09/playa-ab12cd34-1024x1024.jpg 1024w, ${PHOTO_URL} 1600w`,
    srcSetModern: {
        "image/webp":
            "/uploads/2026/09/playa-ab12cd34-300x300.webp 300w, " +
            "/uploads/2026/09/playa-ab12cd34-1024x1024.webp 1024w, " +
            "/uploads/2026/09/playa-ab12cd34.webp 1600w",
    },
    imgWidth: 1600,
    imgHeight: 900,
};

/* ------------------------------------------------------------------ */
/* Harness.                                                            */
/* ------------------------------------------------------------------ */

const imageDef = coreBlockDefinitions.find((d) => d.type === "Image")!;
const srcField = imageDef.fields!.src as CustomVersoField;

function editorWithImage(extraProps: Record<string, unknown> = {}, src = "/placeholder-image.svg"): EditorHandle {
    const handle = createEditor({
        initialData: {
            content: [{ type: "Image", props: { id: "img-1", src, alt: "", radius: "", css: {}, ...extraProps } }],
            root: { props: {} },
        },
    });
    handle.select("img-1");
    return handle;
}

const propsOf = (handle: EditorHandle): Record<string, unknown> =>
    handle.getState().doc.nodes["img-1"].props as Record<string, unknown>;

/**
 * Render the block's own `src` control inside the panel context and hand back the callback the media
 * modal would fire. `fallback` counts the plain custom-field onChange, which must NOT run while the
 * control can reach the editor handle — that path writes `src` alone.
 */
function mountSrcField(handle: EditorHandle, value: string): { select: (item: MediaItem) => void; fallback: () => number } {
    let fallbackCalls = 0;
    picker.onSelect = null;
    renderToStaticMarkup(
        <VersoPanelHandleContext.Provider value={handle}>
            {srcField.render({
                field: srcField,
                name: "src",
                id: "src",
                value,
                onChange: () => { fallbackCalls += 1; },
            }) as React.ReactElement}
        </VersoPanelHandleContext.Provider>,
    );
    // The cast defeats control-flow narrowing: the `= null` above is the last assignment TypeScript
    // can see, but the mocked modal writes this during the render in between.
    const onSelect = picker.onSelect as ((item: unknown) => void) | null;
    if (!onSelect) throw new Error("MediaPickerModal was never rendered by the src field");
    return { select: (item: MediaItem) => onSelect(item), fallback: () => fallbackCalls };
}

/* ------------------------------------------------------------------ */

describe("Verso Image block — picking from the media library persists the responsive props", () => {
    beforeEach(() => { picker.onSelect = null; });

    it("writes src + srcSet + srcSetModern + intrinsic size, in ONE history entry", () => {
        const handle = editorWithImage();
        const field = mountSrcField(handle, "/placeholder-image.svg");

        // What a click on a library item does, in order: register the MediaItem, then commit.
        rememberPickedMedia(PHOTO);
        field.select(PHOTO);

        const props = propsOf(handle);
        expect(props.src).toBe(PHOTO_URL);
        expect(props.srcSet).toBe(PHOTO_PROPS.srcSet);
        expect(props.srcSetModern).toEqual(PHOTO_PROPS.srcSetModern);
        expect(props.imgWidth).toBe(1600);
        expect(props.imgHeight).toBe(900);
        // The control owns the whole edit while it can reach the handle: the single-prop fallback
        // would have written `src` on its own and left the other four behind.
        expect(field.fallback()).toBe(0);

        // ONE entry, not two. Two commands would let a single undo put the placeholder back while the
        // photo's srcset stayed on the block — a srcset outliving the image it describes.
        expect(handle.canUndo()).toBe(true);
        handle.undo();
        const undone = propsOf(handle);
        expect(undone.src).toBe("/placeholder-image.svg");
        expect(undone).not.toHaveProperty("srcSet");
        expect(undone).not.toHaveProperty("srcSetModern");
        expect(undone).not.toHaveProperty("imgWidth");
        expect(undone).not.toHaveProperty("imgHeight");
        expect(handle.canUndo()).toBe(false);
    });

    it("CLEARS the four props when the src becomes an address the picker never reported", () => {
        // A page loaded from storage: it already carries the photo and its variants.
        const handle = editorWithImage(PHOTO_PROPS, PHOTO_URL);
        const field = mountSrcField(handle, PHOTO_URL);

        rememberPickedMedia(EXTERNAL); // refused — no mediaDetails to remember
        field.select(EXTERNAL);

        const props = propsOf(handle);
        expect(props.src).toBe("https://cdn.example.com/hero.jpg");
        // Not "undefined": the keys are GONE, which is the prop set of an Image without variants.
        expect(props).not.toHaveProperty("srcSet");
        expect(props).not.toHaveProperty("srcSetModern");
        expect(props).not.toHaveProperty("imgWidth");
        expect(props).not.toHaveProperty("imgHeight");
    });

    it("renders <picture> with a WebP <source> from the props the editor just wrote", () => {
        const handle = editorWithImage();
        const field = mountSrcField(handle, "/placeholder-image.svg");
        rememberPickedMedia(PHOTO);
        field.select(PHOTO);

        const html = renderToStaticMarkup(<ImageBlock {...propsOf(handle)} />);

        expect(html).toContain("<picture");
        expect(html).toContain('type="image/webp"');
        expect(html).toContain("playa-ab12cd34-1024x1024.webp 1024w");
        // The <img> stays the last child and keeps the original-format ladder as the fallback.
        expect(html).toContain(`src="${PHOTO_URL}"`);
        expect(html).toContain("playa-ab12cd34-1024x1024.jpg 1024w");
        expect(html).toContain('width="1600"');
        expect(html).toContain('height="900"');
    });

    it("renders the bare <img> it always did once the src is external again", () => {
        const handle = editorWithImage(PHOTO_PROPS, PHOTO_URL);
        const field = mountSrcField(handle, PHOTO_URL);
        rememberPickedMedia(EXTERNAL);
        field.select(EXTERNAL);

        const html = renderToStaticMarkup(<ImageBlock {...propsOf(handle)} />);

        expect(html).not.toContain("<picture");
        expect(html).not.toContain("srcSet");
        expect(html).not.toContain("srcset");
        expect(html).toContain('src="https://cdn.example.com/hero.jpg"');
    });
});

describe("imageMediaPropsFor — the three outcomes", () => {
    it("builds from the registry when the src was just picked", () => {
        rememberPickedMedia(PHOTO);
        expect(imageMediaPropsFor(PHOTO_URL, {}, "/placeholder-image.svg")).toEqual(PHOTO_PROPS);
    });

    it("keeps what the block already carried when the src did not change", () => {
        // Not in the picker registry: a page loaded from storage, whose session never picked it.
        const stored = { srcSet: "/uploads/a-11223344-300x300.jpg 300w", imgWidth: 800, imgHeight: 600 };
        const same = "/uploads/a-11223344.jpg";
        expect(imageMediaPropsFor(same, stored, same)).toEqual({ ...stored, srcSetModern: undefined });
    });

    it("clears everything for any other src", () => {
        const stored = { srcSet: "/uploads/a-11223344-300x300.jpg 300w", imgWidth: 800, imgHeight: 600 };
        expect(imageMediaPropsFor("https://cdn.example.com/hero.jpg", stored, "/uploads/a-11223344.jpg")).toEqual({
            srcSet: undefined, srcSetModern: undefined, imgWidth: undefined, imgHeight: undefined,
        });
    });
});

describe("imageMediaPropsForItem — the toolbar's 'insert from the library' path", () => {
    it("derives the same props straight from the MediaItem", () => {
        expect(imageMediaPropsForItem(PHOTO)).toEqual(PHOTO_PROPS);
    });

    it("OMITS the keys an upload without derivatives cannot fill (a new block has nothing to clear)", () => {
        const plain = {
            sourceUrl: "/uploads/2026/09/tiny-99887766.png",
            guid: "http://localhost:8000/uploads/2026/09/tiny-99887766.png",
            mediaDetails: { width: 64, height: 64, file: "2026/09/tiny-99887766.png", filesize: 900, sizes: {} },
        } as unknown as MediaItem;
        expect(imageMediaPropsForItem(plain)).toEqual({ imgWidth: 64, imgHeight: 64 });
    });
});
