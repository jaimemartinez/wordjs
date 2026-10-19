/**
 * WordJS — the logger a backend module logs through.
 *
 *     const log = require('../core/module-logger').moduleLogger('core/cron');
 *     log.info({ hook }, 'cron event scheduled');
 *     log.error({ err }, 'cron event failed');
 *
 * Every line carries `mod` (the module's path under src/, without the extension) and — when it is
 * emitted while a request is being served — the `requestId` of that request, exactly like the lines
 * the console bridge produces today. Three properties make it safe to use from ANY module:
 *
 * 1. IT IS LAZY. `core/logger` is required on the first line actually logged, not when this file is
 *    loaded. `core/logger` reads `config/app` at load time, and `config/app` itself loads modules that
 *    log (core/content-rollout), so an eager require here would hand the logger a half-initialised
 *    config in that cycle and silently pick the wrong level and destination.
 *
 * 2. IT FOLLOWS THE REQUEST. The child is derived from `getRequestLogger()` at CALL time (and cached
 *    per request logger in a WeakMap, so the cache dies with the request). A module-level
 *    `logger.child({ mod })` would lose the correlation id the bridge gives these lines today.
 *
 * 3. IT SCRUBS THE MESSAGE. pino's `redact` only rewrites fields; the message string still goes
 *    through `scrubSecrets()`, the same mitigation the console bridge applies — migrating a line off
 *    the bridge must not make it leakier. Credentials must still never be logged in the first place.
 *
 * A logging call never throws: a failure is swallowed, because the code that logs is never the code
 * that should fail because of it.
 */

type LogMethod = {
    (msg: string): void;
    (obj: unknown, msg?: string): void;
};

export interface ModuleLogger {
    trace: LogMethod;
    debug: LogMethod;
    info: LogMethod;
    warn: LogMethod;
    error: LogMethod;
    fatal: LogMethod;
    isLevelEnabled(level: string): boolean;
}

const LEVEL_NAMES = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

let core: any = null;
function loggerCore(): any {
    if (!core) core = require('./logger');
    return core;
}

function moduleLogger(mod: string): ModuleLogger {
    const children = new WeakMap<object, any>();
    const target = (): any => {
        const base = loggerCore().getRequestLogger();
        let child = children.get(base);
        if (!child) {
            child = base.child({ mod });
            children.set(base, child);
        }
        return child;
    };

    const method = (level: string): LogMethod => ((first: unknown, msg?: string): void => {
        try {
            const { scrubSecrets } = loggerCore();
            const t = target();
            if (typeof first === 'string') t[level](scrubSecrets(first));
            else if (typeof msg === 'string') t[level](first, scrubSecrets(msg));
            else t[level](first);
        } catch {
            /* logging must never break the caller */
        }
    }) as LogMethod;

    const out: any = {
        isLevelEnabled(level: string): boolean {
            try {
                return target().isLevelEnabled(level);
            } catch {
                return false;
            }
        },
    };
    for (const level of LEVEL_NAMES) out[level] = method(level);
    return out as ModuleLogger;
}

module.exports = { moduleLogger };
