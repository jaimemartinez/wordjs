/**
 * WordJS — WHAT AN AI AGENT PUTS LIVE, AND HOW TO TAKE IT BACK.
 *
 * An agent reads content other people wrote (comments, other authors' drafts with `content:others`), and
 * text in there can try to steer it. The grant is the guarantee — an agent can never do more than its
 * grant ∩ its user — but an agent bound to an editor and granted `content:others` + `content:publish` can
 * still put something live that the text it read asked for. Two things here make that recoverable and,
 * when the administrator wants, impossible without a person:
 *
 *   1. PUBLISH CONFIRMATION (opt-in, site-wide `agent_publish_confirmation`). While it is on, every agent
 *      connection runs with `content:publish` withheld from its narrowed user (grantsForNarrowing): the
 *      REST publish gate then files an agent's "publish" as `pending` — the same downgrade a contributor
 *      gets — and refuses its edits to content that is already live. The publish tool records the request
 *      (PUBLISH_REQUEST_META, a protected key) so the Agents screen can list what is waiting, and a person
 *      publishes it from there with their OWN session, through the ordinary REST route.
 *   2. REVISIONS NAME THE AGENT. Every revision is a snapshot of what a write replaced (core/revisions), so
 *      the revision a write by an agent leaves IS the version from before that agent touched the entry.
 *      It is tagged (revisionSourceFor → REVISION_SOURCE_META_KEY) and the revisions panel shows it, so
 *      rolling an agent's change back is one restore of a labelled row.
 */

import type { Request } from 'express';

const { getOption } = require('./options');
const { dispatchContextOf } = require('./rest-dispatch');

/** Admin-only option (routes/agents PUT /agents/settings; protected from plugins in core/plugin-api). */
const AGENT_PUBLISH_CONFIRMATION_OPTION = 'agent_publish_confirmation';
/** Post meta on an entry an agent asked to publish while confirmation is required (protected key). */
const PUBLISH_REQUEST_META = '_wjs_agent_publish_request';

function truthy(v: unknown): boolean {
    return v === true || v === 1 || v === '1' || v === 'on' || v === 'true';
}

/** Must a person confirm what agents publish on this site? Off unless an administrator turned it on. */
async function publishConfirmationRequired(): Promise<boolean> {
    try { return truthy(await getOption(AGENT_PUBLISH_CONFIRMATION_OPTION, '0')); } catch { return false; }
}

/**
 * The grant a connection's calls are NARROWED with: its own grant, minus `content:publish` while
 * confirmation is required. The stored grant is untouched (turning the setting off restores it), and the
 * tool list still offers publish_content — it now files a request instead.
 */
function grantsForNarrowing(granted: readonly string[], confirmationRequired: boolean): string[] {
    const g = Array.from(granted || []);
    return confirmationRequired ? g.filter((c) => c !== 'content:publish') : g;
}

/** Record that agent `agent` asked to publish `postId`; the Agents screen lists these. Best-effort. */
async function recordPublishRequest(postId: number, agent: { id: number; name: string }, onBehalfOf: number | null): Promise<void> {
    const Post = require('../models/Post');
    const value = JSON.stringify({
        agentId: Number(agent.id),
        agentName: String(agent.name || '').slice(0, 200),
        onBehalfOf: onBehalfOf == null ? null : Number(onBehalfOf),
        requestedAt: new Date().toISOString(),
    });
    await Post.updateMeta(postId, PUBLISH_REQUEST_META, value);
}

function parseRequest(raw: unknown): any {
    try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return v && typeof v === 'object' ? v : null;
    } catch { return null; }
}

/** Entries still PENDING that an agent asked to publish, newest request first. */
async function listPublishRequests(limit = 100): Promise<any[]> {
    const { dbAsync } = require('../config/database');
    const rows = (await dbAsync.all(
        `SELECT p.id, p.post_title, p.post_type, p.post_modified, m.meta_value
           FROM posts p JOIN post_meta m ON m.post_id = p.id AND m.meta_key = ?
          WHERE p.post_status = 'pending' AND p.post_type <> 'revision'
          ORDER BY p.post_modified DESC LIMIT ?`,
        [PUBLISH_REQUEST_META, Math.max(1, Math.min(500, Number(limit) || 100))],
    )) || [];
    return rows.map((r: any) => {
        const req = parseRequest(r.meta_value) || {};
        return {
            id: Number(r.id),
            title: String(r.post_title || ''),
            type: String(r.post_type || 'post'),
            modified: r.post_modified == null ? null : String(r.post_modified),
            agentId: Number.isFinite(Number(req.agentId)) ? Number(req.agentId) : null,
            agentName: typeof req.agentName === 'string' ? req.agentName : '',
            requestedAt: typeof req.requestedAt === 'string' ? req.requestedAt : null,
        };
    });
}

/** Clear a publish request (after a person published or returned the entry). True when one existed. */
async function dismissPublishRequest(postId: number): Promise<boolean> {
    const { dbAsync } = require('../config/database');
    const r = await dbAsync.run('DELETE FROM post_meta WHERE post_id = ? AND meta_key = ?', [postId, PUBLISH_REQUEST_META]);
    return !!(r && (r.changes > 0 || r.rowCount > 0));
}

/**
 * Who is making this content write, for the revision it leaves: the agent connection when the request was
 * dispatched by the MCP server (core/rest-dispatch — a header cannot claim it), else null (a person).
 */
function revisionSourceFor(req: Request | object | null | undefined): { kind: 'agent'; agentId: number; agentName: string } | null {
    const ctx = dispatchContextOf(req);
    if (!ctx || !ctx.agent) return null;
    return { kind: 'agent', agentId: Number(ctx.agent.id), agentName: String(ctx.agent.name || '').slice(0, 200) };
}

module.exports = {
    AGENT_PUBLISH_CONFIRMATION_OPTION,
    PUBLISH_REQUEST_META,
    publishConfirmationRequired,
    grantsForNarrowing,
    recordPublishRequest,
    listPublishRequests,
    dismissPublishRequest,
    revisionSourceFor,
};
