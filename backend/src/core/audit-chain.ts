/**
 * WordJS — Tamper evidence for the audit log: a hash chain over its rows.
 *
 * Every row, once SEALED, carries
 *   chain_seq  its place in the chain (1, 2, 3, … with no gaps; UNIQUE)
 *   prev_hash  the row_hash of the row before it ('' for the very first row)
 *   row_hash   sha256 over (seq, prev_hash and every stored field of the row)
 * so a row that is edited no longer matches its own hash, and a row that is removed leaves a gap in the
 * sequence and a broken link. `verifyAuditChain()` walks the chain and names the first place it breaks;
 * GET /audit/verify and Site Health report it.
 *
 * SEALING is separate from the INSERT on purpose: recordAudit stays a single INSERT that can never fail
 * a mutation, and a row written inside a transaction that rolls back is never sealed. sealPending() takes
 * the rows without a place, oldest id first, and gives each the next place with a guarded UPDATE
 * (`WHERE chain_seq IS NULL`); two nodes sealing at once collide on the UNIQUE chain_seq and the loser
 * re-reads the head, so the chain stays one line. It runs after every recorded event (after COMMIT inside
 * a transaction) and before every prune.
 *
 * RETENTION removes rows past the window. Before it deletes, it records the hash of every removed row whose
 * successor stays (option audit_chain_anchor: `holes`, seq → row_hash), and the highest place it ever
 * removed (`seq`/`hash`). A gap in the sequence then verifies only if the row after it links to the hash
 * recorded for the place just before it: a row removed by the prune is accounted for, any other is not.
 *
 * What it does not do on its own: someone with write access to the database itself can rebuild a whole
 * chain. The external copy (core/audit-export) is what makes that visible — the receiver already holds
 * every row's hash.
 */

const crypto = require('crypto');
const log = require('./module-logger').moduleLogger('core/audit-chain');

const CHAIN_VERSION = 'wordjs-audit-v1';
const SEAL_BATCH = 200;
const ANCHOR_OPTION = 'audit_chain_anchor';

type Q = {
    run: (sql: string, params?: any[]) => Promise<any>;
    get: (sql: string, params?: any[]) => Promise<any>;
    all: (sql: string, params?: any[]) => Promise<any>;
};

function defaultQ(): Q {
    const { dbAsync } = require('../config/database');
    return {
        run: (sql, params = []) => dbAsync.run(sql, params),
        get: (sql, params = []) => dbAsync.get(sql, params),
        all: (sql, params = []) => dbAsync.all(sql, params),
    };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * created_at as the 'YYYY-MM-DD HH:MM:SS' text the column holds, whatever the driver hands back. pg parses
 * a TIMESTAMP without time zone as LOCAL time, so the local fields give the stored wall-clock text back.
 */
function canonicalTs(v: any): string {
    if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) return '';
        return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
    }
    if (v === null || v === undefined) return '';
    return String(v).replace('T', ' ').slice(0, 19);
}

function canonicalActor(v: any): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** The hash of one row at one place in the chain. */
function rowHash(seq: number, prevHash: string, row: any): string {
    const material = JSON.stringify([
        CHAIN_VERSION, Number(seq), String(prevHash || ''), Number(row.id),
        canonicalActor(row.actor_id), String(row.action ?? ''), String(row.target_type ?? ''), String(row.target_id ?? ''),
        String(row.detail ?? ''), canonicalTs(row.created_at),
    ]);
    return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

type Anchor = { seq: number; hash: string };
/** The prune's record: the highest place it removed, and the hash of each removed row whose successor stayed. */
type AnchorRecord = Anchor & { holes: Record<string, string> };
const MAX_HOLES = 10_000;

async function readAnchor(): Promise<AnchorRecord> {
    try {
        const raw = await require('./options').getOptionFresh(ANCHOR_OPTION, null);
        const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (a && Number.isInteger(Number(a.seq)) && Number(a.seq) > 0 && typeof a.hash === 'string') {
            const holes: Record<string, string> = {};
            if (a.holes && typeof a.holes === 'object') {
                for (const [k, v] of Object.entries(a.holes)) if (/^\d+$/.test(k) && typeof v === 'string') holes[k] = v;
            }
            return { seq: Number(a.seq), hash: a.hash, holes };
        }
    } catch { /* no anchor */ }
    return { seq: 0, hash: '', holes: {} };
}

async function writeAnchor(a: AnchorRecord): Promise<void> {
    await require('./options').updateOption(ANCHOR_OPTION, JSON.stringify({ seq: a.seq, hash: a.hash, holes: a.holes }), 'no');
}

/**
 * Record, BEFORE they are deleted, what verification needs to accept the gaps `rows` leave. Returns false
 * (delete nothing) when the record would grow past its bound — a pathological pattern of removals.
 */
async function recordRemoval(rows: Array<{ seq: number; hash: string }>, q: Q = defaultQ()): Promise<boolean> {
    if (!rows.length) return true;
    const a = await readAnchor();
    const doomed = new Set(rows.map((r) => r.seq));
    for (const r of rows) {
        if (!doomed.has(r.seq + 1)) a.holes[String(r.seq)] = r.hash;
        if (r.seq > a.seq) { a.seq = r.seq; a.hash = r.hash; }
    }
    // Entries before the oldest surviving row are no longer consulted, except the one right before it.
    const first = await q.get('SELECT MIN(chain_seq) AS s FROM audit_log WHERE chain_seq IS NOT NULL');
    const keepFrom = first && first.s !== null && first.s !== undefined ? Number(first.s) - 1 : 0;
    for (const k of Object.keys(a.holes)) {
        const n = Number(k);
        if (n < keepFrom && !doomed.has(n) && n !== a.seq) delete a.holes[k];
    }
    if (Object.keys(a.holes).length > MAX_HOLES) return false;
    await writeAnchor(a);
    return true;
}

async function chainHead(q: Q): Promise<Anchor> {
    const head = await q.get('SELECT chain_seq, row_hash FROM audit_log WHERE chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1');
    const anchor = await readAnchor();
    // A place the prune removed is never given out again, even when the newest rows were the ones removed.
    if (head && Number(head.chain_seq) >= anchor.seq) return { seq: Number(head.chain_seq), hash: String(head.row_hash || '') };
    return { seq: anchor.seq, hash: anchor.hash };
}

/** One pass: seal every row without a place. Returns how many rows THIS pass sealed. */
async function sealOnce(q: Q): Promise<number> {
    const { isUniqueViolation } = require('./db-errors');
    let sealed = 0;
    for (let guard = 0; guard < 10_000; guard++) {
        const rows = (await q.all(
            'SELECT id, actor_id, action, target_type, target_id, detail, created_at FROM audit_log WHERE chain_seq IS NULL ORDER BY id ASC LIMIT ?',
            [SEAL_BATCH]
        )) || [];
        if (!rows.length) return sealed;
        let prev = await chainHead(q);
        let raced = false;
        for (const row of rows) {
            const seq = prev.seq + 1;
            const hash = rowHash(seq, prev.hash, row);
            let r: any;
            try {
                r = await q.run(
                    'UPDATE audit_log SET chain_seq = ?, prev_hash = ?, row_hash = ? WHERE id = ? AND chain_seq IS NULL',
                    [seq, prev.hash, hash, row.id]
                );
            } catch (e: any) {
                if (!isUniqueViolation(e)) throw e;
                raced = true; // another node took this place: re-read the head
                break;
            }
            if (!r || Number(r.changes) !== 1) { raced = true; break; }
            sealed++;
            prev = { seq, hash };
        }
        if (raced) continue;
    }
    return sealed;
}

// One sealing pass at a time per site in this process; an event that arrives while one runs asks for
// another pass instead of starting a second, concurrent one.
const inFlight = new Map<string, Promise<number>>();
const again = new Set<string>();

function siteKey(): string {
    try { return String(require('./site-context').currentSiteIdOrNull() ?? 'none'); } catch { return 'none'; }
}

/** Seal every unsealed row. Never throws; returns how many rows were sealed. */
function sealPending(q: Q = defaultQ()): Promise<number> {
    const key = siteKey();
    const running = inFlight.get(key);
    if (running) { again.add(key); return running; }
    const p = (async () => {
        let total = 0;
        try {
            do {
                again.delete(key);
                total += await sealOnce(q);
            } while (again.has(key));
            if (total) require('./audit-export').scheduleFlush();
        } catch (e: any) {
            log.warn({ err: e }, '[audit-chain] sealing failed (the rows stay pending and are sealed by the next pass)');
        }
        return total;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
}

export type ChainBreak = { seq: number | null; id: number | null; reason: 'start' | 'gap' | 'link' | 'altered' };
export type ChainReport = {
    ok: boolean;
    complete: boolean;
    checked: number;
    pending: number;
    oldestPendingAt: string | null;
    head: { seq: number; hash: string } | null;
    anchor: { seq: number; hash: string } | null;
    firstBreak: ChainBreak | null;
};

/**
 * Walk the chain from its first remaining row. Stops at the first break (the report names it) or when
 * `maxMs` runs out (complete: false). Read-only.
 */
async function verifyAuditChain(opts: { maxMs?: number; batch?: number } = {}, q: Q = defaultQ()): Promise<ChainReport> {
    const maxMs = opts.maxMs ?? 20_000;
    const batch = Math.max(10, opts.batch ?? 1000);
    const started = Date.now();
    const anchor = await readAnchor();
    const pendingRow = await q.get('SELECT COUNT(*) AS c, MIN(created_at) AS oldest FROM audit_log WHERE chain_seq IS NULL');
    const pending = pendingRow ? Number(pendingRow.c) || 0 : 0;
    const report: ChainReport = {
        ok: true, complete: true, checked: 0, pending,
        oldestPendingAt: pending && pendingRow ? canonicalTs(pendingRow.oldest) || null : null,
        head: null, anchor: anchor.seq ? { seq: anchor.seq, hash: anchor.hash } : null, firstBreak: null,
    };
    let last: Anchor | null = null;
    let after = 0;
    for (;;) {
        if (Date.now() - started > maxMs) { report.complete = false; break; }
        const rows = (await q.all(
            'SELECT id, actor_id, action, target_type, target_id, detail, created_at, chain_seq, prev_hash, row_hash FROM audit_log WHERE chain_seq IS NOT NULL AND chain_seq > ? ORDER BY chain_seq ASC LIMIT ?',
            [after, batch]
        )) || [];
        if (!rows.length) break;
        for (const row of rows) {
            const seq = Number(row.chain_seq);
            const prevHash = String(row.prev_hash ?? '');
            const breakAt = (reason: ChainBreak['reason']) => { report.ok = false; report.firstBreak = { seq, id: Number(row.id), reason }; };
            // The row before this one is either the previous row read, or — across a gap — a row the
            // prune removed and recorded. Place 1 links to nothing.
            const expectedPrev = last !== null && seq === last.seq + 1 ? last.hash
                : seq === 1 ? ''
                : Object.prototype.hasOwnProperty.call(anchor.holes, String(seq - 1)) ? anchor.holes[String(seq - 1)]
                : null;
            if (expectedPrev === null) { breakAt(last === null ? 'start' : 'gap'); return report; }
            if (prevHash !== expectedPrev) { breakAt(last === null && seq !== 1 ? 'start' : 'link'); return report; }
            if (rowHash(seq, prevHash, row) !== String(row.row_hash)) { breakAt('altered'); return report; }
            last = { seq, hash: String(row.row_hash) };
            report.checked++;
            after = seq;
        }
    }
    report.head = last;
    return report;
}

/** Sealed rows older than `cutoff`, in chain order, at most `limit` of them: what the prune removes next. */
async function prunableRows(cutoff: string, limit: number, q: Q = defaultQ()): Promise<Array<{ id: number; seq: number; hash: string }>> {
    const rows = (await q.all(
        'SELECT id, chain_seq, row_hash FROM audit_log WHERE chain_seq IS NOT NULL AND created_at < ? ORDER BY chain_seq ASC LIMIT ?',
        [cutoff, limit]
    )) || [];
    return rows.map((r: any) => ({ id: Number(r.id), seq: Number(r.chain_seq), hash: String(r.row_hash || '') }));
}

module.exports = {
    sealPending, verifyAuditChain, prunableRows, recordRemoval, readAnchor, rowHash, canonicalTs,
    ANCHOR_OPTION,
};
