/**
 * The STEM of a stored upload's file name (the route appends `-<uuid8>.<ext>`).
 *
 * ASCII only, on purpose: the stored name is also the object key when media is offloaded to S3, and the
 * offload takes only the URL-safe ASCII key characters (core/media-storage isOffloadablePath) — a file
 * named with any other letter would silently stay on local disk. The original name is not lost: it is
 * the attachment's title.
 *
 * What it does to a human name: accents fold to their base letter (ñandú → nandu), every other run of
 * characters becomes ONE dash, dashes are trimmed from both ends, and a name with nothing left (漢字,
 * שלום, 😀) becomes `file`. It used to map each character to its own dash:
 * `ñandú 漢字 😀 שלום.png` was stored as `--and------------------------<uuid>.png`.
 */
const MAX_STEM = 80;

export function uploadStem(originalName: string): string {
    const stem = String(originalName || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '-')
        .replace(/^[-_]+|[-_]+$/g, '')
        .slice(0, MAX_STEM)
        .replace(/[-_]+$/, '');
    return stem || 'file';
}
