/**
 * Magic-byte MIME detection through `file-type`, loaded from CommonJS.
 *
 * file-type 17+ is ESM-only, and the backend compiles to CommonJS (tsconfig `module: commonjs`), where
 * TypeScript rewrites a literal `import()` into `require()`. `require()` of an ES module only works on
 * Node >= 22.12 without a flag, but the declared floor is Node 22.0, so the module is loaded with a real
 * dynamic `import()` instead. That import is built with `new Function` purely so TypeScript leaves it
 * alone; the specifier is a constant file URL resolved here, never input.
 *
 * file-type 22 publishes ONE entry (the `./core` subpath of 21.x is gone), exported with a `default`
 * condition, so `require.resolve('file-type')` finds it on every supported Node and it carries
 * `fileTypeFromBuffer`.
 */
import { pathToFileURL } from 'url';

export interface DetectedFileType {
    ext: string;
    mime: string;
}

interface FileTypeCore {
    fileTypeFromBuffer(input: Uint8Array | ArrayBuffer): Promise<DetectedFileType | undefined>;
}

const importEsm = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<FileTypeCore>;

let loading: Promise<FileTypeCore> | null = null;

function loadFileType(): Promise<FileTypeCore> {
    if (!loading) {
        loading = importEsm(pathToFileURL(require.resolve('file-type')).href);
        // A failed load is not cached, so a transient error does not disable detection for good.
        loading.catch(() => { loading = null; });
    }
    return loading;
}

/** The type file-type recognises in `input`, or undefined when it recognises nothing. */
export async function fileTypeFromBuffer(input: Uint8Array | ArrayBuffer): Promise<DetectedFileType | undefined> {
    const fileType = await loadFileType();
    return fileType.fileTypeFromBuffer(input);
}
