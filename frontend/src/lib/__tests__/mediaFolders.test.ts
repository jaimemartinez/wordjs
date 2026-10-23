/**
 * The media library's folders as the screens use them (lib/mediaFolders): the tree, the indented
 * «Move to…» options, where a folder may not go, the path to a folder, the drag payload and the
 * ?folder= of the page address.
 */
import { describe, it, expect } from "vitest";
import {
    decodeDraggedIds, encodeDraggedIds, flattenFolders, folderPath, folderQuery, folderSubtree, folderTree,
    indentedLabel, parseFolderParam,
} from "@/lib/mediaFolders";

const FOLDERS = [
    { id: 1, name: "Photos", parent: 0, count: 3 },
    { id: 2, name: "Events", parent: 1, count: 1 },
    { id: 3, name: "2026", parent: 2, count: 0 },
    { id: 4, name: "Brand", parent: 0, count: 2 },
    { id: 5, name: "Lost", parent: 99, count: 0 }, // its parent is gone
];

describe("media folders as a tree", () => {
    it("nests by parent, sorts siblings by name and puts an orphan at the top level", () => {
        const tree = folderTree(FOLDERS);
        expect(tree.map((n) => n.name)).toEqual(["Brand", "Lost", "Photos"]);
        const photos = tree.find((n) => n.id === 1)!;
        expect(photos.children.map((n) => n.name)).toEqual(["Events"]);
        expect(photos.children[0].children[0]).toMatchObject({ name: "2026", depth: 2 });
    });
    it("survives a loop instead of recursing for ever", () => {
        const looped = [{ id: 1, name: "A", parent: 2, count: 0 }, { id: 2, name: "B", parent: 1, count: 0 }];
        expect(() => flattenFolders(looped)).not.toThrow();
    });
    it("flattens in tree order with indented labels for a picker", () => {
        const flat = flattenFolders(FOLDERS);
        expect(flat.map((n) => n.id)).toEqual([4, 5, 1, 2, 3]);
        expect(indentedLabel(flat.find((n) => n.id === 3)!)).toBe("— — 2026");
    });
    it("a folder cannot go inside itself or below itself", () => {
        expect([...folderSubtree(FOLDERS, 1)].sort()).toEqual([1, 2, 3]);
        expect([...folderSubtree(FOLDERS, 4)]).toEqual([4]);
    });
    it("names the way down to a folder", () => {
        expect(folderPath(FOLDERS, 3).map((f) => f.name)).toEqual(["Photos", "Events", "2026"]);
        expect(folderPath(FOLDERS, 0)).toEqual([]);
    });
});

describe("dragging cards onto a folder", () => {
    it("carries positive integer ids and nothing else", () => {
        expect(decodeDraggedIds(encodeDraggedIds([3, 7]))).toEqual([3, 7]);
        expect(decodeDraggedIds("not json")).toEqual([]);
        expect(decodeDraggedIds(JSON.stringify([1, -2, "3", 4.5, 5]))).toEqual([1, 5]);
    });
});

describe("the folder in the page address", () => {
    it("reads ?folder= and turns it into the list query", () => {
        expect(parseFolderParam(null)).toBe("all");
        expect(parseFolderParam("0")).toBe(0);
        expect(parseFolderParam("12")).toBe(12);
        expect(parseFolderParam("x")).toBe("all");
        expect(folderQuery("all")).toBeUndefined();
        expect(folderQuery(0)).toBe(0);
    });
});
