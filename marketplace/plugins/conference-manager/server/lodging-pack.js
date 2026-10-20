'use strict';
/**
 * Room packing (2.20.0) — the arithmetic behind «la menor cantidad de habitaciones y de camas vacías».
 *
 * Placing people in rooms is BIN PACKING with bins of different sizes (rooms of 2, 3, 4… beds), conflicts (a
 * hard separate_by rule: two people who may not share a room) and items that must not be divided (a family
 * kept together). It is NP-hard in general; the engine decomposes it instead of solving it whole:
 *   - the hard separate_by rules split the people into CLASSES that never share a room (men / women…), each
 *     packed on its own;
 *   - inside a class, WHICH rooms to open is chosen EXACTLY (roomSets: a bounded knapsack over the rooms' free
 *     beds — the fewest rooms whose beds reach the people, and among those the fewest beds left over);
 *   - the people go into those rooms by Best Fit Decreasing (packInto: the largest group first, each where it
 *     leaves the fewest free beds), the classic heuristic (never more than 11/9 of the optimum + 6/9 bins, and
 *     nearly always the optimum at these sizes) — the preferences first when that costs nothing, an exact search
 *     for a few groups when Best Fit misses; when the groups do not fit the chosen rooms, the next set is
 *     tried.
 * Everything here is pure and deterministic: ties keep the order the caller gave.
 */

/** Above this many beds to cover, the bulk is taken greedily (largest rooms first) and only the tail exactly. */
const EXACT_SPAN = 240;

/**
 * Candidate room sets for `need` beds, best first: fewest rooms, then fewest beds over `need`.
 * `caps` = free beds per room, in preference order. Returns arrays of room INDEXES into `caps` (at most
 * `limit` sets). When every room together is not enough, the only set is all of them.
 */
function roomSets(caps, need, limit = 24) {
    const idx = caps.map((c, i) => i).filter(i => caps[i] > 0);
    if (need <= 0 || !idx.length) return [[]];
    const total = idx.reduce((n, i) => n + caps[i], 0);
    if (total <= need) return [idx];
    // Bulk: while the beds still to cover exceed the exact window, take the largest room left (the fewest rooms).
    const byCapDesc = [...idx].sort((a, b) => caps[b] - caps[a] || a - b);
    const bulk = [];
    let left = need;
    while (left > EXACT_SPAN && byCapDesc.length) { const i = byCapDesc.shift(); bulk.push(i); left -= caps[i]; }
    if (left <= 0) return [bulk];
    const pool = byCapDesc.sort((a, b) => a - b); // back to preference order
    // Distinct capacities (each with its rooms, in preference order).
    const types = [];
    for (const i of pool) { let t = types.find(x => x.cap === caps[i]); if (!t) { t = { cap: caps[i], rooms: [] }; types.push(t); } t.rooms.push(i); }
    const maxCap = Math.max(...types.map(t => t.cap));
    const S = left + maxCap; // no useful set goes beyond: one room fewer would already reach `left`
    const INF = Infinity;
    // dp[k][s]: fewest rooms using the first k types to reach EXACTLY s beds; take[k][s]: rooms of type k-1 used.
    let dp = new Array(S + 1).fill(INF); dp[0] = 0;
    const take = [];
    for (const t of types) {
        const next = new Array(S + 1).fill(INF), choice = new Array(S + 1).fill(0);
        for (let s = 0; s <= S; s++) {
            if (dp[s] === INF) continue;
            for (let x = 0; x <= t.rooms.length && s + x * t.cap <= S; x++) {
                const v = dp[s] + x, to = s + x * t.cap;
                if (v < next[to]) { next[to] = v; choice[to] = x; }
            }
        }
        take.push(choice); dp = next;
    }
    // Rebuild the set reaching s exactly with dp[s] rooms.
    const rebuild = (s) => {
        // Walk the layers backwards: the choice recorded at each layer for the running sum.
        const counts = new Array(types.length).fill(0);
        let cur = s;
        for (let k = types.length - 1; k >= 0; k--) { const x = take[k][cur]; counts[k] = x; cur -= x * types[k].cap; }
        const out = [];
        counts.forEach((x, k) => { for (let j = 0; j < x; j++) out.push(types[k].rooms[j]); });
        return out;
    };
    const candidates = [];
    for (let s = left; s <= S; s++) if (dp[s] !== INF) candidates.push({ s, k: dp[s] });
    candidates.sort((a, b) => a.k - b.k || a.s - b.s);
    const sets = candidates.slice(0, limit).map(c => bulk.concat(rebuild(c.s)));
    return sets.length ? sets : [bulk.concat(pool)];
}

/**
 * Room sets people can FILL (2.21.0 — beds short, a bed left empty is a bed lost): sets whose beds add up to at most
 * `have` (the people there are), the most beds first, then the fewest rooms; ties keep the preference order of
 * `caps`. An exact subset sum over the rooms' beds (each capacity a bounded item). Indexes into `caps`.
 */
function fillSets(caps, have, limit = 12) {
    const idx = caps.map((c, i) => i).filter(i => caps[i] > 0);
    if (have <= 0 || !idx.length) return [];
    const types = [];
    for (const i of idx) { let t = types.find(x => x.cap === caps[i]); if (!t) { t = { cap: caps[i], rooms: [] }; types.push(t); } t.rooms.push(i); }
    const S = Math.min(have, idx.reduce((n, i) => n + caps[i], 0));
    const INF = Infinity;
    let dp = new Array(S + 1).fill(INF); dp[0] = 0;
    const take = [];
    for (const t of types) {
        const next = new Array(S + 1).fill(INF), choice = new Array(S + 1).fill(0);
        for (let s = 0; s <= S; s++) {
            if (dp[s] === INF) continue;
            for (let x = 0; x <= t.rooms.length && s + x * t.cap <= S; x++) {
                const v = dp[s] + x, to = s + x * t.cap;
                if (v < next[to]) { next[to] = v; choice[to] = x; }
            }
        }
        take.push(choice); dp = next;
    }
    const sets = [];
    for (let s = S; s > 0 && sets.length < limit; s--) {
        if (dp[s] === INF) continue;
        const counts = new Array(types.length).fill(0);
        let cur = s;
        for (let k = types.length - 1; k >= 0; k--) { const x = take[k][cur]; counts[k] = x; cur -= x * types[k].cap; }
        const out = [];
        counts.forEach((x, k) => { for (let j = 0; j < x; j++) out.push(types[k].rooms[j]); });
        sets.push(out.sort((a, b) => a - b));
    }
    return sets;
}

/**
 * Best Fit Decreasing: `items` (each with `size`) into `bins` (each with `free`), largest item first, each in
 * the bin where it leaves the fewest free beds; `fits(bin, item)` says whether it may go there at all (rules,
 * capacity already checked), `prefer(bin, item)` breaks ties (lower is better) — or, with `preferFirst`, ranks
 * before the free beds (the preferences kept when the room set is already chosen). Mutates nothing: returns
 * { placed: [[item, bin]], left: [items] } in placement order.
 */
function packInto(items, bins, fits, prefer = () => 0, preferFirst = false) {
    const free = new Map(bins.map(b => [b, b.free]));
    const contents = new Map(bins.map(b => [b, []]));
    const order = items.map((it, i) => ({ it, i })).sort((a, b) => b.it.size - a.it.size || a.i - b.i).map(x => x.it);
    const placed = [], left = [];
    for (const it of order) {
        let best = null, bestKey = null;
        bins.forEach((b, bi) => {
            const f = free.get(b);
            if (f < it.size || !fits(b, it, contents.get(b))) return;
            const p = prefer(b, it, contents.get(b));
            const key = preferFirst ? [p, f - it.size, bi] : [f - it.size, p, bi];
            if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) { best = b; bestKey = key; }
        });
        if (!best) { left.push(it); continue; }
        free.set(best, free.get(best) - it.size);
        contents.get(best).push(it);
        placed.push([it, best]);
    }
    return { placed, left };
}

/**
 * Every item into `bins` (an exact search, for the few items of one class): the first assignment found, or null
 * when there is none — or none within `budget` steps. Empty bins with the same free beds are interchangeable.
 */
function exactInto(items, bins, fits, budget = 20000) {
    const order = items.map((it, i) => ({ it, i })).sort((a, b) => b.it.size - a.it.size || a.i - b.i).map(x => x.it);
    const free = bins.map(b => b.free);
    const contents = bins.map(() => []);
    let steps = 0;
    const go = (k) => {
        if (k === order.length) return true;
        if (++steps > budget) return false;
        const it = order[k];
        const emptySeen = new Set();
        for (let b = 0; b < bins.length; b++) {
            if (free[b] < it.size) continue;
            if (!contents[b].length) { if (emptySeen.has(free[b])) continue; emptySeen.add(free[b]); }
            if (!fits(bins[b], it, contents[b])) continue;
            free[b] -= it.size; contents[b].push(it);
            if (go(k + 1)) return true;
            free[b] += it.size; contents[b].pop();
        }
        return false;
    };
    if (!go(0)) return null;
    const placed = [];
    contents.forEach((c, b) => { for (const it of c) placed.push([it, bins[b]]); });
    return { placed, left: [] };
}

/**
 * Choose new rooms for `items` and pack them: tries the room sets of roomSets in order and keeps the first that
 * takes every item (or, failing that, the one that leaves the fewest people out, then uses the fewest rooms).
 * On a set, the preferences are kept first (they cost nothing once the set is chosen); then Best Fit
 * Decreasing; then, for a handful of items, an exact search. `rooms` = candidate empty rooms ({ free, … }) in
 * preference order.
 */
function packNew(items, rooms, fits, prefer = () => 0, limit = 24) {
    const need = items.reduce((n, it) => n + it.size, 0);
    if (!items.length) return { placed: [], left: [], used: [] };
    const sets = roomSets(rooms.map(r => r.free), need, limit);
    let best = null;
    for (const set of sets) {
        const bins = set.map(i => rooms[i]);
        let r = packInto(items, bins, fits, prefer, true);
        if (r.left.length) r = packInto(items, bins, fits, prefer);
        if (r.left.length && items.length <= 16 && bins.length <= 10) r = exactInto(items, bins, fits) || r;
        const out = r.left.reduce((n, it) => n + it.size, 0);
        const used = [...new Set(r.placed.map(([, b]) => b))];
        if (!best || out < best.out || (out === best.out && used.length < best.used.length)) best = { ...r, used, out };
        if (out === 0) break;
    }
    return { placed: best.placed, left: best.left, used: best.used };
}

module.exports = { roomSets, fillSets, packInto, packNew, exactInto, EXACT_SPAN };
