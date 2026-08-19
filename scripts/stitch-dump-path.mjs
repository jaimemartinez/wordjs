/**
 * WHERE DEBUG DUMPS GO — the single producer for every investigation artefact written by
 * scripts/stitch-*.mjs.
 *
 * `.gitignore` carries a `/.debug-dumps/` rule, but a rule with no producer is decoration: the dumps
 * kept landing in the repo ROOT under whatever name the operator typed (`--out probe.json`), so each
 * new name needed its own literal line in `.gitignore` and the ones nobody predicted (`page172.json`,
 * `put208.json`, `mirror2.json`) went back onto the `git add -A` list. This module makes the rule and
 * the producer agree: the ignored DIRECTORY covers the file whatever it ends up being called.
 *
 * The value this returns is the value the caller writes — no caller may sanitise one path and then
 * write another, which is how containment checks usually die.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root — this file lives in <root>/scripts/, so one level up. Independent of process.cwd(). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The one ignored directory. Anchored at the repo root, which is what `/.debug-dumps/` matches. */
export const DUMP_DIR = path.join(REPO_ROOT, ".debug-dumps");

/** True when `child` resolves to `parent` itself or to something under it. */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve the path a debug dump must be written to.
 *
 *   dumpPath("probe.json")                  -> <root>/.debug-dumps/probe.json
 *   dumpPath("sub/probe.json")              -> <root>/.debug-dumps/sub/probe.json
 *   dumpPath("<root>/page172.json")         -> <root>/.debug-dumps/page172.json   (re-homed + warned)
 *   dumpPath("../../put208.json")           -> <root>/.debug-dumps/put208.json    (re-homed + warned)
 *   dumpPath("D:/scratch/page172.json")     -> D:/scratch/page172.json            (outside the repo)
 *
 * A RELATIVE name can never escape `.debug-dumps/` — `..` segments are re-homed by BASENAME, as is
 * any destination inside the working tree, because those are exactly the cases the ignore rule cannot
 * cover. Only an explicit ABSOLUTE path outside the repo is obeyed: git can never see it, and the
 * operator asked for it by name.
 *
 * @param {string} name   file name, relative path, or absolute path
 * @param {{ mkdir?: boolean, quiet?: boolean }} [opts]
 * @returns {string} the absolute path to write — the caller must write THIS, not its own input
 */
export function dumpPath(name, opts = {}) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("dumpPath: a non-empty file name is required");
  }
  const { mkdir = true, quiet = false } = opts;

  const absolute = path.isAbsolute(name);
  const requested = absolute ? path.resolve(name) : path.resolve(DUMP_DIR, name);

  let target;
  if (isInside(DUMP_DIR, requested)) {
    target = requested;
  } else if (!absolute || isInside(REPO_ROOT, requested)) {
    // A RELATIVE name may never escape: `--out ../../put208.json` resolves outside the repo, where the
    // ignore rule cannot reach and where the operator did not knowingly aim. Only an explicit absolute
    // path is taken as a deliberate destination (handled below). An in-tree destination is the shape
    // that keeps producing uncovered files in `git status`, so it is re-homed by basename.
    target = path.join(DUMP_DIR, path.basename(requested));
    if (!quiet) {
      console.error(
        `dump: ${requested} would sit outside the ignored dump directory — writing to ` +
          `${path.relative(REPO_ROOT, target)} instead (see .gitignore /.debug-dumps/).`,
      );
    }
  } else {
    target = requested;
  }

  if (mkdir) fs.mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

/** Convenience wrapper: serialise + write + report, all against the SAME resolved path. */
export function writeDump(name, data, opts = {}) {
  const target = dumpPath(name, opts);
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  fs.writeFileSync(target, body);
  if (!opts.quiet) console.error(`wrote ${path.relative(REPO_ROOT, target) || target}`);
  return target;
}
