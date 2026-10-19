/**
 * Settings → Media storage: the client of backend/src/routes/media-storage.ts (administrators only).
 *
 *   GET  /media-storage          masked configuration, field sources, effective store, state, progress
 *   PUT  /media-storage          save the `mediaStorage` block (an empty secret keeps the stored one)
 *   POST /media-storage/test     probe a (possibly unsaved) configuration: write, read, public, delete
 *   POST /media-storage/migrate  start/resume { direction: 'offload' | 'restore', deleteLocal?, restart? }
 *
 * Credentials are write-only: the secret access key never comes back, only `secretAccessKeySet` and a
 * four-character hint.
 */
import { apiGet, apiPost, apiPut } from "@/lib/api";

export type MediaStorageDriver = "local" | "s3";
export type MediaStorageLibraryState = "local" | "migrating" | "offloaded" | "restoring";
export type FieldSource = "file" | "env" | "default";

export interface MediaStorageProgress {
    direction: "offload" | "restore";
    status: "running" | "done" | "failed" | "interrupted";
    startedAt: string;
    updatedAt: string;
    finishedAt: string | null;
    total: number;
    processed: number;
    moved: number;
    skipped: number;
    failed: number;
    failures: Array<{ id: number; error: string }>;
    error: string | null;
}

export interface MediaStorageView {
    /** Non-blocking advice about the saved values (e.g. a public URL that repeats the key prefix). */
    warnings?: Array<{ field: string; code: string; message: string }>;
    driver: MediaStorageDriver;
    bucket: string;
    region: string;
    endpoint: string;
    prefix: string;
    publicUrl: string;
    keepLocalCopy: boolean;
    accessKeyIdHint: string | null;
    secretAccessKeySet: boolean;
    secretAccessKeyHint: string | null;
    sessionTokenSet: boolean;
    sources: Record<string, FieldSource>;
    effective: { driver: MediaStorageDriver; incomplete: string[] | null; publicBase: string | null; publicOrigin: string | null };
    state: MediaStorageLibraryState;
    migration: MediaStorageProgress | null;
    running: boolean;
    /** Multisite: each site's own library state (site 1 first). A move runs for every site of the network. */
    sites?: Array<{ siteId: number; host: string; state: MediaStorageLibraryState | null; inBucket: number | null; migration: MediaStorageProgress | null; error?: string }>;
}

export interface MediaStorageForm {
    driver: MediaStorageDriver;
    bucket: string;
    region: string;
    endpoint: string;
    prefix: string;
    publicUrl: string;
    accessKeyId: string;
    secretAccessKey: string;
    keepLocalCopy: boolean;
}

export interface MediaStorageTestResult {
    ok: boolean;
    steps: Array<{ step: "write" | "read" | "public" | "delete"; ok: boolean; detail: string }>;
    /** First call only: the probe object the browser must load, then ask to delete. */
    probe?: string;
    publicUrl?: string;
}

/**
 * Can THIS browser load `url` as an image? The public check of the connection test runs here, in the
 * viewer's network, rather than on the server: it is what every visitor's browser will do, and the
 * server never has to fetch an operator-typed URL. Resolves false on error or after `timeoutMs`.
 */
export function browserLoadsImage(url: string, timeoutMs = 15000): Promise<boolean> {
    return new Promise((resolve) => {
        const img = new Image();
        const timer = setTimeout(() => { img.src = ""; resolve(false); }, timeoutMs);
        img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth > 0); };
        img.onerror = () => { clearTimeout(timer); resolve(false); };
        img.src = `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
    });
}

/**
 * The whole connection test: the server writes and reads a probe, this browser loads it from the
 * public URL, and the server deletes it. Steps come back in that order.
 */
export async function runConnectionTest(form: MediaStorageForm): Promise<MediaStorageTestResult> {
    const body = writeBody({ ...form, driver: "s3" });
    const first = await apiPost<MediaStorageTestResult>("/media-storage/test", body);
    if (!first.probe || !first.publicUrl) return first;
    const loaded = await browserLoadsImage(first.publicUrl);
    const steps = [...first.steps, {
        step: "public" as const,
        ok: loaded,
        detail: loaded ? first.publicUrl : `${first.publicUrl} (not loadable from this browser)`,
    }];
    let cleanup: MediaStorageTestResult;
    try {
        cleanup = await apiPost<MediaStorageTestResult>("/media-storage/test", { ...body, probe: first.probe });
    } catch (e: any) {
        cleanup = { ok: false, steps: [{ step: "delete", ok: false, detail: e?.message || String(e) }] };
    }
    steps.push(...cleanup.steps);
    return { ok: steps.every((s) => s.ok), steps };
}

/** Form state from a view. The access key id and secret start EMPTY: they are write-only. */
export function formFromView(v: MediaStorageView): MediaStorageForm {
    return {
        driver: v.driver,
        bucket: v.bucket || "",
        region: v.region || "",
        endpoint: v.endpoint || "",
        prefix: v.prefix || "",
        publicUrl: v.publicUrl || "",
        accessKeyId: "",
        secretAccessKey: "",
        keepLocalCopy: !!v.keepLocalCopy,
    };
}

/**
 * The write body: text fields as typed; the key id and secret only when the admin typed one (empty
 * keeps what is stored — the screen never had the stored values to send back).
 */
export function writeBody(form: MediaStorageForm): Record<string, unknown> {
    const body: Record<string, unknown> = {
        driver: form.driver,
        bucket: form.bucket,
        region: form.region,
        endpoint: form.endpoint,
        prefix: form.prefix,
        publicUrl: form.publicUrl,
        keepLocalCopy: form.keepLocalCopy,
    };
    if (form.accessKeyId.trim()) body.accessKeyId = form.accessKeyId.trim();
    if (form.secretAccessKey) body.secretAccessKey = form.secretAccessKey;
    return body;
}

/** Percentage of a progress record, 0–100 (100 for an empty library). */
export function progressPercent(p: MediaStorageProgress | null): number {
    if (!p) return 0;
    if (!p.total) return p.status === "done" ? 100 : 0;
    return Math.max(0, Math.min(100, Math.round((p.processed / p.total) * 100)));
}

export const mediaStorageApi = {
    get: () => apiGet<MediaStorageView>("/media-storage"),
    save: (form: MediaStorageForm) => apiPut<MediaStorageView>("/media-storage", writeBody(form)),
    test: (form: MediaStorageForm) => runConnectionTest(form),
    migrate: (direction: "offload" | "restore", opts: { deleteLocal?: boolean; restart?: boolean } = {}) =>
        apiPost<MediaStorageView>("/media-storage/migrate", { direction, ...opts }),
};

export const MEDIA_STORAGE_SETTINGS_PATH = "/admin/settings/media-storage";
