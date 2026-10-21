/**
 * The motion library's author-facing model (lib/motionLibrary.ts): simple mode ↔ engine body, the
 * templates, the plain-language sentence and the usage by page. The engine contract is the gate: every
 * simple motion is a NORMALIZED body, and a body maps back to the simple editor only when the round trip
 * is exact — never a lossy rewrite of an advanced motion.
 */
import { describe, expect, it } from "vitest";
import { normalizeIxSpec, SYS_IX_PRESETS, ixPresetToSpec, compileIx } from "@/lib/verso/interactions";
import {
    DEFAULT_SIMPLE,
    MOTION_TEMPLATES,
    SIMPLE_EFFECTS,
    SIMPLE_WHENS,
    describeMotion,
    editorHref,
    effectFitsWhen,
    presetUsageByPage,
    simpleToSpec,
    specToSimple,
    type SimpleMotion,
} from "@/lib/motionLibrary";
import { translations } from "@/lib/i18n";

const t = (lang: "es" | "en" | "pt") => (k: string) => (translations[lang] as Record<string, string>)[k] ?? k;

describe("simple mode ↔ engine body", () => {
    it("every effect × when that fits is a normalized body that compiles, and maps back exactly", () => {
        for (const effect of SIMPLE_EFFECTS) for (const when of SIMPLE_WHENS) {
            if (!effectFitsWhen(effect, when)) continue;
            for (const target of ["self", "children"] as const) {
                const m: SimpleMotion = { ...DEFAULT_SIMPLE, effect, when, target, stagger: target === "children" ? 120 : 0, delay: when === "scroll" ? 0 : 200, speed: when === "scroll" ? "normal" : "slow" };
                const spec = simpleToSpec(m);
                expect(spec, `${effect}/${when}/${target}`).toBeDefined();
                expect(normalizeIxSpec(spec)?.spec).toEqual(spec);
                expect(compileIx(spec)).not.toBeNull();
                expect(specToSimple(spec)).toEqual(m);
            }
        }
    });

    it("an effect that starts hidden never runs on hover or click (the block would stay invisible)", () => {
        expect(effectFitsWhen("up", "hover")).toBe(false);
        expect(effectFitsWhen("fade", "click")).toBe(false);
        expect(effectFitsWhen("lift", "hover")).toBe(true);
        expect(effectFitsWhen("up", "view")).toBe(true);
    });

    it("a body the simple editor cannot show exactly opens in Advanced (null), never simplified", () => {
        const base = simpleToSpec(DEFAULT_SIMPLE)!;
        const threeSteps = { ...base, tracks: [{ ...base.tracks![0], steps: [base.tracks![0].steps[0], { at: 50, set: { opacity: 0.5 } }, base.tracks![0].steps[1]] }] };
        const oddDuration = { ...base, tracks: [{ ...base.tracks![0], dur: 750 }] };
        const loop = { ...base, tracks: [{ ...base.tracks![0], repeat: "inf" as const }] };
        expect(specToSimple(threeSteps)).toBeNull();
        expect(specToSimple(oddDuration)).toBeNull();
        expect(specToSimple(loop)).toBeNull();
        expect(specToSimple({ v: 1, preset: "sys:fade-up" })).toBeNull();
        expect(specToSimple(null)).toBeNull();
    });

    it("every template is a simple motion (it opens in the simple editor)", () => {
        for (const tpl of MOTION_TEMPLATES) {
            const spec = simpleToSpec(tpl.motion);
            expect(spec, tpl.id).toBeDefined();
            expect(specToSimple(spec), tpl.id).toEqual(tpl.motion);
            expect(t("en")(tpl.labelKey)).not.toBe(tpl.labelKey);
        }
    });
});

describe("plain-language description", () => {
    it("reads the common motions in the admin's language", () => {
        const up = simpleToSpec(DEFAULT_SIMPLE)!;
        expect(describeMotion(up, t("es"))).toBe("Aparece subiendo al entrar en pantalla");
        expect(describeMotion(up, t("en"))).toBe("Appears sliding up when it scrolls into view");
        const stagger = simpleToSpec({ ...DEFAULT_SIMPLE, target: "children", stagger: 120 })!;
        expect(describeMotion(stagger, t("es"))).toBe("Aparece subiendo al entrar en pantalla, sus elementos uno tras otro");
        const lift = simpleToSpec({ ...DEFAULT_SIMPLE, effect: "lift", when: "hover" })!;
        expect(describeMotion(lift, t("pt"))).toBe("Levanta um pouco ao passar o mouse");
        expect(describeMotion(null, t("en"))).toBe("Does not move");
    });

    it("describes every included motion without leaking a catalogue key", () => {
        for (const p of Object.values(SYS_IX_PRESETS)) {
            const s = describeMotion(ixPresetToSpec(p), t("en"));
            expect(s, p.id).not.toMatch(/motion\./);
            expect(s.length, p.id).toBeGreaterThan(5);
        }
    });
});

describe("usage by page", () => {
    it("lists, per preset id, the pages whose blocks reference it, with a block count", () => {
        const page = (id: number, presets: string[]) => ({
            id, title: `P${id}`, type: id === 3 ? "post" : "page",
            data: { content: presets.map((preset, i) => ({ type: "Text", props: { id: `b${i}`, ix: { v: 1, preset } } })) },
        });
        const usage = presetUsageByPage([page(1, ["cards", "cards"]), page(2, ["lift"]), page(3, ["cards"])]);
        expect(usage.get("cards")).toEqual([
            { id: 1, title: "P1", type: "page", blocks: 2 },
            { id: 3, title: "P3", type: "post", blocks: 1 },
        ]);
        expect(usage.get("lift")?.length).toBe(1);
        expect(usage.get("missing")).toBeUndefined();
        expect(editorHref({ id: 3, type: "post" })).toBe("/admin/posts/3");
        expect(editorHref({ id: 1, type: "page" })).toBe("/admin/pages/1");
    });
});
