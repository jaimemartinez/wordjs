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

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
// THE ROUTE-ID CONTRACT — see core/query-params: one definition of "a route id" for the whole tree.
const { routeIdOrNull } = require('../core/query-params');
const Post = require('../models/Post');
// THE gate, shared — not a second copy. See the SECURITY note on the route below.
const { canEditPostRecord, isRestExposedPostType } = require('../core/post-capabilities');

const TTL_MS = 25_000;

/** postId -> Map<userId, { name: string, ts: number }> */
const rooms: Map<string, Map<string, { name: string; ts: number }>> = new Map();

function sweep(room: Map<string, { name: string; ts: number }>) {
    const now = Date.now();
    for (const [uid, u] of room) if (now - u.ts > TTL_MS) room.delete(uid);
}

// Heartbeat (default) or { action: "leave" }. Always answers with the OTHER active editors, so the
// client needs a single call per tick.
//
// SECURITY — AUTHORIZE BY THE POST, NOT BY THE FAMILY. Editing-presence returns the id + display name
// + LIVE ACTIVITY of the other users editing a post, and it is also a WRITE: whoever passes lands in
// everybody else's "X is also editing" chip.
//
// This used to be gated on the GLOBAL `edit_posts` capability, which is permission over a FAMILY of
// content, not over this row. A contributor — the lowest role that holds it — could sweep postId 1..N
// and learn who had any private draft open and when, and could inject their own display name into a
// post they cannot read. The live collaboration channel had already reasoned this through and decided
// the opposite (routes/collab.ts: there is no reader mode, "because their presence would leak who is
// editing what to someone who cannot edit it") and gated per post. Two surfaces, one of them wrong, is
// what happens when the gate is COPIED; both now consume `canEditPostRecord`, which is the single
// definition of "may this user rewrite this post" (type family + own/others + published).
//
// `isRestExposedPostType` on top: `revision` and `nav_menu_item` are rows in `posts` that carry no
// capability_type, so the family resolver lands them in the plain `post` family. They belong to their
// own APIs and there is no editor session to have presence in.
router.post('/:postId', authenticate, asyncHandler(async (req: Request, res: Response) => {
    // THE ROUTE-ID CONTRACT — see core/query-params. The 400 and its body are unchanged (they are
    // this route's published answer); the PREDICATE is now the single shared one. The local test was
    // `parseInt` + `Number.isFinite(n) && n > 0`, which admitted both spellings of "cannot be an id":
    // `9999999999` is finite and positive but too wide for the 32-bit `posts.id` column (Postgres:
    // `22003 value out of range for type integer`, i.e. a 500), and `12abc` parses to 12, so a
    // presence beacon for post 12 could be sent under a URL that is not post 12's — a separate
    // rate-limit bucket for the same room.
    const postId = routeIdOrNull(req.params.postId);
    if (postId === null) {
        return res.status(400).json({ error: 'invalid post id' });
    }

    const key = String(postId);
    const uid = String(req.user.id);
    let room = rooms.get(key);

    // `leave` va ANTES del gate a propósito: solo puede BORRAR la entrada del propio llamante y su
    // respuesta es constante (`editors: []`), así que no dice nada de ninguna sala ni permite escribir
    // en ella. Denegar una RETIRADA no protege nada y sí hace daño: si a alguien le cambian los
    // permisos —o le publican el borrador— mientras lo tiene abierto, su beacon de `beforeunload`
    // rebotaría y su nombre se quedaría en el chip de los demás hasta agotar el TTL de 25 s.
    if (req.body && req.body.action === 'leave') {
        if (room) {
            room.delete(uid);
            if (room.size === 0) rooms.delete(key);
        }
        return res.json({ ok: true, editors: [] });
    }

    const post = await Post.findById(postId);
    // DENYING MUST NOT SAY WHETHER THE ROW EXISTS. The previous shape answered 404 for "no such post"
    // and 403 for "you may not edit it", and that difference IS the answer to "does post N exist?" —
    // an existence oracle over every private draft, walkable id by id, and since the gate moved from
    // the global `edit_posts` capability to the per-row one (finding #12) the caller no longer even
    // needs to be a contributor: any authenticated account can ask. `GET /posts/:id` refuses to make
    // that distinction on purpose (routes/posts.ts answers 404 both for a missing post and for
    // somebody else's draft) and this surface now refuses too: one branch, one answer.
    //
    // 403 rather than 404 for BOTH so the answer stays IDENTICAL to the live collaboration channel
    // for every post that exists — the two surfaces are the same policy and the test that pins them
    // together compares their statuses. See the handoff note about collapsing `gate()` in
    // routes/collab.ts the same way, which is the last place that still distinguishes.
    if (!post
        || !isRestExposedPostType(post.type || post.postType || 'post')
        || !canEditPostRecord(req.user, post)) {
        return res.status(403).json({ code: 'rest_forbidden', error: 'You cannot edit this post.' });
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
