/**
 * core/file-type-detect — the CommonJS bridge to the ESM-only file-type release.
 *
 * Pins three things: the bridge actually loads file-type and detects the signatures the upload
 * allowlist relies on; unknown content is reported as undefined (the callers fail closed on that);
 * and the installed file-type is a release fixed for GHSA-5v7r-6r5c-r473 (>= 21.3.1) on the 21.x line,
 * which is the last one that still supports Node 20.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
const fs = require('fs');
const path = require('path');
const { fileTypeFromBuffer } = require('../core/file-type-detect');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db40000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);

describe('file-type-detect', () => {
    it('detects binary signatures through the ESM bridge', async () => {
        assert.strictEqual((await fileTypeFromBuffer(PNG))?.mime, 'image/png');
        assert.strictEqual((await fileTypeFromBuffer(PDF))?.mime, 'application/pdf');
        assert.strictEqual((await fileTypeFromBuffer(JPEG))?.mime, 'image/jpeg');
    });

    it('reports unrecognised content as undefined', async () => {
        assert.strictEqual(await fileTypeFromBuffer(Buffer.from('<html><script>alert(1)</script></html>')), undefined);
        assert.strictEqual(await fileTypeFromBuffer(Buffer.alloc(0)), undefined);
    });

    it('returns promptly on a truncated ASF header (GHSA-5v7r-6r5c-r473 input shape)', async () => {
        // ASF header GUID followed by a sub-object whose declared size is zero.
        const asf = Buffer.concat([
            Buffer.from([0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C]),
            Buffer.alloc(14),
            Buffer.from([0x91, 0x07, 0xDC, 0xB7, 0xB7, 0xA9, 0xCF, 0x11, 0x8E, 0xE6, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65]),
            Buffer.alloc(8),
            Buffer.alloc(64),
        ]);
        let timer: NodeJS.Timeout | undefined;
        const hang = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('detection hung')), 3000); });
        try {
            await Promise.race([fileTypeFromBuffer(asf), hang]);
        } finally {
            clearTimeout(timer);
        }
    });

    it('the installed file-type is a fixed 21.x release', () => {
        const pkgPath = path.join(path.dirname(require.resolve('file-type/core')), 'package.json');
        const { version } = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const [major, minor, patch] = version.split('.').map(Number);
        assert.strictEqual(major, 21, `file-type ${version}: 22+ requires Node 22, the engines floor is 20.9`);
        assert.ok(minor > 3 || (minor === 3 && patch >= 1), `file-type ${version} is affected by GHSA-5v7r-6r5c-r473`);
    });
});
