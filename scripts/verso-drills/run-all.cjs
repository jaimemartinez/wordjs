/**
 * VERSO F7 — lanza los cuatro drills de no-pérdida en orden y agrega el veredicto.
 *
 * Sale con 0 solo si los CUATRO salen con 0. Cada drill imprime su propio RESUMEN.
 * Los argumentos extra se pasan tal cual a cada drill (p.ej. --keep-copy).
 *
 * Uso: node scripts/verso-drills/run-all.cjs [--keep-copy]
 */

'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DRILLS = [
    ['1 · ensayo de migración', 'drill1-migration-rehearsal.cjs'],
    ['2 · revisiones cruzadas', 'drill2-cross-revisions.cjs'],
    ['3 · WXR round-trip', 'drill3-wxr-roundtrip.cjs'],
    ['4 · guard inline en carga real', 'drill4-inline-guard-load.cjs'],
];

const extra = process.argv.slice(2);
const results = [];

for (const [label, file] of DRILLS) {
    console.log(`\n\n########## DRILL ${label} ##########\n`);
    const res = spawnSync(process.execPath, [path.join(__dirname, file), ...extra], { stdio: 'inherit' });
    results.push({ label, code: res.status });
}

console.log('\n\n========================================================================');
console.log('VEREDICTO GLOBAL — drills de no-pérdida (F7)');
console.log('========================================================================');
for (const r of results) console.log(`  ${r.code === 0 ? 'OK   ' : 'FALLO'}  drill ${r.label}  (exit ${r.code})`);
const failed = results.filter((r) => r.code !== 0).length;
console.log(`\n  ${failed === 0 ? 'TODOS VERDES' : `${failed}/${results.length} EN ROJO`}`);
process.exit(failed === 0 ? 0 : 1);
