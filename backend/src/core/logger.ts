/**
 * WordJS — structured logging.
 *
 * ONE logger, one format, one place that decides the level. Everything the backend emits — a route
 * handler, a cron tick, a plugin isolate's forwarded stdout — becomes a JSON object on stdout with a
 * level, a timestamp and (inside a request) the correlation id that ties it to every other line the
 * same request produced. That is the whole point: an operator ships stdout to Loki/ELK/Datadog and
 * queries it, instead of parsing free text with emojis in it.
 *
 * THREE THINGS THIS FILE IS CAREFUL ABOUT
 *
 * 1. THE 802 LEGACY `console.*` CALLS. They are not rewritten here — a repository-wide replacement is
 *    its own change, reviewable on its own. `consoleBridge()` routes console.log/info/warn/error/debug
 *    through this logger instead, so every one of those call sites becomes a structured line the day
 *    the bridge is enabled, carrying `legacy: true` so the migration can be measured (and finished)
 *    from the logs themselves. The message text — emoji prefixes and all — is preserved verbatim: it
 *    IS the message, and rewriting it would break the operator greps that exist today.
 *
 * 2. NO WORKER THREADS. pino's `transport` option spawns a worker thread; this process installs an IO
 *    guard, a secure-require hook and a plugin sandbox at boot, and a logging path that forks a thread
 *    under all of that is a failure mode nobody wants at 3am. Pretty-printing in development is done
 *    with pino-pretty AS A STREAM (its default export is a transform stream), in-process, and only if
 *    the package resolves — production never depends on it.
 *
 * 3. REDACTION IS STRUCTURAL FOR FIELDS, TEXTUAL FOR MESSAGES — and the difference matters. `redact`
 *    drops the value of the paths below before the line is serialized, so an object logged whole (a
 *    request, a config blob, a webhook payload) cannot leak an Authorization header or a password
 *    through a caller who forgot to strip it. But pino's `redact` rewrites FIELDS ONLY: it never
 *    touches `msg`. The console bridge collapses its arguments into `msg`, so for the ~800 legacy
 *    lines structural redaction is not weak — it is INAPPLICABLE. Those lines therefore go through
 *    `scrubSecrets()` first, a deliberately small pattern over the credential shapes this codebase
 *    actually prints. A scrub is a mitigation, not a control: the control is not printing the secret,
 *    which is why `core/install-token.ts` and the bootstrap-admin banner in `index.ts` now gate the
 *    value itself on `shouldPrintBootstrapSecret()`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
const util = require('util');
const pino = require('pino');
const config = require('../config/app');

/** What a request-scoped log line knows about its request. Stored in the ALS by middleware/request-context. */
interface RequestLogContext {
    requestId: string;
    startedAt: number;
    logger: any;
}

const requestStore = new AsyncLocalStorage<RequestLogContext>();

// ─── Level ───────────────────────────────────────────────────────────────────────────────────────

const LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/**
 * LOG_LEVEL wins over config.logging.level, which wins over `info`. An unrecognised value is IGNORED
 * rather than passed to pino: pino throws on an unknown level, and a typo in an environment variable
 * must not be able to prevent the process from starting.
 *
 * `config/app.ts` resolves `logging.level` with the SAME order and the same validation, so the field
 * an operator can read back reports the level the process is actually running at. It used to let the
 * file win over the environment, which meant `config.logging.level` and this function disagreed
 * whenever both were set — and the fact that this function reads LOG_LEVEL itself, first, is exactly
 * what hid the disagreement: the level in force was always right, only the field was wrong.
 */
function resolveLevel(): string {
    const fromEnv = String(process.env.LOG_LEVEL || '').trim().toLowerCase();
    if (LEVELS.has(fromEnv)) return fromEnv;
    const fromConfig = String((config.logging && config.logging.level) || '').trim().toLowerCase();
    if (LEVELS.has(fromConfig)) return fromConfig;
    return 'info';
}

// ─── Redaction ───────────────────────────────────────────────────────────────────────────────────

/**
 * Paths whose VALUE is replaced by `[redacted]` before serialization. The wildcard forms (`*.password`)
 * match one level down from the root of the logged object, which is where a serialized row, request
 * body or config slice puts them; the explicit top-level names cover the same field logged bare, and
 * the `*.*.x` tier covers one level deeper (`{ user: { credentials: { password } } }`).
 *
 * TWO THINGS THIS LIST LEARNED THE HARD WAY.
 *
 * · pino paths are EXACT property names, not substrings. `password` does not match `dbPassword` and
 *   `secret` does not match `jwtSecret` — and both of those sit at the ROOT of the object
 *   `config/app.ts` exports, so `logger.info({ config })` printed the JWT signing key and the database
 *   password in the clear while this list looked complete. Every compound credential name the
 *   repository actually uses is therefore spelled out below.
 *
 * · The header entries must be SYMMETRIC. `authorization` and `cookie` were listed under both
 *   `req.headers.*` and bare `headers.*`, but `x-csrf-token` and `x-install-token` only under
 *   `req.headers.*` — so `logger.info({ headers: req.headers })` redacted the Authorization header
 *   and printed the install token sitting next to it.
 */
const CREDENTIAL_KEYS = [
    'password',
    'token',
    'secret',
    'jwtSecret',
    'dbPassword',
    'accessToken',
    'refreshToken',
    'apiKey',
    'privateKey',
    'password_hash',
    'secret_enc',
    'totpSecret',
];

const HEADER_KEYS = ['authorization', 'cookie', 'x-csrf-token', 'x-install-token'];

const REDACT_PATHS = [
    // Headers, under both the `req.headers` shape pino's standard serializer produces and the bare
    // `headers` shape a caller logging `{ headers }` produces.
    ...HEADER_KEYS.map((h) => `req.headers["${h}"]`),
    ...HEADER_KEYS.map((h) => `headers["${h}"]`),
    // Credential-bearing property names, at the root and one and two levels down.
    ...CREDENTIAL_KEYS,
    ...CREDENTIAL_KEYS.map((k) => `*.${k}`),
    ...CREDENTIAL_KEYS.map((k) => `*.*.${k}`),
];

// ─── Message scrubbing ───────────────────────────────────────────────────────────────────────────

const REDACTED = '[redacted]';

/** Regex-escape a literal, so a hand-maintained data list can be spliced into a pattern safely. */
function escapeForPattern(word: string): string {
    return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The credential words recognised in free TEXT.
 *
 * `CREDENTIAL_KEYS` — the list `redact` builds its paths from — is the source of truth: a name added
 * there for the structured path starts being scrubbed out of messages in the same commit, instead of
 * the two lists drifting until one of them is a lie. (That drift is not hypothetical: `privateKey` was
 * on the field list and missing from this one.) The rest are spellings that only ever appear as text —
 * `passwd`, a CSRF cookie name, the `api_key`/`api-key` forms, and the `authorization` header itself.
 */
const MESSAGE_KEY_WORDS = [
    ...CREDENTIAL_KEYS.map(escapeForPattern),
    'passwd',
    'csrf',
    'api[_-]?key',
    'authorization',
].join('|');

/** What may sit between the credential word and its separator: `_hash`, `"`, `"]`, `.value`. */
const KEY_TAIL = '[A-Za-z0-9_.\\[\\]"\'-]{0,64}';

/** An unquoted value: everything up to the first delimiter. */
const BARE_VALUE = '[^\\s,;&"\'`)\\]}]{1,4096}';

/** An auth scheme word and the whitespace after it: `Bearer `, `Basic `, `AWS4-HMAC-SHA256 `. */
const AUTH_SCHEME = '[A-Za-z][A-Za-z0-9-]{0,20}\\s{1,8}';

/**
 * `<key><quote>` followed by the value, stopping BEFORE the closing quote — one alternative per quote
 * flavour, because a value class that excluded both quotes would give up on `password: "it's"`.
 *
 * The opening quote is part of the KEPT group and the closing one is left in the text by a lookahead,
 * so the result is `password: '[redacted]'` and the line an operator greps stays parseable. `\\.`
 * keeps an escaped quote inside the value instead of ending it; the two branches are disjoint (one
 * starts with a backslash, the other cannot contain one), so there is nothing to backtrack over.
 */
function quotedAlternatives(name: string, words: string): string[] {
    return ['"', "'"].map(
        (q, i) => `(?<${name}${i}>(?:${words})${KEY_TAIL}\\s{0,8}[:=]\\s{0,8}${q})`
            + `(?:\\\\.|[^${q}\\\\\\r\\n]){1,4096}(?=${q})`,
    );
}

/**
 * The credential shapes that appear in MESSAGE TEXT, as one pass. Six alternatives, in this order:
 *
 *   1. `Authorization:` / `Proxy-Authorization:` with ANY scheme, or with none. The scheme is matched
 *      generically and only KEPT when it is a name we recognise (see `scrubSecrets`); the mask starts
 *      right after the colon. This used to consume `Bearer ` and nothing else, so every other scheme —
 *      `Basic`, `Token`, `Digest`, `Negotiate`, `AWS4-HMAC-SHA256` — had its NAME replaced by
 *      `[redacted]` while its credential was printed in the clear next to the marker. A line that
 *      looks handled and is not is worse than a line that obviously was not scrubbed.
 *   2. A quoted `Cookie:` / `Set-Cookie:` value: the whole jar goes, because a session cookie's NAME
 *      is not required to look like a credential. An unquoted jar still falls to alternative 4 cookie
 *      by cookie, which is what keeps `Cookie: wjs_csrf=…; wordjs_token=…` readable.
 *   3. A credential key whose value is QUOTED — `password: 'x'`, `"token":"x"`, `jwtSecret: "y"`. That
 *      is what `util.inspect` and `JSON.stringify` produce, i.e. what the console bridge itself makes
 *      out of `console.log('body', req.body)` — the dominant shape on this path, and the one the bare
 *      alternative below can never match, because its value class excludes the opening quote.
 *   4. The same keys with a BARE value: `token=`, `#token=`, `password=`, `secret:`, `api_key=`,
 *      `x-install-token: …`, `wordjs_token=…`, `wjs_csrf=…`.
 *   5. A bare `Bearer <blob>` with no header name in front of it.
 *   6. WordJS's own `wjt_` token prefix, which needs no key at all to be recognisable.
 *
 * Deliberately NOT a general secret detector. It is one regex on a hot-ish path, it must not rewrite
 * ordinary prose (a sentence that merely contains the word `password` has no separator after it and is
 * left alone), and anything it does catch was already a bug at the call site — see the header note.
 *
 * ON REDoS. Every quantifier is BOUNDED, and the only alternation INSIDE one — the quoted-value body —
 * has disjoint branches (one starts with a backslash, the other cannot contain one), so it cannot
 * backtrack into itself. There is also no `{0,64}` run in FRONT of the key word any more: the
 * characters before it (`wordjs_`, `x-install-`, an opening `"`) are simply left where they are, since
 * the replacement re-emits the key verbatim — which turns every start position into a literal test
 * instead of 65 backtracking ones. Measured on 40 KB lines built to be hostile to each alternative in
 * turn: worst case ~4 ms, against ~27 ms for the worst shape the previous pattern faced.
 */
const SECRET_PATTERN = new RegExp(
    [
        `(?<authKey>authorization${KEY_TAIL}\\s{0,8}[:=]\\s{0,8}["']?)(?<authScheme>${AUTH_SCHEME})?(?:${BARE_VALUE})`,
        ...quotedAlternatives('cookie', 'cookie'),
        ...quotedAlternatives('kv', MESSAGE_KEY_WORDS),
        `(?<kvBare>(?:${MESSAGE_KEY_WORDS})${KEY_TAIL}\\s{0,8}[:=]\\s{0,8})(?:${BARE_VALUE})`,
        '(?<bearer>bearer\\s{1,8})(?:[A-Za-z0-9._~+/=-]{8,4096})',
        '(?:wjt_[A-Za-z0-9_-]{6,4096})',
    ].join('|'),
    'gi',
);

/**
 * Auth schemes whose NAME is safe to leave in the line. Anything else that lands in the scheme
 * position is masked along with the credential: an unregistered word there is far likelier to be an
 * unlabelled token than a scheme nobody has heard of, and the label is worth one word of diagnostics,
 * never a leak.
 */
const KNOWN_AUTH_SCHEMES = new Set([
    'basic', 'bearer', 'digest', 'dpop', 'gnap', 'hoba', 'mutual', 'negotiate', 'ntlm', 'oauth',
    'privatetoken', 'scram-sha-1', 'scram-sha-256', 'token', 'vapid', 'hawk', 'apikey', 'ssws',
    'aws4-hmac-sha256', 'googlelogin', 'sso',
]);

/** The kept group of every alternative that masks everything after the key, in pattern order. */
const KEEP_GROUPS = ['cookie0', 'cookie1', 'kv0', 'kv1', 'kvBare', 'bearer'];

/**
 * Replace credential VALUES in a free-text log message with `[redacted]`, keeping the key (and the
 * quotes around the value) so the line still says what was there. Applied to every bridged `console.*`
 * line — see note 3 in the header.
 */
function scrubSecrets(text: string): string {
    if (!text) return text;
    return text.replace(SECRET_PATTERN, (...args: any[]): string => {
        // With named groups the replacer's last argument is the groups object; positional arguments
        // would mean renumbering every alternative each time one is added.
        const groups = args[args.length - 1] as Record<string, string | undefined>;
        const authKey = groups.authKey;
        if (authKey !== undefined) {
            const scheme = groups.authScheme;
            const known = scheme !== undefined && KNOWN_AUTH_SCHEMES.has(scheme.trim().toLowerCase());
            return `${known ? authKey + scheme : authKey}${REDACTED}`;
        }
        for (const name of KEEP_GROUPS) {
            const key = groups[name];
            if (key !== undefined) return `${key}${REDACTED}`;
        }
        return REDACTED; // the bare `wjt_…` form: nothing to keep
    });
}

// ─── Destination ─────────────────────────────────────────────────────────────────────────────────

type LogSink = (line: string) => void;
const sinks = new Set<LogSink>();

/**
 * Development pretty-printing, IN PROCESS. Returns undefined unless NODE_ENV is exactly 'development'
 * AND pino-pretty resolves — it is an optional devDependency, so `npm ci --omit=dev` in production
 * simply gets JSON, which is what production wants anyway.
 */
function prettyStream(): any {
    if (config.nodeEnv !== 'development') return undefined;
    try {
        require.resolve('pino-pretty');
    } catch {
        return undefined;
    }
    try {
        const pretty = require('pino-pretty');
        return pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' });
    } catch {
        return undefined; // a broken optional dev dependency must never take the process down
    }
}

/**
 * Under the test runner, NOTHING goes to fd 1.
 *
 * The console bridge is already gated on this (see consoleBridge's note): the suites read node:test's
 * own output off stdout and JSON in the middle of it makes a failing assertion unreadable. Gating only
 * the bridge left the OTHER door open — the access-log middleware still wrote a JSON object to fd 1
 * for every request a supertest case made, interleaved into the spec reporter. The sink tee below is
 * unaffected, and the sink is what the observability tests actually assert on.
 */
function underTestRunner(): boolean {
    return Boolean(process.env.NODE_TEST_CONTEXT) || config.nodeEnv === 'test';
}

const baseStream = underTestRunner()
    ? { write(): void { /* the test runner owns fd 1 */ } }
    : (prettyStream() || pino.destination({ dest: 1, sync: false }));

/**
 * Every line goes to stdout AND to any registered sink. Sinks exist so a test can assert on what was
 * actually EMITTED (the shape of the access line, the fact that a header was redacted) rather than on
 * a logger it built itself — a test that builds its own logger proves nothing about the one the app
 * runs. A throwing sink is swallowed: an assertion helper must not be able to break logging.
 *
 * `flush`/`flushSync` are FORWARDED, not just `write`. pino's `logger.flush()` and `pino.final()` —
 * the documented way to drain an asynchronous destination from a shutdown or `uncaughtException` hook
 * — forward only when the stream exposes those methods. A tee that implements `write` alone turns
 * `logger.flush()` into a silent no-op, so the first shutdown hook someone writes against it appears
 * to work and flushes nothing.
 */
const teeStream = {
    write(line: string): void {
        baseStream.write(line);
        if (sinks.size === 0) return;
        for (const sink of sinks) {
            try {
                sink(line);
            } catch {
                /* a sink is diagnostics, never a dependency of the log path */
            }
        }
    },
    flush(cb?: (err?: Error | null) => void): void {
        if (typeof (baseStream as any).flush === 'function') {
            (baseStream as any).flush(cb);
            return;
        }
        if (cb) cb(null);
    },
    flushSync(): void {
        if (typeof (baseStream as any).flushSync === 'function') (baseStream as any).flushSync();
    },
};

/** Test/introspection hook: receive every emitted line. Returns a function that removes the sink. */
function addLogSink(sink: LogSink): () => void {
    sinks.add(sink);
    return () => { sinks.delete(sink); };
}

// ─── The logger ──────────────────────────────────────────────────────────────────────────────────

const logger = pino({
    level: resolveLevel(),
    base: { service: 'wordjs-backend', pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    // `level` as its NAME, not pino's numeric code: an aggregator that has to be taught 30 = info is an
    // aggregator that will one day be taught wrong.
    formatters: { level: (label: string) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
}, teeStream);

/**
 * The logger bound to the request currently being served, or the root logger outside one. Anything
 * that logs from inside a request should go through this so the line carries `requestId` — including
 * code far from the route handler (a core module, a hook, a cron job triggered by a request), which is
 * exactly the code that cannot be handed a logger through its arguments.
 */
function getRequestLogger(): any {
    const ctx = requestStore.getStore();
    return (ctx && ctx.logger) || logger;
}

/** The active request's `{ requestId, startedAt }`, or undefined outside a request. */
function getRequestContext(): RequestLogContext | undefined {
    return requestStore.getStore();
}

/** Run `fn` with `ctx` as the ambient request context (used by middleware/request-context). */
function runWithRequestContext<T>(ctx: RequestLogContext, fn: () => T): T {
    return requestStore.run(ctx, fn);
}

// ─── The console bridge ──────────────────────────────────────────────────────────────────────────

const CONSOLE_LEVELS: Array<[string, string]> = [
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
    ['debug', 'debug'],
];

let uninstallBridge: (() => void) | null = null;

/**
 * Route console.log/info/warn/error/debug through the logger.
 *
 * Called once, from index.ts, right after the config loads and only when NODE_ENV !== 'test' (the test
 * suites read node:test's own output off the same stream; turning it into JSON would make a failing
 * assertion unreadable). Idempotent — a second call is a no-op that returns the SAME uninstall
 * function, so a module loaded twice cannot end up double-wrapping console and doubling every line.
 *
 * `console.table`, `console.trace`, `console.dir` and friends are deliberately left alone: they are
 * developer-console shapes, not log records, and nothing in the backend ships them in production.
 */
function consoleBridge(): () => void {
    if (uninstallBridge) return uninstallBridge;

    const originals: Array<[string, any]> = [];
    for (const [method, level] of CONSOLE_LEVELS) {
        const original = (console as any)[method];
        originals.push([method, original]);
        (console as any)[method] = (...args: any[]): void => {
            try {
                // util.format is what console itself uses, so `%s`/`%d`/object inspection all keep
                // producing the same text they do today. Emoji prefixes survive untouched: they are
                // part of the message operators already grep for.
                //
                // scrubSecrets is the ONLY redaction these lines can get: `redact` rewrites fields and
                // this is a message. See note 3 in the file header for why that is a mitigation and
                // not the control.
                getRequestLogger()[level]({ legacy: true }, scrubSecrets(util.format(...args)));
            } catch {
                original.apply(console, args); // never lose a line because the logger failed
            }
        };
    }

    uninstallBridge = () => {
        for (const [method, original] of originals) (console as any)[method] = original;
        uninstallBridge = null;
    };
    return uninstallBridge;
}

/**
 * True once consoleBridge() has been installed.
 *
 * Introspection only: nothing in the backend reads it today. The comment here used to claim "read by
 * the observability tests and /health", which was false in both halves — the kind of statement a later
 * reviewer trusts instead of checking. Exposing it on the admin health report is the obvious home if
 * an operator ever needs to know whether this instance is bridging; that lives in `routes/health.ts`.
 */
function consoleBridgeInstalled(): boolean {
    return uninstallBridge !== null;
}

module.exports = {
    logger,
    getRequestLogger,
    getRequestContext,
    runWithRequestContext,
    consoleBridge,
    consoleBridgeInstalled,
    resolveLevel,
    scrubSecrets,
    // Test/introspection hooks (not a public API — see addLogSink's comment).
    addLogSink,
    _redactPaths: REDACT_PATHS,
};
