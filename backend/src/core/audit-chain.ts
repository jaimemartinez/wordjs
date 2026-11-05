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
 * THE HEAD MARK is the last sealed place and its hash, kept in a file next to the database (host-only state
 * under data/, no plugin reads or writes it), so it survives whatever happens to the rows. The newest rows
 * leave no gap when they go, so the chain alone cannot tell they ever existed: the mark can. It moves forward
 * only while the place it names still holds that hash; otherwise it stays where it is and verify reports
 * `truncated`. A restore is the legitimate way back: its audit row names the places it went from and to
 * (`rewinds` in the report), and an administrator can accept any other loss (acceptHeadLoss).
 *
 * What it does not do on its own: someone with write access to the database itself can rebuild a whole
 * chain. The external copy (core/audit-export) is what makes that visible — the receiver already holds
 * every row's hash.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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

type HeadMark = { seq: number; hash: string; spent?: string[] };
export type ChainRewind = { action: string; fromSeq: number; toSeq: number; at: string; actorId: number | null };

/** The rows that say the log went back on purpose. */
const REWIND_ACTIONS = ['backup.restore', 'audit.head.accept'];

function headMarkFile(): string {
    const dbPath = path.resolve(require('../config/app').dbPath || './data/wordjs-native.db');
    return path.join(path.dirname(dbPath), 'sandbox', 'audit-head', `${path.basename(dbPath)}.${siteKey()}.json`);
}

function readHeadMark(): HeadMark | null {
    try {
        const m = JSON.parse(fs.readFileSync(headMarkFile(), 'utf8'));
        return m && Number.isInteger(m.seq) && m.seq > 0 && typeof m.hash === 'string'
            ? { seq: m.seq, hash: m.hash, spent: Array.isArray(m.spent) ? m.spent.map(String) : [] }
            : null;
    } catch { return null; }
}

function writeHeadMark(mark: HeadMark): void {
    const file = headMarkFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(mark), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
}

/** A new installation starts a new log: the mark of the one before it says nothing about this one. */
function forgetHeadMark(): void {
    try { fs.rmSync(headMarkFile(), { force: true }); } catch { /* nothing to forget */ }
}

/** Does the place the mark names still hold its row? A row the prune removed is accounted for by the anchor. */
async function headMarkHolds(mark: HeadMark, q: Q): Promise<boolean> {
    const row = await q.get('SELECT row_hash FROM audit_log WHERE chain_seq = ?', [mark.seq]);
    if (row) return String(row.row_hash) === mark.hash;
    return mark.seq <= (await readAnchor()).seq;
}

/** Every recorded rewind, newest first. */
async function chainRewinds(q: Q): Promise<ChainRewind[]> {
    const rows = (await q.all(
        'SELECT action, actor_id, detail, created_at FROM audit_log WHERE action IN (?, ?) ORDER BY id DESC LIMIT 100',
        REWIND_ACTIONS
    )) || [];
    const out: ChainRewind[] = [];
    for (const row of rows) {
        let d: any = null;
        try { d = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail; } catch { /* not one */ }
        const fromSeq = Number(d && d.fromSeq);
        const toSeq = Number(d && d.toSeq);
        if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || fromSeq <= toSeq) continue;
        out.push({ action: String(row.action), fromSeq, toSeq, at: canonicalTs(row.created_at), actorId: row.actor_id === null || row.actor_id === undefined ? null : Number(row.actor_id) });
    }
    return out;
}

const rewindKey = (r: ChainRewind) => `${r.at}|${r.fromSeq}|${r.toSeq}`;

/** A rewind accounts for one loss: the numbers it took back are used again, so the mark keeps the ones it has moved past. */
const explainsLoss = (r: ChainRewind, mark: HeadMark) =>
    r.fromSeq >= mark.seq && r.toSeq < mark.seq && !(mark.spent || []).includes(rewindKey(r));

/** Move the mark to the head, unless the place it names was lost with nothing to account for it. */
async function advanceHeadMark(q: Q): Promise<void> {
    const head = await chainHead(q);
    if (!head.seq) return;
    const mark = readHeadMark();
    if (mark && mark.seq === head.seq && mark.hash === head.hash) return;
    const rewinds = await chainRewinds(q);
    if (mark && !(await headMarkHolds(mark, q)) && !rewinds.some((r) => explainsLoss(r, mark))) return;
    writeHeadMark({ seq: head.seq, hash: head.hash, spent: rewinds.map(rewindKey) });
}

/** The place of the newest sealed row (0 for an empty log). */
async function chainHeadSeq(q: Q = defaultQ()): Promise<number> {
    return (await chainHead(q)).seq;
}

/** What an administrator accepting a reported loss needs: the place the mark names, and the head now. */
async function headLoss(q: Q = defaultQ()): Promise<{ fromSeq: number; toSeq: number } | null> {
    const mark = readHeadMark();
    if (!mark || await headMarkHolds(mark, q)) return null;
    return { fromSeq: mark.seq, toSeq: Math.min((await chainHead(q)).seq, mark.seq - 1) };
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
            await advanceHeadMark(q);
        } catch (e: any) {
            log.warn({ err: e }, '[audit-chain] sealing failed (the rows stay pending and are sealed by the next pass)');
        }
        return total;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
}

export type ChainBreak = { seq: number | null; id: number | null; reason: 'start' | 'gap' | 'link' | 'altered' | 'truncated' };
export type ChainReport = {
    ok: boolean;
    complete: boolean;
    checked: number;
    pending: number;
    oldestPendingAt: string | null;
    head: { seq: number; hash: string } | null;
    anchor: { seq: number; hash: string } | null;
    firstBreak: ChainBreak | null;
    rewinds: ChainRewind[];
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
        rewinds: await chainRewinds(q),
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
    const mark = report.complete ? readHeadMark() : null;
    if (mark && !(await headMarkHolds(mark, q)) && !report.rewinds.some((r) => explainsLoss(r, mark))) {
        report.ok = false;
        report.firstBreak = { seq: mark.seq, id: null, reason: 'truncated' };
    }
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
    chainHeadSeq, headLoss, forgetHeadMark,
    ANCHOR_OPTION,
};
