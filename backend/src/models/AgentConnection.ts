/**
 * WordJS - AI agent connection model (the identities the MCP server authenticates).
 *
 * An agent connection is a dedicated `wja_` bearer token bound to ONE user. It is NOT an API token:
 *   • it authenticates ONLY the MCP endpoint (routes/mcp.ts) — the REST `authenticate` path does not know
 *     the `wja_` prefix, so a leaked agent token cannot drive the REST API directly;
 *   • it carries what the connection REQUESTED and what an administrator GRANTED (granted ⊆ requested),
 *     and its effective authority is grants ∩ the bound user's live capabilities (core/agent-capabilities);
 *   • a fresh connection is `pending` — it can connect and introspect itself, but holds no tool until an
 *     administrator grants something.
 *
 * Storage mirrors models/ApiToken: only a sha256 of the token is kept (256 bits of CSPRNG entropy, so a
 * fast hash is correct); the plaintext is returned once, at creation.
 */

const { dbAsync } = require('../config/database');
const crypto = require('crypto');
const { normalizeAgentCapabilities } = require('../core/agent-capabilities');

const PREFIX = 'wja_';
const STATUSES = ['pending', 'active', 'revoked'] as const;
type AgentStatus = typeof STATUSES[number];

interface AgentConnectionRecord {
    id: number;
    userId: number;
    name: string;
    tokenPrefix: string;
    requested: string[];
    granted: string[];
    status: AgentStatus;
    createdBy: number | null;
    grantedBy: number | null;
    grantedAt: number | null;
    lastUsedAt: number | null;
    expiresAt: number | null;
    createdAt: string | null;
}

function hashToken(raw: string): string {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const capList = (v: unknown): string[] => String(v == null ? '' : v).split(',').map((s) => s.trim()).filter(Boolean);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

function fromRow(r: any): AgentConnectionRecord {
    const status: AgentStatus = (STATUSES as readonly string[]).includes(r.status) ? r.status : 'revoked';
    return {
        id: Number(r.id),
        userId: Number(r.user_id),
        name: r.name,
        tokenPrefix: r.token_prefix,
        requested: capList(r.requested_caps),
        granted: capList(r.granted_caps),
        status,
        createdBy: numOrNull(r.created_by),
        grantedBy: numOrNull(r.granted_by),
        grantedAt: numOrNull(r.granted_at),
        lastUsedAt: numOrNull(r.last_used_at),
        expiresAt: numOrNull(r.expires_at),
        createdAt: r.created_at == null ? null : String(r.created_at),
    };
}

const COLUMNS = 'id, user_id, name, token_prefix, requested_caps, granted_caps, status, created_by, granted_by, granted_at, last_used_at, expires_at, created_at';

// Same throttle as ApiToken.touch: last_used_at is telemetry, not correctness.
const _touchedAt = new Map<number, number>();
const TOUCH_THROTTLE_MS = 60 * 1000;

class AgentConnection {
    /** Create a pending connection. Returns the PLAINTEXT token exactly once. */
    static async create(opts: { userId: number; name?: string; requested: unknown; createdBy: number; expiresInDays?: number | null }) {
        const name = String(opts.name || '').slice(0, 200).trim() || 'AI agent';
        const requested = normalizeAgentCapabilities(opts.requested);
        const raw = PREFIX + crypto.randomBytes(32).toString('base64url');
        const tokenPrefix = raw.slice(0, 12);
        let expiresAt: number | null = null;
        if (opts.expiresInDays != null) {
            const days = Number(opts.expiresInDays);
            if (Number.isFinite(days) && days > 0) expiresAt = nowSeconds() + Math.floor(days) * 86400;
        }
        const result = await dbAsync.run(
            `INSERT INTO agent_connections (user_id, name, token_hash, token_prefix, requested_caps, granted_caps, status, created_by, expires_at)
             VALUES (?, ?, ?, ?, ?, '', 'pending', ?, ?) RETURNING id`,
            [opts.userId, name, hashToken(raw), tokenPrefix, requested.join(','), opts.createdBy, expiresAt]
        );
        const created = await AgentConnection.findById(result.lastID);
        return { token: raw, connection: created as AgentConnectionRecord };
    }

    /**
     * Resolve a raw `wja_` token to its record, or null when it is unknown, revoked or expired. A
     * `pending` connection DOES resolve (it may connect and introspect); the MCP layer gives it no tools.
     */
    static async findByRawToken(raw: string): Promise<AgentConnectionRecord | null> {
        if (typeof raw !== 'string' || !raw.startsWith(PREFIX) || raw.length > 200) return null;
        const row = await dbAsync.get(`SELECT ${COLUMNS} FROM agent_connections WHERE token_hash = ?`, [hashToken(raw)]);
        if (!row) return null;
        const rec = fromRow(row);
        if (rec.status === 'revoked') return null;
        if (rec.expiresAt != null && rec.expiresAt * 1000 <= Date.now()) return null;
        return rec;
    }

    static async findById(id: number): Promise<AgentConnectionRecord | null> {
        const row = await dbAsync.get(`SELECT ${COLUMNS} FROM agent_connections WHERE id = ?`, [id]);
        return row ? fromRow(row) : null;
    }

    /** Every connection (admin view) or only those bound to `userId`. Newest first. Never the hash. */
    static async list(userId?: number): Promise<AgentConnectionRecord[]> {
        const rows = userId == null
            ? await dbAsync.all(`SELECT ${COLUMNS} FROM agent_connections ORDER BY id DESC`)
            : await dbAsync.all(`SELECT ${COLUMNS} FROM agent_connections WHERE user_id = ? ORDER BY id DESC`, [userId]);
        return (rows || []).map(fromRow);
    }

    /**
     * Replace the grant. The caller has already checked grant ⊆ requested (core/agent-capabilities
     * grantWithinRequest). An empty grant puts the connection back to `pending`. A revoked connection
     * cannot be re-granted (the guarded UPDATE matches nothing) — revocation is terminal.
     */
    static async setGrant(id: number, grant: string[], grantedBy: number): Promise<boolean> {
        const status: AgentStatus = grant.length ? 'active' : 'pending';
        const result = await dbAsync.run(
            `UPDATE agent_connections SET granted_caps = ?, status = ?, granted_by = ?, granted_at = ?
             WHERE id = ? AND status <> 'revoked'`,
            [grant.join(','), status, grantedBy, nowSeconds(), id]
        );
        return !!(result && (result.changes > 0 || result.rowCount > 0));
    }

    static async revoke(id: number): Promise<boolean> {
        const result = await dbAsync.run(
            `UPDATE agent_connections SET status = 'revoked', granted_caps = '' WHERE id = ? AND status <> 'revoked'`,
            [id]
        );
        return !!(result && (result.changes > 0 || result.rowCount > 0));
    }

    /** Revoke every live connection bound to a user (password change/reset, account deletion). */
    static async revokeAllForUser(userId: number): Promise<number> {
        const result = await dbAsync.run(
            `UPDATE agent_connections SET status = 'revoked', granted_caps = '' WHERE user_id = ? AND status <> 'revoked'`,
            [userId]
        );
        return (result && (result.changes ?? result.rowCount)) || 0;
    }

    static touch(id: number): void {
        const now = Date.now();
        if (now - (_touchedAt.get(id) || 0) < TOUCH_THROTTLE_MS) return;
        _touchedAt.set(id, now);
        Promise.resolve(
            dbAsync.run('UPDATE agent_connections SET last_used_at = ? WHERE id = ?', [Math.floor(now / 1000), id])
        ).catch(() => { /* telemetry write failed — ignore */ });
    }

    static PREFIX = PREFIX;
}

module.exports = AgentConnection;
