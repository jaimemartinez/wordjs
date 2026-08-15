/**
 * WordJS - Dependency-free text diff
 *
 * A small LCS (longest-common-subsequence) diff used by core/revisions.ts to turn a pair of
 * revisions into structured added/removed segments the admin UI can render — instead of the three
 * title/content/excerpt "changed y/n" booleans compareRevisions() historically returned.
 *
 * NO heavy dependency: this is the textbook O(n·m) LCS over a token array, with the common
 * prefix/suffix trimmed first so the DP only runs on the changed middle (revisions typically edit a
 * small region), and a hard cap beyond which we degrade to a single removed+added segment rather
 * than allocate a giant matrix or freeze the request.
 *
 * Tokenization is LOSSLESS: whitespace (word mode) / newlines (line mode) are their own tokens, so
 * the concatenation of a segment's values reconstructs the exact input. That reconstruction is the
 * correctness contract the tests pin:
 *   • join(value of every 'same' | 'removed' segment, in order) === oldText
 *   • join(value of every 'same' | 'added'   segment, in order) === newText
 * and symmetry: the multiset of words 'added' by diff(a,b) equals the multiset 'removed' by diff(b,a).
 */

export type DiffSegmentType = 'same' | 'added' | 'removed';
export interface DiffSegment {
    type: DiffSegmentType;
    value: string;
}

export type DiffMode = 'word' | 'line';

// Beyond this many (changed-a × changed-b) tokens we skip the DP: the matrix and backtrack would be
// disproportionate to any diff a human reads. The caller still gets correct — if coarse — segments.
const LCS_CELL_CAP = 4_000_000;

/**
 * Split text into lossless tokens. Word mode keeps runs of whitespace as their own tokens; line mode
 * keeps the newline as its own token. Either way, joining the tokens back yields the original string,
 * so a diff assembled from them can reconstruct both sides exactly.
 */
function tokenize(text: unknown, mode: DiffMode): string[] {
    const s = text == null ? '' : String(text);
    if (s.length === 0) return [];
    // Capturing split → the delimiters are retained as elements; drop only the empty strings the
    // split can produce at the very ends (never a real token, never whitespace we need to keep).
    const parts = mode === 'line' ? s.split(/(\n)/) : s.split(/(\s+)/);
    return parts.filter((t) => t.length > 0);
}

/** Coalesce a run of same-typed ops into one segment (concatenating their token values). */
function pushSegment(out: DiffSegment[], type: DiffSegmentType, value: string): void {
    if (!value) return;
    const last = out[out.length - 1];
    if (last && last.type === type) last.value += value;
    else out.push({ type, value });
}

/**
 * Structured diff between two strings. Returns an ordered list of {type, value} segments where
 * consecutive same-typed tokens are merged. `added` segments exist only in newText, `removed` only in
 * oldText, `same` in both.
 */
function diffText(oldText: unknown, newText: unknown, mode: DiffMode = 'word'): DiffSegment[] {
    const a = tokenize(oldText, mode);
    const b = tokenize(newText, mode);
    const out: DiffSegment[] = [];

    // Common prefix.
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) {
        pushSegment(out, 'same', a[start]);
        start++;
    }
    // Common suffix (not crossing the prefix already consumed).
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }

    const ca = a.slice(start, endA);
    const cb = b.slice(start, endB);
    const m = ca.length;
    const n = cb.length;

    if (m === 0 && n === 0) {
        // no changed middle
    } else if (m === 0) {
        for (const w of cb) pushSegment(out, 'added', w);
    } else if (n === 0) {
        for (const w of ca) pushSegment(out, 'removed', w);
    } else if (m * n > LCS_CELL_CAP) {
        // Too large for the DP — degrade to a single removed-then-added block. Still lossless:
        // reconstruction and symmetry both hold (everything old is removed, everything new is added).
        for (const w of ca) pushSegment(out, 'removed', w);
        for (const w of cb) pushSegment(out, 'added', w);
    } else {
        // LCS lengths, filled from the bottom-right so the forward backtrack yields in-order output.
        const width = n + 1;
        const dp = new Int32Array((m + 1) * width);
        for (let i = m - 1; i >= 0; i--) {
            for (let j = n - 1; j >= 0; j--) {
                dp[i * width + j] = ca[i] === cb[j]
                    ? dp[(i + 1) * width + (j + 1)] + 1
                    : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < m && j < n) {
            if (ca[i] === cb[j]) {
                pushSegment(out, 'same', ca[i]);
                i++;
                j++;
            } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
                pushSegment(out, 'removed', ca[i]);
                i++;
            } else {
                pushSegment(out, 'added', cb[j]);
                j++;
            }
        }
        while (i < m) { pushSegment(out, 'removed', ca[i]); i++; }
        while (j < n) { pushSegment(out, 'added', cb[j]); j++; }
    }

    // Common suffix.
    for (let k = endA; k < a.length; k++) pushSegment(out, 'same', a[k]);
    return out;
}

/** Convenience counts an API/UI can show without re-walking the segments. */
function diffStats(segments: DiffSegment[]): { added: number; removed: number; changed: boolean } {
    let added = 0;
    let removed = 0;
    for (const s of segments) {
        if (s.type === 'added') added++;
        else if (s.type === 'removed') removed++;
    }
    return { added, removed, changed: added > 0 || removed > 0 };
}

// CommonJS runtime export (the type declarations above are erased at compile time, so they do not
// conflict with this assignment). Consumers `require('./text-diff')`.
module.exports = { diffText, diffStats, tokenize };
