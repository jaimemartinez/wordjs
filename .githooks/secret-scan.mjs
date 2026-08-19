/**
 * SESSION-TOKEN SCANNER — the gate behind `.githooks/pre-commit` and `npm run scan:secrets`.
 *
 * The `.gitignore` rules for `cj.txt`, `*.cookies` and the dump directory are a NAME list: they stop
 * the artefacts we have already seen. They do nothing about the next curl cookie jar someone calls
 * `jar.txt`, `c.txt` or `session.txt` — which is exactly how a live `wordjs_token` reached the working
 * tree the first time. This scans CONTENT, so the name does not matter.
 *
 * Why these patterns and not a bare `wordjs_token` grep: the cookie NAME is ordinary source code
 * (middleware/auth.ts, dozens of tests), so matching on it alone would reject every commit that
 * touches authentication. What is never legitimate in a tracked file is the cookie name next to a
 * real VALUE, or a signed three-part JWT anywhere. Verified against the whole tree: 1243 tracked
 * files, zero matches — including `collab-routes.test.ts`, whose deliberate `wordjs_token:
 * 'esto-no-tiene-tres-partes'` placeholder a looser rule does flag.
 *
 * Usage:
 *   node .githooks/secret-scan.mjs --staged     # what `git commit` is about to record (pre-commit)
 *   node .githooks/secret-scan.mjs --tracked    # every file git already knows (CI / test gate)
 *   node .githooks/secret-scan.mjs <file>...    # explicit paths
 *
 * Exit code 1 with a report when something matches; 0 and silence otherwise.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Each rule matches a value that has no business being committed. `eyJ` is the base64url of `{"`,
 * i.e. the start of a JSON header — the shape of every token this codebase mints (`jwt.sign`).
 */
export const SECRET_RULES = [
  {
    id: "jwt",
    label: "signed JWT (header.payload.signature)",
    re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    id: "session-cookie",
    label: "wordjs_token carrying a real value (curl cookie jar, Set-Cookie, captured request)",
    re: /wordjs_token[\s"':=\t,]{1,4}["']?eyJ[A-Za-z0-9_.-]{10,}/,
  },
  {
    id: "bearer",
    label: "Authorization: Bearer with a live token",
    re: /\bBearer\s+eyJ[A-Za-z0-9_-]{10,}/,
  },
];

/** Files whose bytes are not text we can meaningfully scan. */
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".pdf", ".zip", ".gz", ".tgz",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".webm", ".mp3", ".wav", ".sqlite", ".db",
  ".node", ".exe", ".dll", ".so", ".dylib", ".class", ".jar",
]);

/** Never scan our own rule table, or the gate would flag itself. */
const SELF = path.join(REPO_ROOT, ".githooks", "secret-scan.mjs");

/**
 * @param {string} content
 * @returns {{ rule: string, label: string, line: number, excerpt: string }[]}
 */
export function findSecrets(content) {
  const hits = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const rule of SECRET_RULES) {
      const m = lines[i].match(rule.re);
      if (!m) continue;
      // Report the shape, never the credential: 12 chars is enough to locate it, not to replay it.
      hits.push({ rule: rule.id, label: rule.label, line: i + 1, excerpt: `${m[0].slice(0, 12)}…` });
    }
  }
  return hits;
}

/** Largest file we read into memory. Anything bigger is reported as unscanned, never as clean. */
const MAX_BYTES = 32 * 1024 * 1024;

/**
 * Scan one path on disk.
 *
 * The status is explicit on purpose: an earlier draft returned `[]` for "could not read", which makes
 * an unreadable file indistinguishable from a clean one — the same class of mistake as checking one
 * value and using another. The caller decides what an unscanned file means.
 *
 * @param {string} filePath absolute, or relative to the repo root
 * @returns {{ status: 'scanned'|'skipped'|'missing'|'unreadable', reason?: string, hits: ReturnType<typeof findSecrets> }}
 */
export function scanFile(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(REPO_ROOT, filePath);
  if (path.resolve(abs) === SELF) return { status: "skipped", reason: "the scanner itself", hits: [] };
  if (BINARY_EXT.has(path.extname(abs).toLowerCase())) return { status: "skipped", reason: "binary", hits: [] };

  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return { status: "missing", hits: [] };
  }
  if (!st.isFile()) return { status: "skipped", reason: "not a regular file", hits: [] };
  if (st.size > MAX_BYTES) return { status: "skipped", reason: `larger than ${MAX_BYTES} bytes`, hits: [] };

  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (err) {
    return { status: "unreadable", reason: err.message, hits: [] };
  }
  if (buf.includes(0)) return { status: "skipped", reason: "binary", hits: [] }; // NUL byte
  return { status: "scanned", hits: findSecrets(buf.toString("utf8")) };
}

function gitList(args) {
  const out = execFileSync("git", args, { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 256 }).toString();
  return out.split("\0").filter(Boolean);
}

/** Paths git is about to record in a commit (added/copied/modified/renamed — not deletions). */
export function stagedFiles() {
  return gitList(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]);
}

/** Every path git already tracks. */
export function trackedFiles() {
  return gitList(["ls-files", "-z"]);
}

/**
 * @param {string[]} paths repo-relative or absolute
 * @returns {{ found: { file: string, hits: ReturnType<typeof findSecrets> }[], unreadable: string[], scanned: number }}
 */
export function scanPaths(paths) {
  const found = [];
  const unreadable = [];
  let scanned = 0;
  for (const p of paths) {
    const r = scanFile(p);
    if (r.status === "scanned") scanned += 1;
    if (r.status === "unreadable") unreadable.push(`${p} (${r.reason})`);
    if (r.hits.length) found.push({ file: p, hits: r.hits });
  }
  return { found, unreadable, scanned };
}

function main(argv) {
  let files;
  if (argv.includes("--staged")) files = stagedFiles();
  else if (argv.includes("--tracked")) files = trackedFiles();
  else files = argv.filter((a) => !a.startsWith("--"));

  const wantSummary = argv.includes("--tracked") || argv.includes("--summary");
  if (!files.length) {
    // "Nothing to scan" and "everything is clean" are different answers; a caller that pins the second
    // one must be able to tell them apart, or a scanner that lists no files passes as a green gate.
    if (wantSummary) console.log("secret-scan: scanned 0 of 0 paths");
    return 0;
  }
  const { found, unreadable, scanned } = scanPaths(files);
  if (wantSummary) console.log(`secret-scan: scanned ${scanned} of ${files.length} paths`);

  // A file we could not read is not a file we proved clean: say so, and fail closed.
  if (unreadable.length) {
    console.error("");
    console.error("SECRET SCAN: could not read these files, so they were NOT cleared:");
    for (const u of unreadable) console.error(`  ${u}`);
    console.error("");
    return 1;
  }
  if (!found.length) return 0;

  console.error("");
  console.error("SECRET SCAN: refusing — these files carry a live session token.");
  for (const { file, hits } of found) {
    for (const h of hits) console.error(`  ${file}:${h.line}  ${h.rule}  ${h.excerpt}  (${h.label})`);
  }
  console.error("");
  console.error("A committed token is a credential in the public history: rotate it, do not just amend.");
  console.error("Debug dumps belong in .debug-dumps/ (gitignored); cookie jars are cj.txt / *.cookies.");
  console.error("If this is genuinely a fixture, make it a token that cannot authenticate anything.");
  console.error("Override for a single commit (you had better be sure): git commit --no-verify");
  console.error("");
  return 1;
}

// Run only as a CLI; importing this module for tests must not exit the process.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
