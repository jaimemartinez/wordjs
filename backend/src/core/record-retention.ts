/**
 * WordJS — retention of the two tables anonymous traffic can feed: form submissions and webhook deliveries.
 *
 * Same reasoning as core/analytics-retention: a limiter slows a table down, only an age stops it. A daily
 * cron removes, in bounded batches:
 *   - `form_submissions` older than `forms_retention_days` (default 730; 0 keeps them for ever);
 *   - finished `webhook_deliveries` older than `webhook_deliveries_retention_days` (default 30). A delivery
 *     still pending or in flight is never touched.
 */

const { dbAsync } = require('../config/database');
const { getOption } = require('./options');
const { addAction } = require('./hooks');
const { dbTimestamp, databaseNowMs } = require('./analytics-retention');
const log = require('./module-logger').moduleLogger('core/record-retention');

const HOOK = 'wordjs_record_retention_prune';
const BATCH = 5000;
const MAX_BATCHES = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

async function days(option: string, fallback: number): Promise<number> {
    const n = Number(await getOption(option, fallback));
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Delete in batches until nothing matches, or the run's ceiling. Returns how many rows went. */
async function prune(table: string, where: string, params: any[]): Promise<number> {
    let removed = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
        const rows = (await dbAsync.all(`SELECT id FROM ${table} WHERE ${where} ORDER BY id ASC LIMIT ?`, [...params, BATCH])) || [];
        if (!rows.length) break;
        const ids = rows.map((r: any) => r.id);
        await dbAsync.run(`DELETE FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
        removed += ids.length;
        if (ids.length < BATCH) break;
    }
    return removed;
}

async function pruneRecords(): Promise<{ forms: number; deliveries: number }> {
    const now = await databaseNowMs(Date.now());
    const formDays = await days('forms_retention_days', 730);
    const deliveryDays = await days('webhook_deliveries_retention_days', 30);
    const forms = formDays > 0 ? await prune('form_submissions', 'created_at < ?', [dbTimestamp(now - formDays * DAY_MS)]) : 0;
    const deliveries = deliveryDays > 0
        ? await prune('webhook_deliveries', "status NOT IN ('pending','delivering') AND created_at < ?", [dbTimestamp(now - deliveryDays * DAY_MS)])
        : 0;
    return { forms, deliveries };
}

function initRecordRetention(): void {
    addAction(HOOK, async () => {
        try {
            const r = await pruneRecords();
            if (r.forms || r.deliveries) log.info(r, 'Old records removed');
        } catch (e: any) {
            log.error({ err: e }, 'Record retention prune failed');
        }
    });
}

module.exports = { initRecordRetention, pruneRecords, HOOK };
