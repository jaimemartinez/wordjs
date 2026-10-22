/**
 * Run one write per id, one after another, and say which failed and why (the first reason is enough
 * to show). Sequential on purpose: the server's per-request gates (rate limiter, audit) see the same
 * calls the single action makes, and a failure on one row never stops the rest.
 */
export interface BulkResult<K> {
    done: K[];
    failed: Array<{ id: K; reason: string }>;
}

export async function runEach<K>(ids: K[], op: (id: K) => Promise<unknown>): Promise<BulkResult<K>> {
    const result: BulkResult<K> = { done: [], failed: [] };
    for (const id of ids) {
        try {
            await op(id);
            result.done.push(id);
        } catch (e: unknown) {
            result.failed.push({ id, reason: e instanceof Error && e.message ? e.message : String(e) });
        }
    }
    return result;
}
