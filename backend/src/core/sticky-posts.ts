/**
 * Sticky posts (WordPress "Stick to the top of the blog"): the ids are kept in the `sticky_posts`
 * option as a JSON array, as WordPress keeps them, so a WXR import and the editor write the same thing
 * and the public front page lists them first.
 */
const { getOption, updateOption } = require('./options');

const MAX_STICKY = 100;

function parseIds(raw: unknown): number[] {
    let list: unknown = raw;
    if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch { list = []; } }
    if (!Array.isArray(list)) return [];
    const out: number[] = [];
    for (const v of list) {
        const n = Number(v);
        if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
    }
    return out.slice(0, MAX_STICKY);
}

async function getStickyIds(): Promise<number[]> {
    return parseIds(await getOption('sticky_posts', '[]'));
}

async function isSticky(id: number): Promise<boolean> {
    return (await getStickyIds()).includes(Number(id));
}

/** Stick (or unstick) one post. Newest stuck first, as WordPress lists them. */
async function setSticky(id: number, sticky: boolean): Promise<void> {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n <= 0) return;
    const ids = (await getStickyIds()).filter((x) => x !== n);
    if (sticky) ids.unshift(n);
    await updateOption('sticky_posts', JSON.stringify(ids.slice(0, MAX_STICKY)));
}

module.exports = { getStickyIds, isSticky, setSticky, parseIds };
