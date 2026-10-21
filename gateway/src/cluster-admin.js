'use strict';
/**
 * The cluster as the admin panel sees it (zero config): the panel path for `scripts/cluster.js token |
 * tokens | revoke-tokens | info` and for taking a node out of the cluster.
 *
 * The gateway owns the cluster: its CA, its join tokens (cluster-tokens.json) and the registry of the
 * nodes that registered. The backend reaches these functions only through the gateway's mTLS control
 * channel with its `backend` identity (src/index.js, /cluster*), after the panel has checked who asks
 * (backend routes/cluster.ts: a network or main-site administrator, password and two-factor code).
 *
 * Removing a node takes every target of that URL out of the registry AND remembers the URL in
 * cluster-removed.json, so the node cannot put itself back by re-registering on its next heartbeat. A
 * new join token pinned to that node's host clears it: re-admitting a machine is a deliberate act.
 */
const fs = require('fs');
const path = require('path');

const MAX_TTL_MIN = 60;
const DEFAULT_TTL_MIN = 15;

function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }

/** The persisted set of removed node URLs. */
function removedStore(file) {
    const load = () => new Set(Array.isArray(readJson(file, [])) ? readJson(file, []) : []);
    let set = load();
    const save = () => {
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify([...set], null, 2), { mode: 0o600 });
        fs.renameSync(tmp, file);
    };
    return {
        has: (url) => set.has(String(url)),
        add: (url) => { set.add(String(url)); save(); },
        /** Forget every removed URL on `host` (a new join token was minted for it). */
        clearHost: (host) => {
            const h = String(host || '').toLowerCase();
            if (!h) return 0;
            let n = 0;
            for (const url of [...set]) {
                let uh = null;
                try { uh = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { /* not a url */ }
                if (uh === h) { set.delete(url); n++; }
            }
            if (n) save();
            return n;
        },
        list: () => [...set],
        reload: () => { set = load(); },
    };
}

/** Every registered node, by URL: its role (the identity that registered it), routes and health. */
function describeNodes(registry, targetOwner) {
    const byUrl = new Map();
    registry.forEach((group, route) => {
        group.targets.forEach((url) => {
            const n = byUrl.get(url) || { url, role: targetOwner.get(url) || null, routes: [], status: 'unknown', latencyMs: null, lastError: null };
            n.routes.push(route);
            const m = group.metrics && group.metrics.get ? group.metrics.get(url) : null;
            if (m) {
                // The gateway's 30-second health sweep: a node is down when any of its routes is failing.
                if (m.status === 'Failing') { n.status = 'down'; n.lastError = m.lastError ? String(m.lastError).slice(0, 200) : null; }
                else if (m.status === 'Healthy' && n.status !== 'down') n.status = 'up';
                if (typeof m.latency === 'number') n.latencyMs = m.latency;
            }
            byUrl.set(url, n);
        });
    });
    // A node that does not answer has no latency: the last one measured while it was up is not shown as
    // if it were current (QA X1-04).
    for (const n of byUrl.values()) if (n.status === 'down') n.latencyMs = null;
    return [...byUrl.values()].sort((a, b) => String(a.role).localeCompare(String(b.role)) || a.url.localeCompare(b.url));
}

/** Take a node out: every target with this URL leaves every group. Returns how many routes it served. */
function removeNode(registry, targetOwner, url) {
    let n = 0;
    registry.forEach((group) => {
        if (group.targets.delete(url)) {
            n++;
            if (group.metrics && group.metrics.delete) group.metrics.delete(url);
        }
    });
    targetOwner.delete(url);
    return n;
}

/** A join token's lifetime from the panel: whole minutes, 1 to 60, 15 by default. */
function ttlMinutes(raw) {
    if (raw === undefined || raw === null || raw === '') return DEFAULT_TTL_MIN;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TTL_MIN) return null;
    return n;
}

/** The host a token may pin: an IP literal or a DNS name, nothing that could smuggle anything else. */
function pinnedHost(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const s = String(raw).trim();
    if (s.length > 253) return undefined;
    if (require('net').isIP(s)) return s;
    if (/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(s)) return s.toLowerCase();
    return undefined;
}

/** The command a new node runs (what `cluster.js token` prints). */
function joinCommand({ role, gatewayHost, enrollPort, token, caFingerprint, host }) {
    return [
        `node scripts/node-join.js --role ${role} --gateway ${gatewayHost}`,
        `--enroll-port ${enrollPort} --token ${token}`,
        `--ca-hash ${caFingerprint} --advertise ${host || '<this-node-ip>'} --start`,
    ].join(' \\\n     ');
}

module.exports = { removedStore, describeNodes, removeNode, ttlMinutes, pinnedHost, joinCommand, MAX_TTL_MIN, DEFAULT_TTL_MIN, path };
