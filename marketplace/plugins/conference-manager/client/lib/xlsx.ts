/**
 * Minimal XLSX (Office Open XML spreadsheet) writer — no dependency, runs in the browser.
 *
 * Enough for the conference exports: several sheets, a bold frozen header row, column widths, text /
 * number / money cells, per-row heights and PNG images anchored to a cell (the barcode column). Strings
 * are written as inline strings (`t="inlineStr"`), so a value that starts with `=` is TEXT, never a
 * formula — attendee data comes from a public form and must not execute in the admin's spreadsheet.
 * The ZIP container uses the STORE method (no compression), which every spreadsheet reader accepts.
 */

export type XlsxCell = string | number | null | undefined | { money: number };

export type XlsxImage = {
    /** 0-based row index within `rows` (the header is not counted). */
    row: number;
    /** 0-based column index. */
    col: number;
    png: Uint8Array;
    /** Display size in pixels. */
    width: number;
    height: number;
};

export type XlsxSheet = {
    name: string;
    columns: { header: string; width?: number }[];
    rows: XlsxCell[][];
    images?: XlsxImage[];
    /** Height in points of data rows that carry an image (default: fit the tallest image of the row). */
    imageRowHeight?: number;
    /** Rows (0-based, data rows) to render bold — e.g. group headers in a report. */
    boldRows?: number[];
};

// ── XML helpers ──────────────────────────────────────────────────────────────────────────────────────
// XML 1.0 forbids most control characters; drop them (a pasted form value can carry one).
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const esc = (s: string) => s.replace(INVALID_XML, '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string));

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function colName(i: number): string {
    let n = i + 1, s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
}

/** Excel sheet names: ≤ 31 chars, none of : \ / ? * [ ], unique within the workbook. */
export function safeSheetName(name: string, taken: Set<string>): string {
    let base = String(name || 'Hoja').replace(/[:\\/?*[\]]/g, ' ').replace(/^'+|'+$/g, '').trim() || 'Hoja';
    base = base.slice(0, 31);
    let candidate = base, n = 2;
    while (taken.has(candidate.toLowerCase())) {
        const suffix = ` (${n++})`;
        candidate = base.slice(0, 31 - suffix.length) + suffix;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
}

const STYLE = { normal: 0, header: 1, money: 2, bold: 3, boldMoney: 4 };

function cellXml(ref: string, v: XlsxCell, bold: boolean): string {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'object' && v && 'money' in v) {
        const n = Number(v.money);
        if (!Number.isFinite(n)) return '';
        return `<c r="${ref}" s="${bold ? STYLE.boldMoney : STYLE.money}"><v>${n}</v></c>`;
    }
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return '';
        return `<c r="${ref}"${bold ? ` s="${STYLE.bold}"` : ''}><v>${v}</v></c>`;
    }
    const text = esc(String(v));
    const space = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : '';
    return `<c r="${ref}" t="inlineStr"${bold ? ` s="${STYLE.bold}"` : ''}><is><t${space}>${text}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet, hasDrawing: boolean): string {
    const cols = sheet.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 18}" customWidth="1"/>`).join('');
    const imageRows = new Map<number, number>();
    for (const im of sheet.images || []) imageRows.set(im.row, Math.max(imageRows.get(im.row) || 0, im.height));
    const bold = new Set(sheet.boldRows || []);
    const header = `<row r="1">${sheet.columns.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="${STYLE.header}"><is><t>${esc(c.header)}</t></is></c>`).join('')}</row>`;
    const body = sheet.rows.map((row, ri) => {
        const r = ri + 2;
        const imgH = imageRows.get(ri);
        // pixels → points (×0.75) plus a little air.
        const ht = imgH ? ` ht="${sheet.imageRowHeight ?? Math.ceil(imgH * 0.75) + 6}" customHeight="1"` : '';
        const cells = row.map((v, ci) => cellXml(`${colName(ci)}${r}`, v, bold.has(ri))).join('');
        return `<row r="${r}"${ht}>${cells}</row>`;
    }).join('');
    const lastCol = colName(Math.max(0, sheet.columns.length - 1));
    const dim = `A1:${lastCol}${sheet.rows.length + 1}`;
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + `<dimension ref="${dim}"/>`
        + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        + '<sheetFormatPr defaultRowHeight="15"/>'
        + (cols ? `<cols>${cols}</cols>` : '')
        + `<sheetData>${header}${body}</sheetData>`
        + '<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
        + (hasDrawing ? '<drawing r:id="rId1"/>' : '')
        + '</worksheet>';
}

const EMU = 9525; // EMUs per pixel at 96 dpi

function drawingXml(images: XlsxImage[], firstImageNo: number): string {
    const anchors = images.map((im, i) => {
        const id = i + 1;
        return '<xdr:oneCellAnchor>'
            + `<xdr:from><xdr:col>${im.col}</xdr:col><xdr:colOff>${4 * EMU}</xdr:colOff><xdr:row>${im.row + 1}</xdr:row><xdr:rowOff>${3 * EMU}</xdr:rowOff></xdr:from>`
            + `<xdr:ext cx="${im.width * EMU}" cy="${im.height * EMU}"/>`
            + '<xdr:pic>'
            + `<xdr:nvPicPr><xdr:cNvPr id="${id + 1}" name="Imagen ${firstImageNo + i}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
            + `<xdr:blipFill><a:blip r:embed="rId${id}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
            + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${im.width * EMU}" cy="${im.height * EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>`
            + '</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + anchors + '</xdr:wsDr>';
}

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>'
    + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2563EB"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="5">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>'
    + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf>'
    + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>'
    + '<xf numFmtId="164" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf>'
    + '</cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';

// ── ZIP (STORE) ──────────────────────────────────────────────────────────────────────────────────────
let CRC_TABLE: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
    if (!CRC_TABLE) {
        CRC_TABLE = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            CRC_TABLE[n] = c >>> 0;
        }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const chunks: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const f of files) {
        const name = enc.encode(f.name);
        const crc = crc32(f.data);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
        local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
        local.setUint32(14, crc, true); local.setUint32(18, f.data.length, true); local.setUint32(22, f.data.length, true);
        local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
        chunks.push(new Uint8Array(local.buffer), name, f.data);
        const cd = new DataView(new ArrayBuffer(46));
        cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
        cd.setUint16(10, 0, true); cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
        cd.setUint32(16, crc, true); cd.setUint32(20, f.data.length, true); cd.setUint32(24, f.data.length, true);
        cd.setUint16(28, name.length, true); cd.setUint16(30, 0, true); cd.setUint16(32, 0, true);
        cd.setUint16(34, 0, true); cd.setUint16(36, 0, true); cd.setUint32(38, 0, true); cd.setUint32(42, offset, true);
        central.push(new Uint8Array(cd.buffer), name);
        offset += 30 + name.length + f.data.length;
    }
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
    end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
    const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((a, c) => a + c.length, 0));
    let p = 0;
    for (const c of parts) { out.set(c, p); p += c.length; }
    return out;
}

// ── workbook ─────────────────────────────────────────────────────────────────────────────────────────
export function buildXlsx(sheetsIn: XlsxSheet[]): Uint8Array {
    if (!sheetsIn.length) throw new Error('xlsx: at least one sheet');
    const enc = new TextEncoder();
    const taken = new Set<string>();
    const sheets = sheetsIn.map((s) => ({ ...s, name: safeSheetName(s.name, taken) }));
    const files: { name: string; data: Uint8Array }[] = [];
    const overrides: string[] = [];
    let imageNo = 1;
    let drawingNo = 1;
    sheets.forEach((sheet, i) => {
        const n = i + 1;
        const images = sheet.images || [];
        const hasDrawing = images.length > 0;
        files.push({ name: `xl/worksheets/sheet${n}.xml`, data: enc.encode(sheetXml(sheet, hasDrawing)) });
        overrides.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
        if (hasDrawing) {
            const d = drawingNo++;
            files.push({ name: `xl/worksheets/_rels/sheet${n}.xml.rels`, data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${d}.xml"/></Relationships>`) });
            const rels = images.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${imageNo + k}.png"/>`).join('');
            files.push({ name: `xl/drawings/_rels/drawing${d}.xml.rels`, data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`) });
            files.push({ name: `xl/drawings/drawing${d}.xml`, data: enc.encode(drawingXml(images, imageNo)) });
            overrides.push(`<Override PartName="/xl/drawings/drawing${d}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
            images.forEach((im, k) => files.push({ name: `xl/media/image${imageNo + k}.png`, data: im.png }));
            imageNo += images.length;
        }
    });
    const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<bookViews><workbookView/></bookViews><sheets>'
        + sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
        + '</sheets></workbook>';
    const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
        + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
        + '</Relationships>';
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Default Extension="png" ContentType="image/png"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + overrides.join('')
        + '</Types>';
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    return zipStore([
        { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
        { name: '_rels/.rels', data: enc.encode(rootRels) },
        { name: 'xl/workbook.xml', data: enc.encode(workbook) },
        { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRels) },
        { name: 'xl/styles.xml', data: enc.encode(STYLES_XML) },
        ...files,
    ]);
}

/** Hand the workbook to the browser as a download. */
export function downloadXlsx(bytes: Uint8Array, filename: string): void {
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
