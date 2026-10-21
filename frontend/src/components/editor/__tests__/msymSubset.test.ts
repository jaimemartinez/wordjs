/**
 * Every Material Symbols name the editor chrome asks for must exist in the self-hosted NAMED-ICON
 * SUBSET (public/fonts/material-symbols-outlined-subset.woff2). A name outside it does not fall back
 * to a box: the ligature never fires, so the browser paints the raw name ("PERM_MEDIA",
 * "ACCESSIBILITY_NEW") at icon size, wider than the menu it sits in.
 *
 * The subset ships no manifest, so this test reads the ligature table straight out of the font:
 * WOFF2 header → brotli stream → cmap (glyph → char) + GSUB lookup type 4 (ligatures). Neither
 * table is transformed by WOFF2, so no glyf/loca reconstruction is needed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";

const FRONTEND = resolve(__dirname, "../../../..");
const FONT = join(FRONTEND, "public/fonts/material-symbols-outlined-subset.woff2");

const KNOWN_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB"];

function readTables(buf: Buffer): Record<string, Buffer> {
    const numTables = buf.readUInt16BE(12);
    const totalCompressed = buf.readUInt32BE(20);
    let p = 48;
    const base128 = () => {
        let v = 0;
        for (let i = 0; i < 5; i++) {
            const c = buf[p++];
            v = v * 128 + (c & 0x7f);
            if (!(c & 0x80)) return v;
        }
        throw new Error("bad UIntBase128");
    };
    const dir: { tag: string; len: number }[] = [];
    for (let i = 0; i < numTables; i++) {
        const flags = buf[p++];
        let tag: string;
        if ((flags & 0x3f) === 63) {
            tag = buf.toString("latin1", p, p + 4);
            p += 4;
        } else {
            tag = KNOWN_TAGS[flags & 0x3f] ?? `#${flags & 0x3f}`;
        }
        const version = (flags >> 6) & 3;
        let len = base128();
        const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
        if (transformed) len = base128();
        dir.push({ tag, len });
    }
    const data = brotliDecompressSync(buf.subarray(p, p + totalCompressed));
    const out: Record<string, Buffer> = {};
    let off = 0;
    for (const t of dir) {
        out[t.tag] = data.subarray(off, off + t.len);
        off += t.len;
    }
    return out;
}

function glyphToChar(cmap: Buffer): Map<number, string> {
    const map = new Map<number, string>();
    const n = cmap.readUInt16BE(2);
    for (let i = 0; i < n; i++) {
        const off = cmap.readUInt32BE(4 + i * 8 + 4);
        if (cmap.readUInt16BE(off) !== 4) continue;
        const segX2 = cmap.readUInt16BE(off + 6);
        const ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
        for (let s = 0; s < segX2 / 2; s++) {
            const end = cmap.readUInt16BE(ends + s * 2), start = cmap.readUInt16BE(starts + s * 2);
            const delta = cmap.readInt16BE(deltas + s * 2), ro = cmap.readUInt16BE(ranges + s * 2);
            for (let ch = start; ch <= end && ch !== 0xffff; ch++) {
                let g = ro === 0 ? (ch + delta) & 0xffff : cmap.readUInt16BE(ranges + s * 2 + ro + (ch - start) * 2);
                if (ro !== 0 && g) g = (g + delta) & 0xffff;
                if (g && !map.has(g)) map.set(g, String.fromCharCode(ch));
            }
        }
    }
    return map;
}

function ligatureNames(gsub: Buffer, chars: Map<number, string>): Set<string> {
    const names = new Set<string>();
    const coverage = (off: number): number[] => {
        const fmt = gsub.readUInt16BE(off), count = gsub.readUInt16BE(off + 2), out: number[] = [];
        if (fmt === 1) for (let i = 0; i < count; i++) out.push(gsub.readUInt16BE(off + 4 + i * 2));
        else for (let i = 0; i < count; i++) {
            const s = gsub.readUInt16BE(off + 4 + i * 6), e = gsub.readUInt16BE(off + 6 + i * 6);
            for (let g = s; g <= e; g++) out.push(g);
        }
        return out;
    };
    const ligSubtable = (st: number) => {
        const cov = coverage(st + gsub.readUInt16BE(st + 2));
        const setCount = gsub.readUInt16BE(st + 4);
        for (let i = 0; i < setCount; i++) {
            const set = st + gsub.readUInt16BE(st + 6 + i * 2);
            const ligCount = gsub.readUInt16BE(set);
            for (let j = 0; j < ligCount; j++) {
                const lig = set + gsub.readUInt16BE(set + 2 + j * 2);
                const compCount = gsub.readUInt16BE(lig + 2);
                let name = chars.get(cov[i]) ?? "?";
                for (let k = 1; k < compCount; k++) name += chars.get(gsub.readUInt16BE(lig + 4 + (k - 1) * 2)) ?? "?";
                names.add(name);
            }
        }
    };
    const lookupList = gsub.readUInt16BE(8);
    const lookups = gsub.readUInt16BE(lookupList);
    for (let i = 0; i < lookups; i++) {
        const lk = lookupList + gsub.readUInt16BE(lookupList + 2 + i * 2);
        const type = gsub.readUInt16BE(lk);
        const subCount = gsub.readUInt16BE(lk + 4);
        for (let j = 0; j < subCount; j++) {
            let st = lk + gsub.readUInt16BE(lk + 6 + j * 2);
            let t = type;
            if (t === 7) {
                t = gsub.readUInt16BE(st + 2);
                st += gsub.readUInt32BE(st + 4);
            }
            if (t === 4) ligSubtable(st);
        }
    }
    return names;
}

function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
        if (e === "node_modules" || e === "__tests__") continue;
        const f = join(dir, e);
        if (statSync(f).isDirectory()) walk(f, out);
        else if (/\.(tsx?|jsx?)$/.test(e)) out.push(f);
    }
    return out;
}

/** Icon names written as literals where the code asks MSym for a glyph. */
function requestedNames(): Map<string, string> {
    const found = new Map<string, string>();
    for (const file of walk(join(FRONTEND, "src"))) {
        // Comments mention names on purpose ("menu" is NOT in the subset) — only code counts.
        const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        const rel = file.slice(FRONTEND.length + 1);
        const add = (n: string) => { if (!found.has(n)) found.set(n, rel); };
        for (const m of src.matchAll(/<MSym\s+name="([a-z0-9_]+)"/g)) add(m[1]);
        for (const m of src.matchAll(/<MSym\s+name=\{([^}]*)\}/g)) {
            // Only the literals the expression can EVALUATE to (ternary arms, fallbacks), not the
            // ones it compares against (`r.type === "page" ? … : …`).
            for (const lit of m[1].matchAll(/(?:^|[?:]|\|\|)\s*"([a-z0-9_]+)"/g)) add(lit[1]);
        }
        if (src.includes("MSym") || /\bms:\s*"/.test(src)) {
            for (const m of src.matchAll(/\bms:\s*"([a-z0-9_]+)"/g)) add(m[1]);
        }
    }
    return found;
}

describe("Material Symbols subset", () => {
    const tables = readTables(readFileSync(FONT));
    const subset = ligatureNames(tables.GSUB, glyphToChar(tables.cmap));

    it("reads the ligature table out of the shipped font", () => {
        expect(subset.size).toBeGreaterThan(100);
        expect(subset.has("more_vert")).toBe(true);
    });

    it("every icon name the editor requests exists in the subset", () => {
        const missing = [...requestedNames()].filter(([n]) => !subset.has(n)).map(([n, f]) => `${n} (${f})`);
        expect(missing).toEqual([]);
    });
});
