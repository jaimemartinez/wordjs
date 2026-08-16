/**
 * VERSO F7 — utilidades compartidas por los DRILLS DE NO-PÉRDIDA.
 *
 * Reglas de seguridad de datos que TODOS los drills respetan:
 *  - La BD viva (backend/data/wordjs.db) se abre SIEMPRE en modo readonly y solo
 *    para COPIARLA. Ningún drill escribe jamás en ella. (better-sqlite3 con el dev
 *    server vivo checkpointea el WAL en cuanto alguien escribe desde fuera: por eso
 *    la copia se hace con el backup API de SQLite — consistente e incluyendo el WAL —
 *    y todo el trabajo posterior ocurre sobre el fichero copiado en el temporal del SO.)
 *  - Cada drill imprime un bloque RESUMEN con contadores y sale con código != 0 si
 *    algo falla.
 *
 * CommonJS a propósito: los drills 2 y 3 cargan el backend TypeScript con
 * `ts-node/register`, que es un hook de `require` (CJS). Un único formato para los
 * cuatro drills evita dos mundos de módulos en el mismo directorio.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const LIVE_DB = path.join(REPO, 'backend', 'data', 'wordjs.db');
const FRONTEND_NM = path.join(REPO, 'frontend', 'node_modules');
const BACKEND_NM = path.join(REPO, 'backend', 'node_modules');

/** better-sqlite3 vive en backend/node_modules (dep del driver sqlite-native). */
function requireBetterSqlite3() {
    return require(path.join(BACKEND_NM, 'better-sqlite3'));
}

function tmpDir() {
    const d = path.join(os.tmpdir(), 'wordjs-verso-drills');
    fs.mkdirSync(d, { recursive: true });
    // Barrido de restos de ejecuciones abortadas (>24 h). Solo dentro de ESTE directorio.
    const cutoff = Date.now() - 24 * 3600 * 1000;
    try {
        for (const name of fs.readdirSync(d)) {
            const f = path.join(d, name);
            try { if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f); } catch { /* en uso */ }
        }
    } catch { /* best-effort */ }
    return d;
}

/**
 * Copia CONSISTENTE de la instalación real de dev a un fichero temporal.
 *
 * Usa el backup API de SQLite desde una conexión READONLY: incluye el contenido del
 * -wal sin tocar el original (a diferencia de un `copyFile` del .db a secas, que con
 * journal_mode=wal se deja fuera todo lo que aún vive en el WAL). Si el backup falla
 * (fichero bloqueado por el dev server), cae a copiar .db + -wal + -shm juntos.
 *
 * @returns {Promise<{file:string, source:string, bytes:number, method:string}>}
 */
async function copyLiveDb(label, sourceOverride) {
    const source = sourceOverride || LIVE_DB;
    if (!fs.existsSync(source)) throw new Error(`no existe la BD de dev: ${source}`);
    const Database = requireBetterSqlite3();
    const dest = path.join(tmpDir(), `${label}-${process.pid}-${Date.now()}.db`);

    let method = 'sqlite-backup';
    const src = new Database(source, { readonly: true, fileMustExist: true });
    if (typeof src.readonly === 'boolean' && !src.readonly) {
        src.close();
        throw new Error('better-sqlite3 no reconoció el flag readonly — abortando (defensa)');
    }
    try {
        await src.backup(dest);
    } catch (e) {
        method = `copyFile (backup falló: ${e.message})`;
        for (const suffix of ['', '-wal', '-shm']) {
            if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, dest + suffix);
        }
    } finally {
        src.close();
    }
    const bytes = fs.statSync(dest).size;
    return { file: dest, source, bytes, method };
}

/** Borra una copia temporal y sus ficheros satélite. */
function dropCopy(file) {
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(file + suffix); } catch { /* best-effort */ }
    }
}

/** Abre una BD (la COPIA) en solo lectura. */
function openReadonly(file) {
    const Database = requireBetterSqlite3();
    return new Database(file, { readonly: true, fileMustExist: true });
}

/**
 * Todas las filas `_puck_data` de una BD, con los datos del post al que cuelgan.
 * NO deduplica por post: si un post tuviera varias filas con la misma meta_key
 * (el esquema no tiene índice único), las devuelve todas — el ensayo de migración
 * debe pasar por TODAS, no por "la última".
 */
function readPuckRows(db) {
    return db.prepare(`
        SELECT pm.meta_id AS metaId, pm.post_id AS postId, pm.meta_value AS raw,
               p.post_type AS postType, p.post_status AS postStatus,
               p.post_title AS postTitle, p.post_name AS slug, p.post_parent AS postParent
        FROM post_meta pm
        LEFT JOIN posts p ON p.id = pm.post_id
        WHERE pm.meta_key = '_puck_data'
        ORDER BY pm.post_id ASC, pm.meta_id ASC
    `).all();
}

/* ------------------------------------------------------------------ */
/* Kernel Verso (frontend TS) empaquetado para node con esbuild.       */
/* ------------------------------------------------------------------ */

/**
 * Compila `kernel-entry.ts` (re-exporta normalize/commands/inline-engine/sanitize
 * REALES del frontend) a un bundle CJS en el temporal y lo carga.
 *
 * Por qué esbuild y no una reimplementación: el drill debe ejercitar EL MISMO
 * código que corre en el editor. Es el mismo patrón que usan los tests (vitest
 * transpila el TS); aquí no hay runner de tests, así que se transpila a mano.
 */
async function loadKernel() {
    const esbuild = require(path.join(BACKEND_NM, 'esbuild'));
    const outfile = path.join(tmpDir(), `verso-kernel-${process.pid}.cjs`);
    await esbuild.build({
        entryPoints: [path.join(__dirname, 'kernel-entry.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        outfile,
        // htmlparser2/sanitize-html/dompurify se resuelven desde frontend/node_modules.
        nodePaths: [FRONTEND_NM],
        logLevel: 'error',
        legalComments: 'none',
    });
    const mod = require(outfile);
    // El bundle es un artefacto de compilación: se borra al salir (incluido process.exit()).
    process.on('exit', () => { try { fs.unlinkSync(outfile); } catch { /* best-effort */ } });
    return { kernel: mod, bundle: outfile };
}

/* ------------------------------------------------------------------ */
/* Reporte                                                             */
/* ------------------------------------------------------------------ */

class Reporter {
    constructor(title) {
        this.title = title;
        this.counters = new Map();
        this.failures = [];
        this.notes = [];
        this.startedAt = Date.now();
    }
    bump(key, n = 1) {
        this.counters.set(key, (this.counters.get(key) || 0) + n);
        return this.counters.get(key);
    }
    set(key, value) { this.counters.set(key, value); }
    get(key) { return this.counters.get(key) || 0; }
    fail(msg) { this.failures.push(msg); }
    note(msg) { this.notes.push(msg); }
    log(msg) { console.log(msg); }
    /** Imprime el RESUMEN y devuelve el exit code (0 ok, 1 si hay fallos). */
    finish(maxFailuresShown = 25) {
        const ms = Date.now() - this.startedAt;
        console.log('');
        console.log('='.repeat(72));
        console.log(`RESUMEN — ${this.title}`);
        console.log('='.repeat(72));
        const width = Math.max(0, ...[...this.counters.keys()].map((k) => k.length));
        for (const [k, v] of this.counters) console.log(`  ${k.padEnd(width)} : ${v}`);
        if (this.notes.length) {
            console.log('  --- notas ---');
            for (const n of this.notes) console.log(`  · ${n}`);
        }
        console.log(`  ${'tiempo_ms'.padEnd(width)} : ${ms}`);
        if (this.failures.length) {
            console.log(`\n  FALLOS (${this.failures.length}):`);
            for (const f of this.failures.slice(0, maxFailuresShown)) console.log(`   ✗ ${f}`);
            if (this.failures.length > maxFailuresShown) {
                console.log(`   … y ${this.failures.length - maxFailuresShown} más`);
            }
            console.log('\n  VEREDICTO: FALLO');
            return 1;
        }
        console.log('\n  VEREDICTO: OK');
        return 0;
    }
}

/** PRNG determinista (mulberry32) — las secuencias de comandos deben ser reproducibles. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function rng() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Primeras diferencias entre dos strings (para el detalle de un fallo byte-a-byte). */
function firstDiff(a, b, context = 60) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return {
        at: i,
        lenA: a.length,
        lenB: b.length,
        a: JSON.stringify(a.slice(Math.max(0, i - 20), i + context)),
        b: JSON.stringify(b.slice(Math.max(0, i - 20), i + context)),
    };
}

module.exports = {
    REPO, LIVE_DB, FRONTEND_NM, BACKEND_NM,
    requireBetterSqlite3, tmpDir, copyLiveDb, dropCopy, openReadonly, readPuckRows,
    loadKernel, Reporter, mulberry32, firstDiff,
};
