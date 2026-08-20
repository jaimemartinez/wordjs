/**
 * Read the DECLARED winning value for (element, property) pairs — using Chrome's own cascade.
 *
 * `getComputedStyle` returns USED values: `1.5rem` becomes `24px`, `repeat(3, 1fr)` becomes resolved
 * pixel tracks, a hover lift becomes a matrix — viewport-dependent and stripped of intent. Instead ask
 * the DevTools protocol (`CSS.getMatchedStylesForNode`, the API DevTools' Styles panel is built on) for
 * the rules that match the element in cascade order, and take the winning declaration's author text.
 * Chrome does the cascade; nothing is re-implemented or guessed here — and a property no rule declares
 * simply has no value, which kills the whole family of "inherited layout width read as a design choice"
 * bugs without any heuristic.
 *
 * The one substitution performed: Tailwind composes shadows/transforms from its own `--tw-*` plumbing;
 * those are replaced with their values READ from the element, so the result stands alone.
 */

/** Properties that inherit, for which an ancestor's declaration IS the design's declaration. */
const INHERITABLE = new Set([
  "color", "font-family", "font-size", "font-weight", "font-style", "line-height",
  "letter-spacing", "text-align", "text-transform", "text-shadow", "word-spacing",
  "list-style", "list-style-type", "visibility", "cursor",
]);

/**
 * @param {import('puppeteer-core').Page} page
 * @param {Array<{token:string, selector:string, cssProp:string, pseudo?:string, pseudoEl?:string}>} targets
 * @returns {Promise<Record<string, {value:string}>>}
 */
export async function readDeclared(page, targets) {
  const cdp = await page.target().createCDPSession();
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const out = {};

  // Group by selector+pseudo so each element is resolved (and each pseudo-state forced) once.
  const groups = new Map();
  for (const t of targets) {
    const key = `${t.selector}|${t.pseudo || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  try {
    for (const [key, group] of groups) {
      const [selector, pseudo] = key.split("|");
      let nodeId = null;
      try { ({ nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector })); }
      catch { continue; }
      if (!nodeId) continue;

      if (pseudo) await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [pseudo.replace("-visible", "")] });
      let matched = null;
      try { matched = await cdp.send("CSS.getMatchedStylesForNode", { nodeId }); }
      catch { /* node vanished */ }
      if (!matched) { if (pseudo) await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }).catch(() => {}); continue; }
      // Tailwind plumbing must be substituted NOW, while the state is still forced: the hover rule is
      // what sets `--tw-translate-y: -0.25rem`, so resolving later — at rest — yields the identity
      // transform and the resting shadow. Custom properties flip instantly (they do not transition),
      // so no settle wait is needed.
      const resolveTw = async (value) => {
        if (!/var\(\s*--tw-/.test(value)) return value;
        return await page.evaluate((sel, v) => {
          const el = document.querySelector(sel);
          if (!el) return v;
          const cs = getComputedStyle(el);
          let out = v, guard = 0;
          while (/var\(\s*--tw-/.test(out) && guard++ < 6) {
            out = out.replace(/var\(\s*(--tw-[a-z0-9-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
              (_, name, fb) => cs.getPropertyValue(name).trim() || (fb || "").trim() || "");
          }
          return out.replace(/\s+/g, " ").trim();
        }, selector, value);
      };

      // A box shorthand read literally falls to whatever RESET last declared it: Tailwind's preflight
      // says `button { padding: 0 }`, the design then adds `px-8 py-4` — longhands, not `padding` — and
      // the naive winner for `padding` is the reset's 0. Compose box shorthands from their longhand
      // winners, falling back to the shorthand's expansion for sides the design left alone.
      const BOX_LONGHANDS = { padding: "padding", margin: "margin" };
      const composeBox = (prefix, rules, inline, pseudo2) => {
        const short = winningDeclaration(rules, inline, prefix, pseudo2);
        const expand = (v) => { const p = String(v ?? "").trim().split(/\s+/); if (!p[0]) return null;
          return { top: p[0], right: p[1] ?? p[0], bottom: p[2] ?? p[0], left: p[3] ?? p[1] ?? p[0] }; };
        const base = expand(short);
        const sides = {};
        let anyLong = false;
        for (const side of ["top", "right", "bottom", "left"]) {
          const v = winningDeclaration(rules, inline, `${prefix}-${side}`, pseudo2);
          if (v !== null) { sides[side] = v; anyLong = true; } else if (base) sides[side] = base[side];
        }
        if (!anyLong) return short;
        if (!sides.top || !sides.right || !sides.bottom || !sides.left) return short ?? null;
        const { top, right, bottom, left } = sides;
        if (top === right && right === bottom && bottom === left) return top;
        if (top === bottom && right === left) return `${top} ${right}`;
        return `${top} ${right} ${bottom} ${left}`;
      };

      for (const t of group) {
        let value = null;
        if (BOX_LONGHANDS[t.cssProp] && !t.pseudoEl) {
          value = composeBox(t.cssProp, (matched.matchedCSSRules || []).map((m) => m.rule), matched.inlineStyle, pseudo);
          if (value !== null) { out[t.token] = { value: await resolveTw(value) }; continue; }
        }
        if (t.pseudoEl) {
          // ::before/::after arrive as their own match lists, already scoped to this element.
          const pe = (matched.pseudoElements || []).find((p) => p.pseudoType === t.pseudoEl);
          if (pe) value = winningDeclaration(pe.matches.map((m) => m.rule), null, t.cssProp, pseudo);
        } else {
          value = winningDeclaration((matched.matchedCSSRules || []).map((m) => m.rule), matched.inlineStyle, t.cssProp, pseudo);
          // Typography usually lives on <body> and INHERITS down: no rule declares font-family on the
          // description itself, but the design did declare it — on an ancestor. The protocol hands us
          // that chain; walk it nearest-first, only for properties that actually inherit.
          if (value === null && INHERITABLE.has(t.cssProp)) {
            for (const entry of matched.inherited || []) {
              value = winningDeclaration((entry.matchedCSSRules || []).map((m) => m.rule), entry.inlineStyle, t.cssProp, null);
              if (value !== null) break;
            }
          }
        }
        if (value !== null) out[t.token] = { value: await resolveTw(value) };
      }
      if (pseudo) await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }).catch(() => {});
    }
  } finally {
    await cdp.detach().catch(() => {});
  }

  return out;
}

/**
 * The winning declaration for a property: matched rules arrive in cascade order (lowest precedence
 * first), so the last author declaration wins — unless an earlier one is `!important`, which outranks
 * every later normal one. Inline styles sit above all normal rules. User-agent rules are skipped: a UA
 * default is not something the design declared.
 */
function winningDeclaration(rules, inlineStyle, cssProp, pseudo) {
  let normal = null, important = null;
  const consider = (style) => {
    for (const p of style.cssProperties || []) {
      if (p.name !== cssProp || p.value == null) continue;
      if (p.disabled || p.parsedOk === false) continue;
      if (p.important) important = p.value;
      else normal = p.value;
    }
  };
  for (const rule of rules) {
    if (!rule || rule.origin === "user-agent" || rule.origin === "injected") continue;
    // When a pseudo-state is forced we only want declarations from rules that mention that state —
    // otherwise a base rule re-reports the resting value and the state token just clones it.
    if (pseudo && !(rule.selectorList?.text || "").includes(`:${pseudo}`)) continue;
    consider(rule.style);
  }
  if (!pseudo && inlineStyle) consider(inlineStyle);
  return important ?? normal;
}
