/**
 * Uploading several files from one pick or drop.
 *
 * The media screen read `files[0]` and dropped the rest without a word ("Handle only first file for
 * now"): choose four, get one. Files go up ONE AT A TIME (each upload is processed into responsive sizes
 * on the server; four in parallel would quadruple that work and the rate-limit cost at once), every
 * file is attempted even when an earlier one fails, and the caller gets back exactly which ones failed
 * and why, so it can say so.
 */
export interface UploadFailure {
    name: string;
    message: string;
}

export interface UploadQueueResult {
    uploaded: number;
    failed: UploadFailure[];
}

export interface UploadProgress {
    /** 1-based index of the file being sent. */
    index: number;
    total: number;
    name: string;
    /** 0–100 for the current file. */
    percent: number;
}

export async function uploadSequentially(
    files: ArrayLike<File> | null | undefined,
    uploadOne: (file: File, onPercent: (percent: number) => void) => Promise<unknown>,
    onProgress?: (p: UploadProgress) => void,
): Promise<UploadQueueResult> {
    const list = files ? Array.from(files) : [];
    const result: UploadQueueResult = { uploaded: 0, failed: [] };
    for (let i = 0; i < list.length; i++) {
        const file = list[i];
        const report = (percent: number) => onProgress?.({ index: i + 1, total: list.length, name: file.name, percent: Math.round(percent) });
        report(0);
        try {
            await uploadOne(file, report);
            result.uploaded++;
        } catch (err: unknown) {
            const message = err instanceof Error && err.message ? err.message : String(err || "Upload failed");
            result.failed.push({ name: file.name, message });
        }
    }
    return result;
}
