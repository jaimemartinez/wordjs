/**
 * The one copy helper of the plugin (2.36.8): every «Copiar enlace / mensaje / código» goes through it, on the
 * admin and on the coordinators' portal.
 *
 * Phones were the problem («en móviles no me deja copiar el link»):
 *   - an http address (a LAN IP, a site before its certificate) has no Clipboard API at all;
 *   - the old fallback did `textarea.select()`, which selects nothing on iOS, so `execCommand('copy')` copied
 *     nothing;
 *   - several buttons had no fallback, or showed the link in a toast that cannot be selected on a phone.
 *
 * So: the Clipboard API is called at once inside the tap (never after an await — Safari only lets a page write
 * the clipboard during the gesture); without it, or when it refuses, a hidden read-only textarea is selected with
 * setSelectionRange (the iOS way) and `execCommand('copy')`. When both fail the caller shows the text
 * in a field to copy by hand (lib/CopyFallback) — «Copiado» is said only when something was really copied.
 *
 * `env` lets the tests stand in for the browser.
 */

export interface CopyEnv {
    nav?: any;
    doc?: any;
    win?: any;
}

const live = (): CopyEnv => ({
    nav: typeof navigator !== 'undefined' ? navigator : null,
    doc: typeof document !== 'undefined' ? document : null,
    win: typeof window !== 'undefined' ? window : null,
});

/** The hidden-textarea copy, done the way iOS Safari accepts it. Synchronous: call it inside the tap. */
export function legacyCopy(text: string, env: CopyEnv = live()): boolean {
    const doc = env.doc;
    if (!doc || !doc.body || typeof doc.execCommand !== 'function') return false;
    const active = doc.activeElement;
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');          // no keyboard on a phone
    ta.setAttribute('aria-hidden', 'true');
    // 16px: Safari zooms into a smaller field; fixed + transparent: the page does not jump.
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;margin:0;opacity:0;font-size:16px;';
    doc.body.appendChild(ta);
    let ok = false;
    try {
        try { ta.focus({ preventScroll: true }); } catch { /* old browsers */ }
        ta.select();
        // iOS ignores select(): only a selection range selects the text of a field there.
        try { ta.setSelectionRange(0, text.length); } catch { /* not every node */ }
        ok = !!doc.execCommand('copy');
    } catch {
        ok = false;
    } finally {
        ta.remove();
        try { if (active && typeof active.focus === 'function') active.focus({ preventScroll: true }); } catch { /* nothing to restore */ }
    }
    return ok;
}

/**
 * Copy `text`. Call it straight from the tap's handler, before any await. true only when it was copied; on false
 * the caller shows the text to copy by hand.
 */
export function copyText(text: string, env: CopyEnv = live()): Promise<boolean> {
    const value = String(text ?? '');
    if (!value) return Promise.resolve(false);
    const clip = env.nav && env.nav.clipboard;
    const secure = !env.win || env.win.isSecureContext !== false;
    if (clip && typeof clip.writeText === 'function' && secure) {
        let started: Promise<unknown>;
        try { started = clip.writeText(value); } catch { return Promise.resolve(legacyCopy(value, env)); }
        // Refused (a document without focus, a permission): the old way, which a browser that still counts the
        // tap allows; else false and the text is shown.
        return Promise.resolve(started).then(() => true, () => legacyCopy(value, env));
    }
    return Promise.resolve(legacyCopy(value, env));
}

/**
 * Copy text that is still being fetched (a link made on the server): the write starts IN the tap with a promise
 * of the text (ClipboardItem — Safari's way); elsewhere it waits and copies. false: show the text by hand.
 */
export async function copyLater(text: Promise<string>, env: CopyEnv = live()): Promise<boolean> {
    const CI = env.win && env.win.ClipboardItem;
    const clip = env.nav && env.nav.clipboard;
    const secure = !env.win || env.win.isSecureContext !== false;
    if (CI && clip && typeof clip.write === 'function' && secure) {
        try { await clip.write([new CI({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })]); return true; }
        catch { /* fall back */ }
    }
    try { return await copyText(await text, env); } catch { return false; }
}

/** The phone's share sheet (WhatsApp, Messages…) is there. */
export function canShare(env: CopyEnv = live()): boolean {
    return !!(env.nav && typeof env.nav.share === 'function');
}

/**
 * Open the share sheet. 'shared', 'cancelled' (the person closed it: nothing to fall back to) or 'unsupported'
 * (no sheet, or it refused: the caller copies instead).
 */
export async function shareText(data: { title?: string; text?: string; url?: string }, env: CopyEnv = live()): Promise<'shared' | 'cancelled' | 'unsupported'> {
    if (!canShare(env)) return 'unsupported';
    try { await env.nav.share(data); return 'shared'; }
    catch (e: any) { return e && e.name === 'AbortError' ? 'cancelled' : 'unsupported'; }
}
