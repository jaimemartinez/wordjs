#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  CHROME_STRUCTURAL_SELECTORS,
  CHROME_SELECTORS,
  PUCK_SELECTORS,
  STRUCTURAL_SELECTORS,
} from "./wordjs-theme-contract.mjs";

const root = path.resolve(import.meta.dirname, "..");
const puckSource = fs.readFileSync(path.join(root, "frontend/src/components/puckConfig.tsx"), "utf8");
const chromeSource = [
  "frontend/src/components/public/Header.tsx",
  "frontend/src/components/public/Footer.tsx",
  "frontend/src/components/public/PublicLayoutShell.tsx",
].map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");

function missingFrom(source, selectors) {
  return selectors.filter((selector) => !source.includes(selector.slice(1)));
}

const missingPuckRoots = missingFrom(puckSource, PUCK_SELECTORS);
const missingPuckStructure = missingFrom(puckSource, STRUCTURAL_SELECTORS);
const missingChrome = missingFrom(chromeSource, CHROME_SELECTORS);
const missingChromeStructure = missingFrom(chromeSource, CHROME_STRUCTURAL_SELECTORS);

if (missingPuckRoots.length || missingPuckStructure.length || missingChrome.length || missingChromeStructure.length) {
  const details = [
    missingPuckRoots.length ? `Puck roots: ${missingPuckRoots.join(", ")}` : "",
    missingPuckStructure.length ? `Puck structure: ${missingPuckStructure.join(", ")}` : "",
    missingChrome.length ? `Chrome: ${missingChrome.join(", ")}` : "",
    missingChromeStructure.length ? `Chrome structure: ${missingChromeStructure.join(", ")}` : "",
  ].filter(Boolean).join("\n");
  throw new Error(`WordJS theme DOM contract is incomplete:\n${details}`);
}

process.stdout.write(JSON.stringify({
  valid: true,
  puckRoots: PUCK_SELECTORS.length,
  puckStructuralHooks: STRUCTURAL_SELECTORS.length,
  chromeHooks: CHROME_SELECTORS.length,
  chromeStructuralHooks: CHROME_STRUCTURAL_SELECTORS.length,
}, null, 2) + "\n");
