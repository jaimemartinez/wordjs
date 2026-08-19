/**
 * Wire this directory as git's hook path: `npm run hooks:install`.
 *
 * Versioned hooks only work if git is told to look here — `core.hooksPath` is per-clone local config,
 * so it cannot be committed and every clone has to opt in once. Doing it through a script (instead of
 * asking people to remember a git incantation) is what makes the gate reproducible.
 *
 * `core.hooksPath` REPLACES `.git/hooks`. Every hook in here delegates to its local namesake first
 * (see _local.sh), so the theme-tokens pre-push gate and graphify's post-commit keep working.
 *
 * Also restores the executable bit: git only runs a hook it can execute, and a clone made on Windows
 * (core.fileMode=false) checks these out as 0644.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HOOKS_DIR, "..");
const HOOKS = ["pre-commit", "pre-push", "post-commit", "post-checkout"];

try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: REPO_ROOT, stdio: "inherit" });
} catch (err) {
  console.error("hooks:install: could not set core.hooksPath —", err.message);
  process.exit(1);
}

for (const name of HOOKS) {
  const file = path.join(HOOKS_DIR, name);
  if (!fs.existsSync(file)) {
    console.error(`hooks:install: missing hook ${name} — the directory is incomplete.`);
    process.exit(1);
  }
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    /* no-op on filesystems without a mode bit */
  }
}

const active = execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: REPO_ROOT })
  .toString()
  .trim();
if (active !== ".githooks") {
  console.error(`hooks:install: core.hooksPath is "${active}", expected ".githooks".`);
  process.exit(1);
}
console.log("hooks:install: core.hooksPath = .githooks  (pre-commit now scans staged files for session tokens)");
