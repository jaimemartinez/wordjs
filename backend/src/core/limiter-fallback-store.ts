/**
 * A rate-limit store for the limiters that guard sign-in and installation: the shared Redis store while
 * Redis answers, THIS process's memory while it does not.
 *
 * The limiters run with `passOnStoreError: true` so that a Redis outage does not turn every API request
 * into a 500. For the general API that is the right trade. For the doors a password-guessing loop aims at
 * (sign-in, password recovery, registration, the installer) it meant no per-IP limit at all for as long
 * as Redis was down. Behind this wrapper those limiters keep counting during an outage — per node rather
 * than cluster-wide, which is still a limit — and go back to the shared count once Redis answers again.
 *
 * Without Redis configured there is nothing to wrap: the limiter gets `undefined` and uses
 * express-rate-limit's own memory store, as before.
 */
const { MemoryStore } = require('express-rate-limit');
const log = require('./module-logger').moduleLogger('core/limiter-fallback-store');

type IncrementResponse = { totalHits: number; resetTime: Date | undefined };

class FallbackLimiterStore {
    readonly primary: any;
    readonly memory: any;
    prefix?: string;
    localKeys = false;
    private warned = false;

    constructor(primary: any) {
        this.primary = primary;
        this.memory = new MemoryStore();
        this.prefix = primary && primary.prefix;
    }

    init(options: any): void {
        try { this.memory.init(options); } catch { /* the memory store cannot fail to start */ }
        try {
            const r = this.primary.init && this.primary.init(options);
            if (r && typeof r.catch === 'function') r.catch(() => { /* reported on first use */ });
        } catch { /* reported on first use */ }
    }

    private degraded(e: unknown): void {
        if (this.warned) return;
        this.warned = true;
        log.warn({ err: e }, '[rate-limit] Redis store failed; counting in this process until it answers again');
    }

    async increment(key: string): Promise<IncrementResponse> {
        try {
            const r = await this.primary.increment(key);
            this.warned = false;
            return r;
        } catch (e) {
            this.degraded(e);
            return this.memory.increment(key);
        }
    }

    async decrement(key: string): Promise<void> {
        try { await this.primary.decrement(key); } catch { await this.memory.decrement(key); }
    }

    async resetKey(key: string): Promise<void> {
        try { await this.primary.resetKey(key); } catch { /* the memory count is reset below either way */ }
        await this.memory.resetKey(key);
    }

    async get(key: string): Promise<any> {
        try {
            if (typeof this.primary.get === 'function') return await this.primary.get(key);
        } catch { /* fall through */ }
        return this.memory.get(key);
    }

    shutdown(): void {
        try { this.memory.shutdown(); } catch { /* */ }
    }
}

/** Wrap a shared store so it falls back to memory on errors; `undefined` (no Redis) stays `undefined`. */
function withMemoryFallback(primary: any): any {
    return primary ? new FallbackLimiterStore(primary) : undefined;
}

module.exports = { withMemoryFallback, FallbackLimiterStore };
