/**
 * FORK DIVERGENCE PINS — @wordjs/puck vs upstream Puck v0.20.2.
 *
 * The vendored fork (frontend/packages/puck) ships FOUR `WORDJS`-marked code sites plus one marked
 * site in Preview — two functional divergences from upstream (see NOTICE.md):
 *   (1) editor chrome portalled OUTSIDE the canvas iframe (Preview overlay layer + DraggableComponent
 *       portal target + getStyle 1:1 geometry + scroll re-sync), and
 *   (2) a per-block "Edit" action for Text/Heading.
 * Upstream's own tests cover none of this, and these are the sites most likely to silently regress on
 * any future re-sync. Their real behaviour is geometry inside a live cross-document iframe — jsdom has
 * no layout engine (getBoundingClientRect is all-zero) and the logic is locked in React-effect
 * closures, so it is NOT executable in this harness. What IS provable, and what actually protects the
 * divergence, is that the load-bearing CODE is present and shaped as the divergence requires. So these
 * pin the structural invariant of each site against the REAL source.
 *
 * ANTI-FALSE-PASS: every assertion targets a construct that exists only in CODE, and each is checked
 * against a comment-stripped copy of the source (stripComments below), so a `WORDJS` prose comment can
 * never satisfy a pin. Each pin is proven to FAIL under a mutation of its site — see the sibling
 * comments; mutate the named construct in the fork and the matching `expect` goes red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "../../../packages/puck");
const read = (rel: string) => readFileSync(path.join(PKG, rel), "utf8");

/** Strip line + block comments and string/template/regex-safe-ish, then collapse whitespace. A tiny
 *  state machine — NOT a full parser, but enough to guarantee no assertion below can match text that
 *  lives inside a `//` or block comment. */
function stripComments(src: string): string {
  let out = "";
  let s: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const d = src[i + 1];
    if (s === "code") {
      if (c === "/" && d === "/") { s = "line"; i++; continue; }
      if (c === "/" && d === "*") { s = "block"; i++; continue; }
      if (c === "'") { s = "sq"; out += c; continue; }
      if (c === '"') { s = "dq"; out += c; continue; }
      if (c === "`") { s = "tpl"; out += c; continue; }
      out += c; continue;
    }
    if (s === "line") { if (c === "\n") { s = "code"; out += c; } continue; }
    if (s === "block") { if (c === "*" && d === "/") { s = "code"; i++; } continue; }
    // inside a string/template: copy verbatim, honour escapes, exit on the matching quote
    out += c;
    if (c === "\\") { out += d ?? ""; i++; continue; }
    if (s === "sq" && c === "'") s = "code";
    else if (s === "dq" && c === '"') s = "code";
    else if (s === "tpl" && c === "`") s = "code";
  }
  return out;
}

/** normalized (comment-free, whitespace-collapsed) code, cached per file */
const codeCache = new Map<string, string>();
const code = (rel: string): string => {
  if (!codeCache.has(rel)) codeCache.set(rel, stripComments(read(rel)).replace(/\s+/g, " "));
  return codeCache.get(rel)!;
};

const DRAG = "components/DraggableComponent/index.tsx";
const PREVIEW = "components/Puck/components/Preview/index.tsx";

describe("fork divergence — honesty of the marker inventory", () => {
  it("carries a WORDJS marker at every one of the five change sites (4 in DraggableComponent + 1 in Preview)", () => {
    // Raw source (comments included) — the markers ARE comments; this pin is about their count/spread.
    const drag = read(DRAG);
    const preview = read(PREVIEW);
    const dragMarkers = (drag.match(/WORDJS/g) || []).length;
    // Mutation: delete any WORDJS comment in DraggableComponent -> count drops below 4 -> fails.
    expect(dragMarkers).toBeGreaterThanOrEqual(4);
    // Mutation: drop the marker added to the Preview overlay layer -> fails.
    expect(preview).toMatch(/WORDJS/);
  });

  it("NOTICE.md enumerates BOTH divergences and no longer claims a single functional change", () => {
    const notice = read("NOTICE.md");
    // The dishonest phrasings this task removed. If any returns, the note is lying again.
    // Mutation: revert NOTICE to "## The only functional change" -> fails.
    expect(notice).not.toMatch(/only functional change|single functional change|the only functional change from upstream/i);
    // Both divergences must be named.
    expect(notice).toMatch(/overlay-layer|overlay layer|portal/i);
    expect(notice).toMatch(/\bEdit\b.*\b(action|Text\/Heading|Heading)\b/i);
  });
});

describe("divergence 1 — editor chrome portalled OUTSIDE the canvas iframe", () => {
  it("Preview renders a click-through overlay layer in the parent document", () => {
    const c = code(PREVIEW);
    // The layer element + its load-bearing style. Mutation: change pointerEvents to "auto", or drop
    // inset/overflow, or remove the data-puck-overlay-layer attribute -> fails. (pointerEvents:"none",
    // position:"absolute" etc. appear only in the JSX, never in a comment.)
    expect(c).toContain("data-puck-overlay-layer");
    expect(c).toMatch(/position:\s*"absolute"/);
    expect(c).toMatch(/inset:\s*0/);
    expect(c).toMatch(/overflow:\s*"hidden"/);
    expect(c).toMatch(/pointerEvents:\s*"none"/);
  });

  it("DraggableComponent resolves its portal target to that parent layer (via frameElement), not the iframe body", () => {
    const c = code(DRAG);
    // Bridges out of the iframe to the preview's overlay layer. Mutation: replace the querySelector
    // chain with `ownerDocument.body` (upstream behaviour) -> both matches fail.
    expect(c).toMatch(/\.frameElement/);
    expect(c).toContain('querySelector<HTMLElement>(":scope > [data-puck-overlay-layer]")');
    // Fallback to iframe body preserved (so nothing breaks when the layer is absent).
    expect(c).toMatch(/setPortalEl\(\s*layer\s*\?\?/);
  });

  it("getStyle uses 1:1 geometry (no scroll term, no scale division) when portalled to the layer", () => {
    const c = code(DRAG);
    // The divergent branch is guarded by the layer attribute and returns the raw rect. Mutation:
    // delete the `if (... hasAttribute ... "data-puck-overlay-layer")` branch so the overlay falls
    // through to the scaled math -> the guard match fails.
    expect(c).toContain('portalEl?.hasAttribute?.("data-puck-overlay-layer")');
    // Within the file, the raw-rect return exists (left:`${rect.left}px`) — upstream never returns an
    // unscaled rect.left for the iframe path.
    expect(c).toMatch(/left:\s*`\$\{rect\.left\}px`/);
    expect(c).toMatch(/top:\s*`\$\{rect\.top\}px`/);
  });

  it("DraggableComponent re-syncs the overlay on canvas scroll + resize (capture phase, only while visible)", () => {
    const c = code(DRAG);
    // Mutation: remove the capture-phase scroll listener (or flip capture:false) -> fails.
    expect(c).toMatch(/addEventListener\(\s*"scroll",\s*onChange,\s*\{\s*capture:\s*true/);
    expect(c).toMatch(/addEventListener\(\s*"resize",\s*onChange/);
    // Guarded on visibility so it stays cheap. Mutation: drop `!isVisible` guard -> fails.
    expect(c).toMatch(/if\s*\(\s*!iframe\.enabled\s*\|\|\s*!isVisible/);
  });
});

describe("divergence 2 — per-block Edit action for Text/Heading", () => {
  it("renders the Edit ActionBar action ONLY for Text/Heading and opens the WordJS inline editor", () => {
    const c = code(DRAG);
    // Type gate. Mutation: drop the `componentType === "Text" || ...` condition (always render) or
    // change the types -> fails.
    expect(c).toMatch(/componentType\s*===\s*"Text"\s*\|\|\s*componentType\s*===\s*"Heading"/);
    // The label + the exact cross-boundary call into PuckEditor's global. Mutation: rename the global
    // or drop the call -> fails.
    expect(c).toMatch(/label="Edit"/);
    expect(c).toMatch(/puckSetActiveEditorId\?\.\(id\)/);
  });
});
