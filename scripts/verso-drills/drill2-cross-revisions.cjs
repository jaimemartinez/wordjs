/**
 * VERSO F7 — DRILL 2: REVISIONES CRUZADAS (legacy → Verso → restaurar).
 *
 * Simula, sobre una COPIA de la instalación real y con el código REAL del backend
 * (models/Post + core/revisions + core/sanitize-meta), el ciclo que más miedo da en
 * una migración de editor:
 *
 *    1. El documento existe en BD tal como lo dejó el editor LEGACY.
 *    2. Se re-guarda por la ruta del editor legacy   → revisión R1  (estado "antes")
 *    3. Se abre y se guarda con VERSO (toNormalized → edición → fromNormalized)
 *                                                    → revisión R2  (estado "después")
 *    4. Se RESTAURA R1.
 *    5. El `_puck_data` del post debe volver BYTE-IGUAL al de R1, y ningún meta
 *       presente en R1 puede desaparecer.
 *
 * El paso 2/3 replica exactamente el orden de escritura de routes/posts.ts (PUT
 * /posts/:id, líneas ~460-479): `Post.updateMeta(id, key, sanitizeMetaValue(key, value))`
 * y DESPUÉS `saveRevision(id)`. No se levanta el servidor HTTP: se ejercita el mismo
 * código de modelo/core, con `config.dbPath` apuntando a la copia — el patrón de los
 * tests del backend (src/tests/wxr-import.test.ts).
 *
 * Uso: node scripts/verso-drills/drill2-cross-revisions.cjs [--docs=12] [--keep-copy]
 */

'use strict';

const path = require('node:path');
const { Reporter, REPO, BACKEND_NM, copyLiveDb, dropCopy, loadKernel, firstDiff } = require('./_common.cjs');

const argv = process.argv.slice(2);
const argNum = (name, def) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? Number(hit.split('=')[1]) : def;
};
const DOCS = argNum('docs', 12);
const KEEP = argv.includes('--keep-copy');

async function main() {
    const rep = new Reporter('DRILL 2 — revisiones cruzadas legacy → Verso → restore');

    /* ---- 1. copia de la BD viva (la viva jamás se abre en escritura) ---- */
    const copy = await copyLiveDb('drill2');
    rep.note(`copia: ${copy.file} (${copy.bytes} bytes, ${copy.method})`);

    /* ---- 2. repuntar config ANTES de cargar la capa de BD ------------- */
    require(path.join(BACKEND_NM, 'ts-node')).register({
        project: path.join(REPO, 'backend', 'tsconfig.json'),
        transpileOnly: true,
        files: false,
    });
    const config = require(path.join(REPO, 'backend', 'src', 'config', 'app'));
    config.dbPath = copy.file;          // absoluto: el driver hace path.resolve sobre cwd
    config.dbDriver = 'sqlite-native';
    const database = require(path.join(REPO, 'backend', 'src', 'config', 'database'));
    await database.init({ driver: 'sqlite-native' });
    const dbAsync = database.getDbAsync();

    const Post = require(path.join(REPO, 'backend', 'src', 'models', 'Post'));
    const { saveRevision, restoreRevision, getRevision } = require(path.join(REPO, 'backend', 'src', 'core', 'revisions'));
    const { sanitizeMetaValue } = require(path.join(REPO, 'backend', 'src', 'core', 'sanitize-meta'));

    /* ---- 3. kernel Verso (frontend real) ------------------------------ */
    const { kernel: K } = await loadKernel();
    const { toNormalized, fromNormalized, applyCommand } = K;

    /* ---- 4. documentos candidatos ------------------------------------ */
    const candidates = await dbAsync.all(`
        SELECT p.id AS id, p.post_type AS type, p.post_status AS status, p.post_title AS title,
               pm.meta_value AS raw
        FROM posts p JOIN post_meta pm ON pm.post_id = p.id AND pm.meta_key = '_puck_data'
        WHERE p.post_type IN ('page','post') AND p.post_status IN ('publish','draft')
        ORDER BY length(pm.meta_value) DESC
    `);
    rep.set('candidatos_page_post_con_puck', candidates.length);

    const chosen = [];
    for (const c of candidates) {
        try {
            const parsed = JSON.parse(c.raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) chosen.push({ ...c, parsed });
        } catch { rep.bump('candidatos_json_invalido_saltados'); }
        if (chosen.length >= DOCS) break;
    }
    rep.set('docs_ciclados', chosen.length);

    /* ---- 4bis. SONDA: colisión de post_name entre revisiones --------- */
    // core/revisions.ts:34 nombra cada revisión `${postId}-revision-v${Date.now()}` y
    // el esquema tiene `CREATE UNIQUE INDEX idx_posts_name_type ON posts (post_name,
    // post_type) WHERE post_name <> ''` (config/database.ts:405). Dos revisiones del
    // MISMO post en el MISMO milisegundo colisionan y el INSERT lanza. Se sondea
    // explícitamente porque es una pérdida silenciosa de punto de recuperación.
    if (chosen.length > 0) {
        const probeId = chosen[0].id;
        let collided = null;
        // (a) natural: dos guardados seguidos. Depende de lo que tarde saveRevision
        //     (se mide abajo), así que puede o no caer en el mismo ms.
        const t0 = Date.now();
        try {
            await saveRevision(probeId);
            await saveRevision(probeId);
        } catch (e) { collided = e; }
        rep.set('ms_por_saveRevision_medido', ((Date.now() - t0) / 2).toFixed(2));
        if (collided) rep.bump('colision_natural_reproducida');
        // (b) determinista: se congela el reloj a un ms fijo — exactamente "dos
        //     revisiones del mismo post en el mismo milisegundo". Sin depender de
        //     la velocidad de la máquina.
        if (!collided) {
            const realNow = Date.now;
            Date.now = () => 1_700_000_000_000;
            try {
                await saveRevision(probeId);
                await saveRevision(probeId);
            } catch (e) { collided = e; }
            finally { Date.now = realNow; }
            if (collided) rep.bump('colision_con_reloj_congelado');
        }
        if (collided) {
            rep.bump('colision_post_name_revisiones');
            rep.fail(
                `BUG PREEXISTENTE (no de Verso): dos saveRevision() del post ${probeId} en el mismo ms ` +
                `violan idx_posts_name_type — "${collided.code || collided.name}: ${collided.message}". ` +
                `core/revisions.ts:34 usa Date.now() (ms) como sufijo de post_name. ` +
                `Efecto: en routes/posts.ts:479 el saveRevision es fire-and-forget → la revisión se PIERDE en silencio; ` +
                `en core/revisions.ts:130 el saveRevision está FUERA del try de restoreRevision → el throw escapa y ` +
                `routes/revisions.ts:185 devuelve 500 sin restaurar nada.`,
            );
        } else {
            rep.bump('sonda_colision_sin_incidencia');
        }
    }

    /** saveRevision esquivando el bug de colisión, para que el ciclo pueda completarse. */
    const saveRevisionSafe = async (postId) => {
        for (let attempt = 0; attempt < 20; attempt++) {
            try {
                return await saveRevision(postId);
            } catch (e) {
                if (!/UNIQUE/i.test(String(e && e.message))) throw e;
                rep.bump('reintentos_por_colision_post_name');
                await new Promise((r) => setTimeout(r, 2));
            }
        }
        throw new Error(`saveRevision(${postId}) no consiguió un post_name libre en 20 intentos`);
    };

    for (const doc of chosen) {
        const id = doc.id;

        /* --- paso 2: guardado por el editor LEGACY (forma tal cual) --- */
        // La ruta real sanea SIEMPRE en la escritura; si el sanitizador no fuese
        // idempotente, cada guardado mutaría el documento. Se mide.
        const legacyValue = sanitizeMetaValue('_puck_data', doc.parsed);
        await Post.updateMeta(id, '_puck_data', legacyValue);
        const S1 = (await dbAsync.get('SELECT meta_value v FROM post_meta WHERE post_id=? AND meta_key=?', [id, '_puck_data'])).v;
        if (S1 !== JSON.stringify(doc.parsed)) {
            rep.bump('legacy_save_MUTA_bytes');
            rep.note(`post ${id}: el saneador de escritura cambia bytes en el guardado legacy — ${JSON.stringify(firstDiff(JSON.stringify(doc.parsed), S1, 40))}`);
        } else {
            rep.bump('legacy_save_byte_estable');
        }
        // ¿CONVERGE? Un saneador no idempotente haría crecer el documento en cada
        // guardado (&amp; → &amp;amp; …) — eso sí sería pérdida/corrupción progresiva.
        const pass2 = JSON.stringify(sanitizeMetaValue('_puck_data', JSON.parse(S1)));
        if (pass2 === S1) rep.bump('saneador_idempotente_desde_2a_pasada');
        else {
            rep.bump('saneador_NO_CONVERGE');
            rep.fail(`post ${id}: sanitizeMetaValue no converge (3ª escritura volvería a cambiar bytes) — ${JSON.stringify(firstDiff(S1, pass2, 40))}`);
        }
        const metaAtR1 = await Post.getAllMeta(id);
        const R1 = await saveRevisionSafe(id);
        if (!R1) { rep.fail(`post ${id}: saveRevision(R1) devolvió null`); continue; }

        /* --- paso 3: abierto y guardado por VERSO --------------------- */
        const loaded = JSON.parse(S1);                 // lo que el editor recibe
        let vdoc = toNormalized(loaded);               // ← kernel Verso real
        // Edición realista: cambiar una prop del primer bloque y añadir uno nuevo.
        const firstKey = vdoc.rootChildren[0];
        if (firstKey) {
            vdoc = applyCommand(vdoc, { kind: 'setProps', nodeId: firstKey, patch: { drillEdited: `verso-${id}` } }).doc;
        }
        vdoc = applyCommand(vdoc, {
            kind: 'insertNode',
            item: { type: 'Text', props: { id: `verso-drill-${id}`, content: '<p>bloque nuevo de Verso</p>' } },
            parentId: K.ROOT_ID, slotKey: K.ROOT_SLOT, index: 0,
        }).doc;
        const versoOut = fromNormalized(vdoc);
        await Post.updateMeta(id, '_puck_data', sanitizeMetaValue('_puck_data', versoOut));
        const S2 = (await dbAsync.get('SELECT meta_value v FROM post_meta WHERE post_id=? AND meta_key=?', [id, '_puck_data'])).v;
        if (S2 === S1) { rep.bump('verso_save_sin_efecto'); rep.fail(`post ${id}: el guardado de Verso no cambió nada — el ciclo no prueba nada`); }
        const R2 = await saveRevisionSafe(id);
        if (!R2) { rep.fail(`post ${id}: saveRevision(R2) devolvió null`); continue; }

        /* --- paso 4: restaurar R1 ------------------------------------ */
        // restoreRevision() empieza por saveRevision() FUERA de su try (core/revisions.ts:130):
        // si cae en el mismo ms que el saveRevision de R2, el UNIQUE de post_name lanza y el
        // 500 sale por routes/revisions.ts:185 SIN restaurar. Se espera 3 ms para poder medir
        // el resto del ciclo; la colisión ya está registrada por la sonda de arriba.
        await new Promise((r) => setTimeout(r, 3));
        let ok = false;
        try {
            ok = await restoreRevision(R1);
        } catch (e) {
            rep.bump('restore_LANZO');
            rep.fail(`post ${id}: restoreRevision(${R1}) LANZÓ (500 en la ruta, sin restaurar) — ${e.code || e.name}: ${e.message}`);
            continue;
        }
        if (!ok) { rep.bump('restore_devolvio_false'); rep.fail(`post ${id}: restoreRevision(${R1}) devolvió false`); continue; }

        /* --- paso 5: verificación ------------------------------------ */
        const restored = (await dbAsync.get('SELECT meta_value v FROM post_meta WHERE post_id=? AND meta_key=?', [id, '_puck_data'])).v;
        if (restored === S1) {
            rep.bump('restaurado_byte_igual_a_R1');
        } else {
            rep.bump('restaurado_DISTINTO_de_R1');
            rep.fail(`post ${id}: el _puck_data restaurado NO es byte-igual al de R1 — ${JSON.stringify(firstDiff(S1, restored))}`);
        }
        if (restored === doc.raw) rep.bump('restaurado_byte_igual_al_original_en_BD');
        else rep.bump('restaurado_distinto_del_original_en_BD_(saneador)');

        // Ningún meta presente en R1 puede desaparecer, y su valor debe volver igual.
        const metaAfter = await Post.getAllMeta(id);
        for (const key of Object.keys(metaAtR1)) {
            if (!(key in metaAfter)) {
                rep.bump('meta_PERDIDO_en_restore');
                rep.fail(`post ${id}: la clave meta "${key}" desapareció tras restaurar`);
                continue;
            }
            const a = JSON.stringify(metaAtR1[key]);
            const b = JSON.stringify(metaAfter[key]);
            if (a !== b) {
                rep.bump('meta_alterado_en_restore');
                rep.fail(`post ${id}: meta "${key}" cambió al restaurar: ${a.slice(0, 80)} → ${b.slice(0, 80)}`);
            }
        }
        rep.bump('ciclos_completados');

        // El documento restaurado debe seguir siendo cargable por Verso y hacer
        // round-trip byte-exacto (si no, la restauración deja al editor en fallback).
        const rtr = JSON.stringify(fromNormalized(toNormalized(JSON.parse(restored))));
        if (rtr !== restored) {
            rep.bump('restaurado_no_roundtrip');
            rep.fail(`post ${id}: el documento restaurado ya no hace round-trip byte-exacto`);
        }

        // Y la revisión R1 debe seguir siendo legible (no la poda limitRevisions).
        const r1 = await getRevision(R1);
        if (!r1) { rep.bump('R1_desaparecida'); rep.note(`post ${id}: R1 ${R1} ya no existe (poda de revisiones)`); }
    }

    try { await database.closeDatabase(); } catch { /* best-effort */ }
    if (!KEEP) dropCopy(copy.file); else rep.note(`copia CONSERVADA en ${copy.file}`);
    process.exit(rep.finish());
}

main().catch((e) => {
    console.error('❌ drill 2 abortó:', e);
    process.exit(2);
});
