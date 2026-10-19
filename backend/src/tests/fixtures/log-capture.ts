/**
 * Capture what the REAL root logger emits while a test runs, as text a regex can be matched against.
 *
 * Backend modules log through core/module-logger, not `console`, and under the test runner the
 * logger's destination is silenced — so a test that used to swap `console.warn` to see a warning reads
 * the logger's sink instead. Each captured record is rendered as its `msg`, followed by `err.message`
 * when an error was logged, which is what the old `console.x(message, e.message)` line carried.
 *
 *     const cap = captureLogLines('warn');
 *     try { ... } finally { avisos.push(...cap.stop()); }
 */

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

function render(record: any): string {
    const err = record.err && typeof record.err === 'object' ? record.err.message : record.err;
    return err ? `${record.msg ?? ''} ${err}` : String(record.msg ?? '');
}

/**
 * Start capturing records at `level` (exactly, or every level when omitted). `stop()` returns the lines
 * (and is safe to call twice). With `raw`, each line also carries the serialized record — every field,
 * the error stack included — which is what a "this secret never reaches a log line" assertion needs.
 */
function captureLogLines(level?: string, opts: { raw?: boolean; into?: string[] } = {}): { stop: () => string[] } {
    if (level && !LEVELS.includes(level)) throw new Error(`unknown level ${level}`);
    const { addLogSink } = require('../../core/logger');
    // `into` is filled LIVE, for a test that polls the log while the code under test still runs.
    const lines: string[] = opts.into || [];
    const remove = addLogSink((line: string) => {
        try {
            const record = JSON.parse(line);
            if (!level || record.level === level) lines.push(opts.raw ? `${render(record)} ${line.trim()}` : render(record));
        } catch { /* not a record */ }
    });
    return {
        stop(): string[] {
            remove();
            return lines;
        },
    };
}

module.exports = { captureLogLines };
