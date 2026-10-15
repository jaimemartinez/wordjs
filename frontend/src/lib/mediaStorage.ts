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
    test: (form: MediaStorageForm) => apiPost<MediaStorageTestResult>("/media-storage/test", writeBody({ ...form, driver: "s3" })),
    migrate: (direction: "offload" | "restore", opts: { deleteLocal?: boolean; restart?: boolean } = {}) =>
        apiPost<MediaStorageView>("/media-storage/migrate", { direction, ...opts }),
};

export const MEDIA_STORAGE_SETTINGS_PATH = "/admin/settings/media-storage";
