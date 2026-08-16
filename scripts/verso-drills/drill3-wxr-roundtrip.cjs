/**
 * VERSO F7 — DRILL 3: WXR ROUND-TRIP (exportar → reimportar en BD limpia).
 *
 * Dos patas, ambas con el CÓDIGO REAL del backend:
 *
 *   PATA A — el exportador REAL (core/import-export.ts `exportToWXR`, la que sirve
 *            GET /api/v1/export/wxr) sobre una copia de la instalación de dev, y el
 *            importador REAL (core/wxr-import.ts `importWxr`, con `sanitizeImportedMeta`)
 *            sobre una BD LIMPIA. Mide cuántos `_puck_data` sobreviven.
 *
 *   PATA B — un WXR construido con `<wp:postmeta>` por cada documento (lo que emite
 *            un WordPress real y lo que el importador SÍ sabe leer), importado en otra
 *            BD limpia. Mide byte-igualdad del `_puck_data` y supervivencia de CADA
 *            tipo de bloque (incluidos los de plugin y los Symbol).
 *
 * Cada fase corre en su PROPIO proceso: el driver SQLite fija `dbPath` en su
 * constructor (drivers/sqlite-native-async.ts:25), así que una misma ejecución no
 * puede hablar con dos bases distintas.
 *
 * Uso: node scripts/verso-drills/drill3-wxr-roundtrip.cjs [--docs=25] [--keep-copy]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
    Reporter, REPO, BACKEND_NM, copyLiveDb, dropCopy, openReadonly, tmpDir, firstDiff,
} = require('./_common.cjs');

const argv = process.argv.slice(2);
const argOf = (name, def) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : def;
};
const PHASE = argOf('phase', null);
const DOCS = Number(argOf('docs', 25));
const KEEP = argv.includes('--keep-copy');

/* ------------------------------------------------------------------ */
/* Arranque del backend con la BD indicada (solo dentro de una fase)   */
/* ------------------------------------------------------------------ */

async function bootBackend(dbFile) {
    require(path.join(BACKEND_NM, 'ts-node')).register({
        project: path.join(REPO, 'backend', 'tsconfig.json'),
        transpileOnly: true,
        files: false,
    });
    const config = require(path.join(REPO, 'backend', 'src', 'config', 'app'));
    config.dbPath = dbFile;
    config.dbDriver = 'sqlite-native';
    const database = require(path.join(REPO, 'backend', 'src', 'config', 'database'));
    await database.init({ driver: 'sqlite-native' });
    return { database, config, dbAsync: database.getDbAsync() };
}

/* ------------------------------------------------------------------ */
/* FASE export                                                         */
/* ------------------------------------------------------------------ */

async function phaseExport() {
    const dbFile = argOf('db');
    const out = argOf('out');
    const report = argOf('report');
    const { database, dbAsync } = await bootBackend(dbFile);
    const { exportToWXR, exportSite } = require(path.join(REPO, 'backend', 'src', 'core', 'import-export'));
    const xml = await exportToWXR();
    fs.writeFileSync(out, xml, 'utf8');

    // Contraste: qué ve el exportador vs qué hay realmente en la BD. `exportSite()`
    // consulta con `status: 'any'`, que Post.buildWhere (models/Post.ts:507) traduce a
    // `post_status = 'any'` — una cadena literal que no casa con NINGUNA fila.
    const Post = require(path.join(REPO, 'backend', 'src', 'models', 'Post'));
    const site = await exportSite();
    const control = {
        postsPublish: (await Post.findAll({ type: 'post', status: 'publish', limit: 10000 })).length,
        pagesPublish: (await Post.findAll({ type: 'page', status: 'publish', limit: 10000 })).length,
        postsAny: (await Post.findAll({ type: 'post', status: 'any', limit: 10000 })).length,
        filasPost: (await dbAsync.get(`SELECT COUNT(*) c FROM posts WHERE post_type='post'`)).c,
        filasPage: (await dbAsync.get(`SELECT COUNT(*) c FROM posts WHERE post_type='page'`)).c,
    };

    const r = {
        exportSitePosts: (site.content.posts || []).length,
        exportSitePages: (site.content.pages || []).length,
        control,
        bytes: Buffer.byteLength(xml, 'utf8'),
        items: (xml.match(/<item>/g) || []).length,
        postmetaBlocks: (xml.match(/<wp:postmeta>/g) || []).length,
        puckMentions: (xml.match(/_puck_data/g) || []).length,
        postTypes: [...new Set((xml.match(/<wp:post_type>[^<]*<\/wp:post_type>/g) || []))],
    };
    fs.writeFileSync(report, JSON.stringify(r), 'utf8');
    try { await database.closeDatabase(); } catch { /* best-effort */ }
}

/* ------------------------------------------------------------------ */
/* FASE import (BD limpia)                                             */
/* ------------------------------------------------------------------ */

async function phaseImport() {
    const dbFile = argOf('db');
    const xmlFile = argOf('xml');
    const report = argOf('report');
    const expectFile = argOf('expect', null);

    const { database, dbAsync } = await bootBackend(dbFile);
    await database.initializeDatabase();
    await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        ['admin', 'x', 'admin@drill.local', 'Administrator'],
    );
    const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);

    const { importWxr } = require(path.join(REPO, 'backend', 'src', 'core', 'wxr-import'));
    const xml = fs.readFileSync(xmlFile, 'utf8');
    const summary = await importWxr(xml, { defaultAuthorId: admin.id, importComments: true });

    const rows = await dbAsync.all(`
        SELECT p.post_name AS slug, p.post_type AS type, pm.meta_value AS raw
        FROM posts p JOIN post_meta pm ON pm.post_id = p.id AND pm.meta_key = '_puck_data'
    `);
    const importedBySlug = {};
    for (const r of rows) importedBySlug[`${r.type}:${r.slug}`] = r.raw;

    const r = {
        summary: { posts: summary.posts, pages: summary.pages, errors: summary.errors.slice(0, 10) },
        postsInDb: (await dbAsync.get(`SELECT COUNT(*) c FROM posts`)).c,
        puckRows: rows.length,
        imported: importedBySlug,
    };

    if (expectFile) {
        const expected = JSON.parse(fs.readFileSync(expectFile, 'utf8'));
        const { sanitizeMetaValue } = require(path.join(REPO, 'backend', 'src', 'core', 'sanitize-meta'));
        r.compare = { found: 0, missing: [], byteEqualRaw: 0, byteEqualAfterSanitizer: 0, diffs: [], blockLoss: [] };
        for (const e of expected) {
            const key = `${e.type}:${e.slug}`;
            const got = importedBySlug[key];
            if (got === undefined) { r.compare.missing.push(key); continue; }
            r.compare.found++;
            if (got === e.raw) r.compare.byteEqualRaw++;
            const afterSanitizer = JSON.stringify(sanitizeMetaValue('_puck_data', JSON.parse(e.raw)));
            if (got === afterSanitizer) r.compare.byteEqualAfterSanitizer++;
            else if (r.compare.diffs.length < 5) r.compare.diffs.push({ key, diff: firstDiff(afterSanitizer, got, 50) });
            // Supervivencia de tipos de bloque (plugin / Symbol incluidos).
            const before = blockTypeCount(JSON.parse(e.raw));
            const after = blockTypeCount(JSON.parse(got));
            for (const [t, n] of Object.entries(before)) {
                if ((after[t] || 0) !== n) r.compare.blockLoss.push({ key, type: t, before: n, after: after[t] || 0 });
            }
        }
    }

    fs.writeFileSync(report, JSON.stringify(r), 'utf8');
    try { await database.closeDatabase(); } catch { /* best-effort */ }
}

/** Multiset tipo→ocurrencias de un Data persistido (slots anidados y zonas incluidos). */
function blockTypeCount(data) {
    const out = {};
    const walk = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const it of arr) {
            if (!it || typeof it !== 'object' || typeof it.type !== 'string' || !it.props) continue;
            out[it.type] = (out[it.type] || 0) + 1;
            for (const v of Object.values(it.props)) if (Array.isArray(v)) walk(v);
        }
    };
    walk(data && data.content);
    if (data && data.zones && typeof data.zones === 'object' && !Array.isArray(data.zones)) {
        for (const z of Object.values(data.zones)) walk(z);
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Constructor del WXR sintético (pata B)                              */
/* ------------------------------------------------------------------ */

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** CDATA seguro: `]]>` dentro del payload se parte, como hace WordPress. */
const cdata = (s) => `<![CDATA[${String(s).split(']]>').join(']]]]><![CDATA[>')}]]>`;

function buildSyntheticWxr(docs) {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>WordJS drill corpus</title>
  <link>http://localhost:3000</link>
  <description>corpus real re-empaquetado con wp:postmeta</description>
  <wp:wxr_version>1.2</wp:wxr_version>
  <wp:base_site_url>http://localhost:3000</wp:base_site_url>
  <wp:base_blog_url>http://localhost:3000</wp:base_blog_url>
  <wp:author><wp:author_login>${cdata('admin')}</wp:author_login><wp:author_email>${cdata('admin@drill.local')}</wp:author_email><wp:author_display_name>${cdata('Administrator')}</wp:author_display_name></wp:author>
`;
    for (const d of docs) {
        xml += `
  <item>
    <title>${xmlEscape(d.title || d.slug)}</title>
    <dc:creator>${cdata('admin')}</dc:creator>
    <content:encoded>${cdata(d.content || '')}</content:encoded>
    <excerpt:encoded>${cdata('')}</excerpt:encoded>
    <wp:post_id>${d.id}</wp:post_id>
    <wp:post_date>2026-01-01 00:00:00</wp:post_date>
    <wp:post_name>${xmlEscape(d.slug)}</wp:post_name>
    <wp:status>publish</wp:status>
    <wp:post_type>${xmlEscape(d.type)}</wp:post_type>
    <wp:postmeta>
      <wp:meta_key>${cdata('_puck_data')}</wp:meta_key>
      <wp:meta_value>${cdata(d.raw)}</wp:meta_value>
    </wp:postmeta>
  </item>`;
    }
    xml += `
</channel>
</rss>`;
    return xml;
}

/* ------------------------------------------------------------------ */
/* Orquestador                                                         */
/* ------------------------------------------------------------------ */

function runPhase(args) {
    const res = spawnSync(process.execPath, [__filename, ...args], { encoding: 'utf8' });
    if (res.status !== 0) {
        throw new Error(`fase ${args.join(' ')} falló (exit ${res.status})\n${res.stdout}\n${res.stderr}`);
    }
    return res;
}

async function main() {
    const rep = new Reporter('DRILL 3 — WXR round-trip (export real + import real)');
    const T = tmpDir();
    const stamp = `${process.pid}-${Date.now()}`;

    const copy = await copyLiveDb('drill3');
    rep.note(`copia: ${copy.file} (${copy.bytes} bytes, ${copy.method})`);

    /* --- documentos del corpus (lectura directa de la copia) -------- */
    const db = openReadonly(copy.file);
    let docs;
    try {
        docs = db.prepare(`
            SELECT p.id AS id, p.post_type AS type, p.post_name AS slug, p.post_title AS title,
                   p.post_content AS content, pm.meta_value AS raw
            FROM posts p JOIN post_meta pm ON pm.post_id = p.id AND pm.meta_key = '_puck_data'
            WHERE p.post_type IN ('page','post') AND p.post_name <> ''
            ORDER BY length(pm.meta_value) DESC
        `).all();
    } finally { db.close(); }

    const usable = [];
    const seen = new Set();
    for (const d of docs) {
        if (seen.has(`${d.type}:${d.slug}`)) continue;      // el importador dedupe por slug+tipo
        try { JSON.parse(d.raw); } catch { continue; }
        seen.add(`${d.type}:${d.slug}`);
        usable.push(d);
        if (usable.length >= DOCS) break;
    }
    rep.set('docs_del_corpus_usados', usable.length);
    const allTypes = new Set();
    for (const d of usable) for (const t of Object.keys(blockTypeCount(JSON.parse(d.raw)))) allTypes.add(t);
    rep.set('tipos_de_bloque_distintos', allTypes.size);
    rep.note(`tipos: ${[...allTypes].sort().join(', ')}`);

    /* ---------------- PATA A: exportador REAL ----------------------- */
    const realXml = path.join(T, `wxr-real-${stamp}.xml`);
    const expReport = path.join(T, `rep-export-${stamp}.json`);
    runPhase([`--phase=export`, `--db=${copy.file}`, `--out=${realXml}`, `--report=${expReport}`]);
    const exp = JSON.parse(fs.readFileSync(expReport, 'utf8'));
    rep.set('A_export_bytes', exp.bytes);
    rep.set('A_export_items', exp.items);
    rep.set('A_export_bloques_wp_postmeta', exp.postmetaBlocks);
    rep.set('A_export_menciones__puck_data', exp.puckMentions);
    rep.set('A_exportSite_posts', exp.exportSitePosts);
    rep.set('A_exportSite_pages', exp.exportSitePages);
    rep.note(`A: post_type emitidos = ${exp.postTypes.join(' ') || '(ninguno)'}`);
    rep.note(`A: control en la misma BD → findAll(status:'publish') posts=${exp.control.postsPublish} pages=${exp.control.pagesPublish} · findAll(status:'any') posts=${exp.control.postsAny} · filas reales post=${exp.control.filasPost} page=${exp.control.filasPage}`);
    if (exp.exportSitePosts === 0 && exp.control.filasPost > 0) {
        rep.fail(
            `PATA A: \`exportSite()\` (core/import-export.ts:43) consulta con \`status: 'any'\`, que ` +
            `Post.buildWhere (models/Post.ts:507) convierte en \`post_status = 'any'\` — literal que no casa ` +
            `con ninguna fila. Resultado: el export de sitio (JSON y WXR) sale VACÍO aunque la BD tenga ` +
            `${exp.control.filasPost} entradas y ${exp.control.filasPage} páginas (con status 'publish' el mismo ` +
            `findAll devuelve ${exp.control.postsPublish} y ${exp.control.pagesPublish}).`,
        );
    }

    const cleanA = path.join(T, `clean-A-${stamp}.db`);
    const impAReport = path.join(T, `rep-impA-${stamp}.json`);
    runPhase([`--phase=import`, `--db=${cleanA}`, `--xml=${realXml}`, `--report=${impAReport}`]);
    const impA = JSON.parse(fs.readFileSync(impAReport, 'utf8'));
    rep.set('A_import_posts_creados', impA.summary.posts.created);
    rep.set('A_import_pages_creadas', impA.summary.pages.created);
    rep.set('A_import__puck_data_recuperados', impA.puckRows);
    if (exp.postmetaBlocks === 0) {
        rep.fail(
            'PATA A: `exportToWXR()` (core/import-export.ts:577, ruta GET /export/wxr) NO emite un solo ' +
            '<wp:postmeta>: el `_puck_data` de TODAS las páginas se pierde en el export. Además el bucle ' +
            'solo recorre data.content.posts y fuerza <wp:post_type>post</wp:post_type>, así que las PÁGINAS ' +
            'ni siquiera salen como items. El importador (que sí sabe leer wp:postmeta) no puede recuperar ' +
            'lo que el exportador nunca escribió.',
        );
    }
    if (impA.puckRows === 0) rep.bump('A_perdida_total_de_puck_data');

    /* ---------------- PATA B: WXR con wp:postmeta ------------------- */
    const synthXml = path.join(T, `wxr-synth-${stamp}.xml`);
    const expectFile = path.join(T, `expect-${stamp}.json`);
    fs.writeFileSync(synthXml, buildSyntheticWxr(usable), 'utf8');
    fs.writeFileSync(expectFile, JSON.stringify(usable.map((d) => ({ slug: d.slug, type: d.type, raw: d.raw }))), 'utf8');
    rep.set('B_wxr_bytes', fs.statSync(synthXml).size);

    const cleanB = path.join(T, `clean-B-${stamp}.db`);
    const impBReport = path.join(T, `rep-impB-${stamp}.json`);
    runPhase([`--phase=import`, `--db=${cleanB}`, `--xml=${synthXml}`, `--report=${impBReport}`, `--expect=${expectFile}`]);
    const impB = JSON.parse(fs.readFileSync(impBReport, 'utf8'));
    rep.set('B_import_posts_creados', impB.summary.posts.created);
    rep.set('B_import_pages_creadas', impB.summary.pages.created);
    rep.set('B__puck_data_reimportados', impB.compare.found);
    rep.set('B_byte_igual_al_original', impB.compare.byteEqualRaw);
    rep.set('B_byte_igual_tras_saneador_de_import', impB.compare.byteEqualAfterSanitizer);
    rep.set('B_documentos_no_encontrados', impB.compare.missing.length);
    rep.set('B_perdidas_de_bloques', impB.compare.blockLoss.length);

    if (impB.compare.found !== usable.length) {
        rep.fail(`PATA B: solo ${impB.compare.found}/${usable.length} documentos reaparecen con _puck_data. Ausentes: ${impB.compare.missing.slice(0, 10).join(', ')}`);
    }
    if (impB.compare.byteEqualAfterSanitizer !== impB.compare.found) {
        rep.fail(`PATA B: ${impB.compare.found - impB.compare.byteEqualAfterSanitizer} documentos NO coinciden byte a byte con el resultado esperado del saneador de importación. Muestras: ${JSON.stringify(impB.compare.diffs)}`);
    }
    for (const bl of impB.compare.blockLoss.slice(0, 20)) {
        rep.fail(`PATA B: bloque perdido/duplicado en ${bl.key}: tipo "${bl.type}" ${bl.before} → ${bl.after}`);
    }
    if (impB.compare.byteEqualRaw !== impB.compare.found) {
        rep.note(`B: ${impB.compare.found - impB.compare.byteEqualRaw} docs difieren del ORIGINAL por el saneador de escritura (mismo efecto medido en el drill 2), no por el transporte WXR.`);
    }
    if (impB.summary.errors.length) rep.note(`B: errores del importador: ${JSON.stringify(impB.summary.errors)}`);

    if (!KEEP) {
        dropCopy(copy.file); dropCopy(cleanA); dropCopy(cleanB);
        for (const f of [realXml, synthXml, expectFile, expReport, impAReport, impBReport]) {
            try { fs.unlinkSync(f); } catch { /* best-effort */ }
        }
    } else {
        rep.note(`artefactos conservados en ${T}`);
    }
    process.exit(rep.finish());
}

if (PHASE === 'export') {
    phaseExport().catch((e) => { console.error(e); process.exit(3); });
} else if (PHASE === 'import') {
    phaseImport().catch((e) => { console.error(e); process.exit(3); });
} else {
    main().catch((e) => { console.error('❌ drill 3 abortó:', e); process.exit(2); });
}
