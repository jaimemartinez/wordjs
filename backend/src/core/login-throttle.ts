/**
 * WordJS — escalating per-(IP + account) login lockout.
 *
 * WHY THIS EXISTS: the per-IP request limiter (index.ts) keyed brute-force protection on the client
 * IP alone, so every user behind one public IP (office NAT, VPN, household) shared a single tiny
 * budget — one person fat-fingering their password locked out everyone else with "Too many login
 * attempts". This throttle keys on IP **and** the canonical account, so a failure on account A from
 * IP X never blocks account B on the same IP, and an attacker on IP Y attacking account A cannot lock
 * out A's legitimate owner signing in from IP X (different bucket).
 *
 * It is DELIBERATELY NOT a replacement for the account-wide lockout in routes/auth.ts (keyed on the
 * account only): that one is the AUTH-A3 backstop against a botnet/proxy-pool hammering ONE account
 * from many IPs — a case IP+account keying cannot see. Both run together; a login is blocked if
 * either says so. A per-IP FAILED-login limiter (index.ts) remains the third layer, bounding
 * credential spraying across many accounts from one IP.
 *
 * SCHEDULE (configurable via config.auth): after `maxFails` consecutive failures for an (IP,account),
 * block escalates through `ladderMs` — default 5 → 10 → 30 → 60 minutes, and every block after the
 * ladder's end repeats its last entry (60). A successful login WIPES the state for that (IP,account),
 * so the next lockout starts again at the first rung. Attempts made while already blocked do NOT
 * extend the block (the block is a cooldown, not a rolling penalty).
 *
 * Multi-node: when Redis is configured (cache.getClient()) the state is shared across replicas under
 * the `wjlogin:` prefix, with the idle TTL enforced by Redis PEXPIRE. Any Redis error degrades to the
 * in-process Map for that call — a Redis outage NEVER hard-blocks login — mirroring the
 * passOnStoreError philosophy of the IP limiters and the auth.ts account lockout.
 */

const config = require('../config/app');

interface State { fails: number; level: number; blockedUntil: number }
interface Policy { maxFails: number; ladderMs: number[]; ttlMs: number }

const EMPTY: State = { fails: 0, level: 0, blockedUntil: 0 };

function defaultPolicy(): Policy {
    const a = (config && config.auth) || {};
    const ladder = Array.isArray(a.loginBlockLadderMs) && a.loginBlockLadderMs.length
        ? a.loginBlockLadderMs.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
        : [];
    return {
        maxFails: Number(a.loginMaxFails) > 0 ? Number(a.loginMaxFails) : 5,
        ladderMs: ladder.length ? ladder : [5, 10, 30, 60].map((m) => m * 60 * 1000),
        ttlMs: Number(a.loginStateTtlMs) > 0 ? Number(a.loginStateTtlMs) : 120 * 60 * 1000,
    };
}

/**
 * PURE transition for a FAILED attempt on an (IP,account) that is NOT currently blocked. Kept pure and
 * exported so the escalation ladder is tested directly (no clock, no store) and can't silently drift.
 */
function applyFailure(state: State, now: number, policy: Policy): State {
    const fails = state.fails + 1;
    if (fails >= policy.maxFails) {
        const level = state.level + 1;
        // Clamp to the last rung so every block past the ladder's end repeats its final duration.
        const idx = Math.min(level, policy.ladderMs.length) - 1;
        return { fails: 0, level, blockedUntil: now + policy.ladderMs[idx] };
    }
    // Below the threshold: accumulate failures, preserve the escalation level reached so far.
    return { fails, level: state.level, blockedUntil: state.blockedUntil };
}

class LoginThrottle {
    /** Entries past which _write sweeps expired keys. A soft cap, not a hard one: never evicts live state. */
    static MEM_SOFT_CAP = 5000;
    policy: Policy;
    now: () => number;
    mem: Map<string, { state: State; expiresAt: number }>;
    getClient: () => any;

    constructor(policy: Partial<Policy> = {}, opts: any = {}) {
        this.policy = { ...defaultPolicy(), ...policy };
        this.now = opts.now || Date.now;
        this.mem = new Map();
        this.getClient = opts.getClient || (() => {
            try { return require('./cache').getClient() || null; } catch { return null; }
        });
    }

    buildKey(ip: string, account: string): string {
        return `${String(ip || '').trim()}|${String(account || '').trim().toLowerCase()}`;
    }

    private _redisKey(key: string): string { return `wjlogin:st:${key}`; }

    private async _read(key: string): Promise<State> {
        const client = this.getClient();
        if (client) {
            try {
                const raw = await client.get(this._redisKey(key));
                if (!raw) return { ...EMPTY };
                const s = JSON.parse(raw);
                return { fails: s.fails | 0, level: s.level | 0, blockedUntil: s.blockedUntil | 0 };
            } catch { /* Redis hiccup → in-memory view (fail-safe: this node still throttles) */ }
        }
        const e = this.mem.get(key);
        if (!e) return { ...EMPTY };
        if (e.expiresAt <= this.now()) { this.mem.delete(key); return { ...EMPTY }; }
        return { ...e.state };
    }

    private async _write(key: string, state: State): Promise<void> {
        const now = this.now();
        // Live at least until the block ends, but at minimum the idle-forget window so the ladder
        // persists between blocks and only resets after real inactivity.
        const ttl = Math.max(state.blockedUntil - now, this.policy.ttlMs);
        const client = this.getClient();
        if (client) {
            try { await client.set(this._redisKey(key), JSON.stringify(state), 'PX', ttl); return; }
            catch { /* Redis hiccup → record in-memory so this node still throttles */ }
        }
        this.mem.set(key, { state, expiresAt: now + ttl });
        this._sweep(now);
    }

    /**
     * Bound the in-process map. Half the key — the account — is the identifier SUBMITTED by an anonymous
     * caller, and `_read` only ever expires the one key it was asked for, so a spray of never-repeated
     * usernames left one entry each, for ever, in the default (no-Redis) deployment. Sweeping lazily and
     * only past a soft cap keeps the hot path O(1) while making the map's size a function of live traffic
     * rather than of everything ever seen. Nothing here changes throttling semantics: an entry is only
     * dropped once its own TTL has already expired, which is when `_read` would have reported EMPTY.
     */
    private _sweep(now: number): void {
        if (this.mem.size <= LoginThrottle.MEM_SOFT_CAP) return;
        for (const [k, e] of this.mem) if (e.expiresAt <= now) this.mem.delete(k);
    }

    private async _delete(key: string): Promise<void> {
        const client = this.getClient();
        if (client) { try { await client.del(this._redisKey(key)); } catch { /* best-effort; TTL expires it anyway */ } }
        this.mem.delete(key);
    }

    /** Is (ip,account) currently blocked? Read-only — call before checking the password. */
    async check(ip: string, account: string): Promise<{ blocked: boolean; retryAfterMs: number; level: number }> {
        const now = this.now();
        const s = await this._read(this.buildKey(ip, account));
        if (s.blockedUntil > now) return { blocked: true, retryAfterMs: s.blockedUntil - now, level: s.level };
        return { blocked: false, retryAfterMs: 0, level: s.level };
    }

    /** Record a failed attempt; may escalate into a block. A no-op escalation while already blocked. */
    async fail(ip: string, account: string): Promise<{ blocked: boolean; retryAfterMs: number; level: number }> {
        const key = this.buildKey(ip, account);
        const now = this.now();
        const s = await this._read(key);
        // Already blocked: do not count — an attempt during the cooldown must not extend it.
        if (s.blockedUntil > now) return { blocked: true, retryAfterMs: s.blockedUntil - now, level: s.level };
        const next = applyFailure(s, now, this.policy);
        await this._write(key, next);
        const blocked = next.blockedUntil > now;
        return { blocked, retryAfterMs: blocked ? next.blockedUntil - now : 0, level: next.level };
    }

    /** Successful login → wipe the ladder for this (ip,account) so the next lockout starts fresh. */
    async succeed(ip: string, account: string): Promise<void> {
        await this._delete(this.buildKey(ip, account));
    }
}

const singleton = new LoginThrottle();
module.exports = singleton;
module.exports.LoginThrottle = LoginThrottle;
module.exports.applyFailure = applyFailure;
module.exports.defaultPolicy = defaultPolicy;
