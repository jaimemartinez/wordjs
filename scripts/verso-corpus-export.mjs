#!/usr/bin/env node
/**
 * VERSO F2 — exportador de corpus de producción para el gate de round-trip del motor nuevo.
 *
 * Lee las bases SQLite del repo en modo SOLO LECTURA (better-sqlite3 { readonly: true,
 * fileMustExist: true } — el mismo patrón que ya usa backend/src/config/database.ts en
 * checkDbDivergence() para inspeccionar "la otra" DB sin tocarla) y exporta:
 *
 *   documentation/verso/corpus/corpus.json  — posts/pages/revisiones CON meta _puck_data
 *   documentation/verso/corpus/legacy.json  — posts/pages SIN _puck_data pero con content HTML no vacío
 *   documentation/verso/corpus/stats.json   — totales y distribuciones para el gate de round-trip
 *
 * NUNCA escribe en las DBs. NUNCA llama a driver.save()/saveDatabase(). Solo abre conexiones
 * better-sqlite3 propias, en modo readonly, y las cierra.
 *
 * Uso: node scripts/verso-corpus-export.mjs
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'documentation', 'verso', 'corpus');

const DB_TARGETS = [
  { label: 'legacy', file: path.join(REPO_ROOT, 'backend', 'data', 'wordjs.db') },
  { label: 'native', file: path.join(REPO_ROOT, 'backend', 'data', 'wordjs-native.db') },
];

const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Abre una DB SQLite en modo estrictamente solo-lectura, con reintentos si el fichero está
 * bloqueado por un proceso vivo (p.ej. un dev server con el driver nativo abierto en modo rw).
 * Nunca usa fileMustExist:false ni crea el fichero — si no existe, retorna null.
 */
async function openReadonly(filePath, label) {
  // Un solo stat responde AMBAS preguntas (¿existe? ¿está vacío?). El par existsSync+statSync que
  // había aquí era una carrera check→use (js/file-system-race): entre la comprobación y el uso el
  // fichero puede desaparecer, y entonces el statSync reventaba con ENOENT en vez de devolver
  // 'no-existe'. Ahora el error del propio stat ES la respuesta.
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { db: null, reason: 'no-existe' };
    throw e;
  }
  if (size === 0) {
    return { db: null, reason: 'fichero-vacio-0-bytes' };
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const db = new Database(filePath, { readonly: true, fileMustExist: true });
      // Confirmación adicional de que el proceso quedó en solo-lectura real.
      if (typeof db.readonly === 'boolean' && !db.readonly) {
        db.close();
        throw new Error('better-sqlite3 no reconoció el flag readonly (defensa: abortando).');
      }
      return { db, reason: attempt > 1 ? `ok-tras-${attempt}-intentos` : 'ok' };
    } catch (e) {
      lastErr = e;
      const busy = /SQLITE_BUSY|database is locked|EBUSY/i.test(String(e && e.message));
      if (!busy || attempt === RETRY_ATTEMPTS) break;
      console.warn(`   ⚠️  [${label}] intento ${attempt}/${RETRY_ATTEMPTS} bloqueado (${e.message}) — reintentando en ${RETRY_DELAY_MS}ms...`);
      await sleep(RETRY_DELAY_MS);
    }
  }
  return { db: null, reason: `error: ${lastErr ? lastErr.message : 'desconocido'}` };
}

/** Heurística: ¿este array "parece" un slot (Content[]) de @wordjs/puck? */
function looksLikeContentArray(arr) {
  return (
    Array.isArray(arr) &&
    arr.length > 0 &&
    arr.every(
      (el) => el && typeof el === 'object' && !Array.isArray(el) && typeof el.type === 'string' && el.props && typeof el.props === 'object'
    )
  );
}

function hasNonEmptyObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;
}

function walkItem(item, depth, ctx) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return;
  if (typeof item.type !== 'string') return; // no es un ComponentData reconocible

  ctx.maxDepth = Math.max(ctx.maxDepth, depth);
  ctx.blockCount += 1;
  ctx.blockTypes.add(item.type);

  const props = item.props && typeof item.props === 'object' ? item.props : {};
  if (hasNonEmptyObject(props.look)) ctx.withLook += 1;
  if (hasNonEmptyObject(props.anim) && props.anim.type) ctx.withAnim += 1;
  if (hasNonEmptyObject(props.hide)) ctx.withHide += 1;
  if (typeof props.css === 'object' && props.css && Object.keys(props.css).length > 0) ctx.withCustomCss += 1;

  for (const [key, value] of Object.entries(props)) {
    if (key === 'look' || key === 'anim' || key === 'hide' || key === 'css') continue;
    if (looksLikeContentArray(value)) {
      ctx.hasSlots = true;
      ctx.slotArrayCount += 1;
      for (const child of value) walkItem(child, depth + 1, ctx);
    }
  }
}

/**
 * Analiza un objeto Data de @wordjs/puck ({content, root, zones?}) y devuelve las métricas
 * que pide el encargo: hasZones, blockTypes, depth, blockCount, más extras para stats.json.
 */
function analyzePuckData(data) {
  const ctx = {
    blockTypes: new Set(),
    blockCount: 0,
    maxDepth: 0,
    withLook: 0,
    withAnim: 0,
    withHide: 0,
    withCustomCss: 0,
    hasSlots: false,
    slotArrayCount: 0,
  };

  const content = Array.isArray(data.content) ? data.content : [];
  for (const item of content) walkItem(item, 1, ctx);

  const zones = data.zones && typeof data.zones === 'object' && !Array.isArray(data.zones) ? data.zones : null;
  const hasZones = !!zones && Object.keys(zones).length > 0;
  let zoneItemCount = 0;
  if (hasZones) {
    for (const zoneItems of Object.values(zones)) {
      if (Array.isArray(zoneItems)) {
        zoneItemCount += zoneItems.length;
        for (const item of zoneItems) walkItem(item, 1, ctx);
      }
    }
  }

  return {
    hasZones,
    zoneCount: hasZones ? Object.keys(zones).length : 0,
    zoneItemCount,
    hasSlots: ctx.hasSlots,
    slotArrayCount: ctx.slotArrayCount,
    blockTypes: Array.from(ctx.blockTypes).sort(),
    blockCount: ctx.blockCount,
    depth: ctx.maxDepth,
    withLook: ctx.withLook,
    withAnim: ctx.withAnim,
    withHide: ctx.withHide,
    withCustomCss: ctx.withCustomCss,
  };
}

const POSTS_QUERY = `
  SELECT
    p.id            AS id,
    p.post_type     AS post_type,
    p.post_status   AS post_status,
    p.post_title    AS post_title,
    p.post_name     AS post_name,
    p.post_content  AS post_content,
    (
      SELECT pm.meta_value
      FROM post_meta pm
      WHERE pm.post_id = p.id AND pm.meta_key = '_puck_data'
      ORDER BY pm.meta_id DESC
      LIMIT 1
    ) AS puck_json
  FROM posts p
`;

function processDb(db, label) {
  const rows = db.prepare(POSTS_QUERY).all();

  const corpusEntries = [];
  const legacyEntries = [];
  const parseErrors = [];
  let emptyCount = 0;

  for (const row of rows) {
    const puckJson = row.puck_json;
    if (puckJson !== null && puckJson !== undefined && String(puckJson).trim() !== '') {
      let parsed;
      try {
        parsed = JSON.parse(puckJson);
      } catch (e) {
        parseErrors.push({ db: label, id: row.id, type: row.post_type, status: row.post_status, error: String(e && e.message), rawLen: String(puckJson).length });
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        parseErrors.push({ db: label, id: row.id, type: row.post_type, status: row.post_status, error: 'JSON parseado pero no es un objeto Data {content,root,...}', rawLen: String(puckJson).length });
        continue;
      }
      const analysis = analyzePuckData(parsed);
      corpusEntries.push({
        db: label,
        id: row.id,
        type: row.post_type,
        status: row.post_status,
        title: row.post_title,
        slug: row.post_name,
        // El documento serializado. Se llama `versoData` desde el renombrado del editor; los
        // corpus ya exportados con la clave anterior (`puckData`) los sigue leyendo el loader de
        // los tests (frontend/src/lib/verso/__tests__/helpers.ts), que normaliza las dos.
        versoData: parsed,
        hasZones: analysis.hasZones,
        zoneCount: analysis.zoneCount,
        zoneItemCount: analysis.zoneItemCount,
        hasSlots: analysis.hasSlots,
        slotArrayCount: analysis.slotArrayCount,
        blockTypes: analysis.blockTypes,
        blockCount: analysis.blockCount,
        depth: analysis.depth,
        withLook: analysis.withLook,
        withAnim: analysis.withAnim,
        withHide: analysis.withHide,
        withCustomCss: analysis.withCustomCss,
        byteSize: Buffer.byteLength(puckJson, 'utf8'),
      });
    } else {
      const content = row.post_content || '';
      const len = content.trim().length;
      if (len > 0) {
        legacyEntries.push({ db: label, id: row.id, type: row.post_type, status: row.post_status, title: row.post_title, slug: row.post_name, len });
      } else {
        emptyCount += 1;
      }
    }
  }

  return { rowCount: rows.length, corpusEntries, legacyEntries, parseErrors, emptyCount };
}

function buildStats(allCorpus, allLegacy, allParseErrors, perDbMeta) {
  const stats = {
    generatedAt: new Date().toISOString(),
    dbs: perDbMeta,
    totals: {
      postsScanned: perDbMeta.reduce((s, d) => s + (d.rowCount || 0), 0),
      withPuckData: allCorpus.length,
      legacyHtmlOnly: allLegacy.length,
      empty: perDbMeta.reduce((s, d) => s + (d.emptyCount || 0), 0),
      parseErrors: allParseErrors.length,
    },
    byPostType: {},
    byPostStatus: {},
    blockTypeDistribution: {}, // type -> nº de OCURRENCIAS (no de documentos)
    blockTypeDocCount: {}, // type -> nº de DOCUMENTOS distintos que lo usan
    zonesVsSlots: {
      docsWithZonesOnly: 0,
      docsWithSlotsOnly: 0,
      docsWithBoth: 0,
      docsWithNeither: 0,
    },
    sharedFields: {
      docsWithLook: 0,
      docsWithAnim: 0,
      docsWithHide: 0,
      docsWithCustomCss: 0,
    },
    depth: { max: 0, maxDocId: null, maxDocDb: null, histogram: {} },
    blockCount: { max: 0, maxDocId: null, maxDocDb: null, avg: 0 },
    byteSize: { max: 0, maxDocId: null, maxDocDb: null, totalBytes: 0, avgBytes: 0 },
    legacyHtml: { maxLen: 0, maxDocId: null, maxDocDb: null, totalLen: 0, avgLen: 0 },
    parseErrorSamples: allParseErrors.slice(0, 20),
  };

  for (const e of allCorpus) {
    stats.byPostType[e.type] = (stats.byPostType[e.type] || 0) + 1;
    stats.byPostStatus[e.status] = (stats.byPostStatus[e.status] || 0) + 1;

    for (const bt of e.blockTypes) {
      stats.blockTypeDocCount[bt] = (stats.blockTypeDocCount[bt] || 0) + 1;
    }
    // ocurrencias reales: recorremos de nuevo el árbol contando por tipo (blockTypes es un Set único por doc)
    const occCtx = { blockTypes: new Map() };
    const countOcc = (items) => {
      for (const it of items || []) {
        if (!it || typeof it !== 'object' || typeof it.type !== 'string') continue;
        occCtx.blockTypes.set(it.type, (occCtx.blockTypes.get(it.type) || 0) + 1);
        const props = it.props || {};
        for (const [k, v] of Object.entries(props)) {
          if (k === 'look' || k === 'anim' || k === 'hide' || k === 'css') continue;
          if (looksLikeContentArray(v)) countOcc(v);
        }
      }
    };
    countOcc(Array.isArray(e.versoData.content) ? e.versoData.content : []);
    if (e.versoData.zones && typeof e.versoData.zones === 'object') {
      for (const zi of Object.values(e.versoData.zones)) {
        if (Array.isArray(zi)) countOcc(zi);
      }
    }
    for (const [bt, n] of occCtx.blockTypes) {
      stats.blockTypeDistribution[bt] = (stats.blockTypeDistribution[bt] || 0) + n;
    }

    if (e.hasZones && e.hasSlots) stats.zonesVsSlots.docsWithBoth += 1;
    else if (e.hasZones) stats.zonesVsSlots.docsWithZonesOnly += 1;
    else if (e.hasSlots) stats.zonesVsSlots.docsWithSlotsOnly += 1;
    else stats.zonesVsSlots.docsWithNeither += 1;

    if (e.withLook > 0) stats.sharedFields.docsWithLook += 1;
    if (e.withAnim > 0) stats.sharedFields.docsWithAnim += 1;
    if (e.withHide > 0) stats.sharedFields.docsWithHide += 1;
    if (e.withCustomCss > 0) stats.sharedFields.docsWithCustomCss += 1;

    stats.depth.histogram[e.depth] = (stats.depth.histogram[e.depth] || 0) + 1;
    if (e.depth > stats.depth.max) {
      stats.depth.max = e.depth;
      stats.depth.maxDocId = e.id;
      stats.depth.maxDocDb = e.db;
    }
    if (e.blockCount > stats.blockCount.max) {
      stats.blockCount.max = e.blockCount;
      stats.blockCount.maxDocId = e.id;
      stats.blockCount.maxDocDb = e.db;
    }
    if (e.byteSize > stats.byteSize.max) {
      stats.byteSize.max = e.byteSize;
      stats.byteSize.maxDocId = e.id;
      stats.byteSize.maxDocDb = e.db;
    }
    stats.byteSize.totalBytes += e.byteSize;
  }

  stats.blockCount.avg = allCorpus.length ? +(allCorpus.reduce((s, e) => s + e.blockCount, 0) / allCorpus.length).toFixed(2) : 0;
  stats.byteSize.avgBytes = allCorpus.length ? Math.round(stats.byteSize.totalBytes / allCorpus.length) : 0;

  for (const e of allLegacy) {
    stats.legacyHtml.totalLen += e.len;
    if (e.len > stats.legacyHtml.maxLen) {
      stats.legacyHtml.maxLen = e.len;
      stats.legacyHtml.maxDocId = e.id;
      stats.legacyHtml.maxDocDb = e.db;
    }
  }
  stats.legacyHtml.avgLen = allLegacy.length ? Math.round(stats.legacyHtml.totalLen / allLegacy.length) : 0;

  return stats;
}

async function main() {
  console.log('=== VERSO F2 — exportador de corpus (SOLO LECTURA) ===');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const allCorpus = [];
  const allLegacy = [];
  const allParseErrors = [];
  const perDbMeta = [];

  for (const target of DB_TARGETS) {
    console.log(`\n-- DB '${target.label}': ${target.file}`);
    const { db, reason } = await openReadonly(target.file, target.label);
    if (!db) {
      console.log(`   omitida (${reason})`);
      perDbMeta.push({ label: target.label, file: target.file, opened: false, reason, rowCount: 0, emptyCount: 0 });
      continue;
    }
    console.log(`   abierta en modo readonly (${reason})`);
    try {
      const hasPostsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'").get();
      if (!hasPostsTable) {
        console.log('   sin tabla posts — DB vacía/no inicializada, omitida.');
        perDbMeta.push({ label: target.label, file: target.file, opened: true, reason: 'sin-tabla-posts', rowCount: 0, emptyCount: 0 });
        continue;
      }
      const result = processDb(db, target.label);
      console.log(`   posts escaneados: ${result.rowCount} | con _puck_data: ${result.corpusEntries.length} | legacy HTML: ${result.legacyEntries.length} | vacíos: ${result.emptyCount} | errores de parseo: ${result.parseErrors.length}`);
      allCorpus.push(...result.corpusEntries);
      allLegacy.push(...result.legacyEntries);
      allParseErrors.push(...result.parseErrors);
      perDbMeta.push({
        label: target.label,
        file: target.file,
        opened: true,
        reason,
        rowCount: result.rowCount,
        withPuckData: result.corpusEntries.length,
        legacyHtml: result.legacyEntries.length,
        emptyCount: result.emptyCount,
        parseErrors: result.parseErrors.length,
      });
    } finally {
      db.close();
    }
  }

  const stats = buildStats(allCorpus, allLegacy, allParseErrors, perDbMeta);

  const corpusOut = { generatedAt: stats.generatedAt, count: allCorpus.length, entries: allCorpus };
  const legacyOut = { generatedAt: stats.generatedAt, count: allLegacy.length, entries: allLegacy };

  fs.writeFileSync(path.join(OUT_DIR, 'corpus.json'), JSON.stringify(corpusOut, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'legacy.json'), JSON.stringify(legacyOut, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'stats.json'), JSON.stringify(stats, null, 2), 'utf8');

  console.log('\n=== RESUMEN ===');
  console.log(JSON.stringify(stats.totals, null, 2));
  console.log(`\nEscrito en: ${OUT_DIR}`);
  console.log('corpus.json, legacy.json, stats.json');
}

main().catch((e) => {
  console.error('❌ Fallo del exportador:', e);
  process.exitCode = 1;
});
