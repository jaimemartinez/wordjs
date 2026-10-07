/**
 * Shared source slicer for suites that run SHIPPED plugin functions without booting the whole plugin.
 *
 * It cuts a top-level `function name(...) { ... }` (or an object-literal method body) verbatim out of a
 * plugin source file, brace-matching while skipping strings, comments and regex literals. Suites then
 * evaluate the slices with only the plugin's I/O seams stubbed, so a behaviour change in the plugin is
 * visible immediately — there is no parallel copy of the logic to drift. A missing or renamed function
 * FAILS LOUDLY rather than silently dropping coverage.
 */
import assert from 'node:assert';

export function createSlicer(src: string, suite: string) {
    /**
     * Brace-match from an index pointing at the '{' that opens a block, skipping over strings, comments
     * and regex literals so a '}' inside one of them does not close the block early.
     */
    function matchBrace(text: string, openIdx: number): number {
        let depth = 0;
        let inStr: string | null = null;
        let inLineComment = false;
        let inBlockComment = false;
        let inRegex = false;
        let prev = '';
        for (let i = openIdx; i < text.length; i++) {
            const c = text[i];
            const n = text[i + 1];
            if (inLineComment) { if (c === '\n') inLineComment = false; prev = c; continue; }
            if (inBlockComment) { if (c === '*' && n === '/') { inBlockComment = false; i++; } prev = c; continue; }
            if (inStr) { if (c === '\\') { i++; prev = ''; continue; } if (c === inStr) inStr = null; prev = c; continue; }
            if (inRegex) { if (c === '\\') { i++; prev = ''; continue; } if (c === '/') inRegex = false; prev = c; continue; }
            if (c === '/' && n === '/') { inLineComment = true; i++; prev = ''; continue; }
            if (c === '/' && n === '*') { inBlockComment = true; i++; prev = ''; continue; }
            if (c === '"' || c === "'" || c === '`') { inStr = c; prev = c; continue; }
            // A '/' is a regex literal iff the previous significant character cannot end an expression.
            if (c === '/' && !/[A-Za-z0-9_$)\]]/.test(prev)) { inRegex = true; prev = ''; continue; }
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) return i; }
            if (!/\s/.test(c)) prev = c;
        }
        throw new Error(`${suite}: unbalanced braces from offset ${openIdx} in ${src}`);
    }

    /** Match '(' … ')' so a default parameter value containing '{' (evaluateSPF's `budget = { lookups: 0 }`)
     *  is not mistaken for the start of the function body. */
    function matchParen(text: string, openIdx: number): number {
        let depth = 0;
        for (let i = openIdx; i < text.length; i++) {
            if (text[i] === '(') depth++;
            else if (text[i] === ')') { depth--; if (depth === 0) return i; }
        }
        throw new Error(`${suite}: unbalanced parens from offset ${openIdx} in ${src}`);
    }

    function sliceFn(text: string, name: string): string {
        const m = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm').exec(text);
        assert.ok(
            m,
            `${suite}: function ${name}() not found in ${src}. ` +
            'This suite runs the SHIPPED code by slicing it out of that file — if the function was renamed ' +
            'or restructured, update the slice list so the behaviour stays covered.'
        );
        const paramClose = matchParen(text, text.indexOf('(', m.index));
        const open = text.indexOf('{', paramClose);
        return text.slice(m.index, matchBrace(text, open) + 1);
    }

    /** Slice an object-literal method's BODY BLOCK (braces included) by its exact signature text. */
    function sliceMethodBody(text: string, signature: string): string {
        const idx = text.indexOf(signature);
        assert.ok(idx >= 0, `${suite}: method "${signature}" not found in ${src}`);
        const open = text.indexOf('{', idx + signature.length - 1);
        return text.slice(open, matchBrace(text, open) + 1);
    }

    return { matchBrace, matchParen, sliceFn, sliceMethodBody };
}
