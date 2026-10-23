/**
 * The site's own clock (Settings → General → Time zone, `timezone_string`).
 *
 * Every row with a date keeps two columns, WordPress-style: the moment in UTC (`*_gmt`) and the same moment
 * as the site's wall clock (`post_date`, `comment_date`, `post_modified`). The local column used to be built
 * from the SERVER's clock (`new Date().getHours()` …), so a site set to UTC on a host at UTC-5 stored a
 * comment written at 03:42 UTC on the 23rd as «22:42 on the 22nd», and the page showed the comment a day
 * before the post it answers (FALLOS 135). These helpers build it from the site time zone instead, on any host.
 */

/** `YYYY-MM-DD HH:MM:SS` of a moment in UTC. */
function gmtDateTime(date: Date): string {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** One formatter per zone: building an Intl.DateTimeFormat costs far more than using it, on every write. */
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
    if (!formatters.has(timeZone)) {
        let fmt: Intl.DateTimeFormat | null = null;
        try {
            fmt = new Intl.DateTimeFormat('en-CA', {
                timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
            });
        } catch { /* not an IANA zone */ }
        formatters.set(timeZone, fmt);
    }
    return formatters.get(timeZone) ?? null;
}

/** `YYYY-MM-DD HH:MM:SS` of a moment on the wall clock of IANA zone `timeZone` (UTC when it is not one). */
function localDateTimeIn(date: Date, timeZone: string): string {
    const fmt = formatterFor(timeZone);
    if (!fmt) return gmtDateTime(date);
    const parts = fmt.formatToParts(date);
    const get = (type: string) => (parts.find((p) => p.type === type) || { value: '00' }).value;
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/** The site time zone, or UTC when none (or an unusable one) is set. */
async function siteTimeZone(): Promise<string> {
    const raw = String((await require('./options').getOption('timezone_string', 'UTC')) || '').trim();
    return raw && formatterFor(raw) ? raw : 'UTC';
}

/** A moment as the site's wall clock. */
async function siteLocalDateTime(date: Date = new Date()): Promise<string> {
    return localDateTimeIn(date, await siteTimeZone());
}

/** The pair a row stores for a moment: the site's wall clock and UTC. */
async function siteDatePair(date: Date = new Date()): Promise<{ local: string; gmt: string }> {
    return { local: await siteLocalDateTime(date), gmt: gmtDateTime(date) };
}

module.exports = { gmtDateTime, localDateTimeIn, siteTimeZone, siteLocalDateTime, siteDatePair };
