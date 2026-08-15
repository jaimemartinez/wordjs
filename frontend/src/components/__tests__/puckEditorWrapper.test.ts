/**
 * PuckEditor.tsx WRAPPER critical paths — autosave, the data-not-controlled dispatch, and the
 * fork<->wrapper global contract.
 *
 * These behaviours live inside the ~2160-line `PuckEditor` client component. Executing them means
 * MOUNTING the whole editor: it imports `@wordjs/puck` (needs its built iframe canvas), the public
 * layout shell, the theme/media/revisions APIs, and drives geometry that jsdom cannot lay out. That is
 * not runnable in this vitest harness, and honestly so — see puckHistoryUndoRedo.test.ts for the part
 * of the wrapper (undo/redo) that IS behaviour-testable through the real store. What protects the rest
 * is that the load-bearing CODE keeps its shape; a silent edit to the autosave policy or the dispatch
 * pattern is exactly the kind of regression no other check here catches. So these pin the structural
 * invariant of each path against the REAL source.
 *
 * ANTI-FALSE-PASS: assertions run against a comment-stripped copy (stripComments) and target
 * expressions that exist only in CODE (e.g. the literal `Math.max(8000, 30000 - ...)`), so a prose
 * comment can never satisfy a pin. Mutate the named expression in PuckEditor.tsx and the matching
 * `expect` goes red — e.g. change the 8000ms floor, drop `{ autosave: true }`, or make
 * `updateComponent` call `setData` directly instead of dispatching into Puck's store.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

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
    out += c;
    if (c === "\\") { out += d ?? ""; i++; continue; }
    if (s === "sq" && c === "'") s = "code";
    else if (s === "dq" && c === '"') s = "code";
    else if (s === "tpl" && c === "`") s = "code";
  }
  return out;
}

const SRC = path.resolve(import.meta.dirname, "../PuckEditor.tsx");
const code = stripComments(readFileSync(SRC, "utf8")).replace(/\s+/g, " ");

describe("PuckEditor wrapper — autosave fires + debounces (drafts only)", () => {
  it("only autosaves drafts, and skips while already saving / clean", () => {
    // Mutation: drop the `status !== "draft"` guard (autosave a published page in the background) -> fails.
    expect(code).toMatch(/if\s*\(\s*status\s*!==\s*"draft"\s*\|\|\s*!onSave\s*\|\|\s*!hasChanges\s*\|\|\s*saving\s*\)\s*return;/);
  });

  it("debounces with an 8s floor after first dirty and a 30s floor between runs", () => {
    // The exact policy. Mutation: change 8000 or 30000, or drop the lastAutosaveRef term -> fails.
    expect(code).toContain("Math.max(8000, 30000 - (Date.now() - lastAutosaveRef.current))");
    // Scheduled via a cancelable timer (debounce, not fire-immediately). Mutation: remove clearTimeout cleanup -> fails.
    expect(code).toMatch(/return\s*\(\s*\)\s*=>\s*clearTimeout\(\s*t\s*\)/);
  });

  it("marks background saves as autosave and does not stamp a save the parent rejected", () => {
    // Mutation: drop `{ autosave: true }` (parents would snapshot a revision every 8s) -> fails.
    expect(code).toMatch(/onSave\(\s*\{\s*autosave:\s*true\s*\}\s*\)/);
    // Mutation: remove the `ok === false` early-return (announce success for a blocked save) -> fails.
    expect(code).toMatch(/if\s*\(\s*ok\s*===\s*false\s*\)\s*return;/);
  });
});

describe("PuckEditor wrapper — data is NOT a controlled prop (dispatch into Puck's store)", () => {
  it("updateComponent dispatches setData into puckDispatch instead of mutating the local mirror", () => {
    // The memory rule: v0.20 data is uncontrolled — mutating our copy never reaches the rendered tree.
    // Mutation: replace this with a bare setData()/onChange() and the dispatch match fails.
    expect(code).toMatch(/\(window as any\)\.puckDispatch/);
    expect(code).toMatch(/dispatch\(\s*\{\s*type:\s*'setData',\s*data:\s*transform,\s*recordHistory:\s*true\s*\}\s*\)/);
  });

  it("keeps a local mirror only as a pre-dispatch fallback, re-synced by Puck's onChange", () => {
    // Fallback before Puck registers its dispatch. Mutation: delete the fallback branch -> fails.
    expect(code).toMatch(/const newData = transform\(dataRef\.current\);/);
    expect(code).toMatch(/setData\(newData\);/);
    // <Puck> is fed `data` and re-syncs the mirror through onChange. Mutation: drop the onChange sync -> fails.
    expect(code).toMatch(/onChange=\{\s*\(newData\)\s*=>\s*\{\s*setData\(newData\);\s*onChange\(newData\);\s*\}\s*\}/);
  });
});

describe("PuckEditor wrapper — installs the global the fork's Edit action calls", () => {
  it("assigns window.puckSetActiveEditorId so the fork's per-block Edit action can open inline editing", () => {
    // The other half of divergence 2 (see puckForkDivergence.test.ts, which pins the fork call site).
    // Mutation: rename or drop this assignment and the fork's puckSetActiveEditorId?.(id) becomes a no-op.
    expect(code).toMatch(/\(window as any\)\.puckSetActiveEditorId\s*=\s*setActiveEditorId/);
  });
});
