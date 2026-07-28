/**
 * WordJS - Editing presence (collaboration v1)
 * /api/v1/presence/:postId
 *
 * A soft-lock SIGNAL, not co-editing: the editor heartbeats while a post is open and learns who
 * else has it open, so two authors get a "X también está editando" warning before one overwrites
 * the other. Real concurrent editing needs shared-state CRDTs (yjs) — deliberately out of scope.
 *
 * Storage is IN-MEMORY on purpose: presence is ephemeral (25s TTL), worthless to persist, and a
 * per-process map is exactly right for the monolith/split single-backend deployments this ships
 * to. In a multi-node backend cluster each node only sees its own editors — the warning can MISS,
 * it can never false-positive. (A Redis store is the upgrade path if multi-node editing arrives.)
 */

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const TTL_MS = 25_000;

/** postId -> Map<userId, { name: string, ts: number }> */
const rooms: Map<string, Map<string, { name: string; ts: number }>> = new Map();

function sweep(room: Map<string, { name: string; ts: number }>) {
    const now = Date.now();
    for (const [uid, u] of room) if (now - u.ts > TTL_MS) room.delete(uid);
}

// Heartbeat (default) or { action: "leave" }. Always answers with the OTHER active editors, so the
// client needs a single call per tick.
router.post('/:postId', authenticate, asyncHandler(async (req: any, res: any) => {
    const postId = parseInt(req.params.postId, 10);
    if (!Number.isFinite(postId) || postId <= 0) {
        return res.status(400).json({ error: 'invalid post id' });
    }
    const key = String(postId);
    const uid = String(req.user.id);
    let room = rooms.get(key);

    if (req.body && req.body.action === 'leave') {
        if (room) {
            room.delete(uid);
            if (room.size === 0) rooms.delete(key);
        }
        return res.json({ ok: true, editors: [] });
    }

    if (!room) rooms.set(key, (room = new Map()));
    room.set(uid, {
        name: String(req.user.display_name || req.user.displayName || req.user.username || `usuario ${uid}`).slice(0, 80),
        ts: Date.now(),
    });
    sweep(room);

    const editors = [...room.entries()]
        .filter(([id]) => id !== uid)
        .map(([id, u]) => ({ id: Number(id), name: u.name }));
    res.json({ ok: true, editors });
}));

module.exports = router;
