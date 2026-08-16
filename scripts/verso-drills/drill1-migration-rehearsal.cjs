/**
 * VERSO F7 — DRILL 1: ENSAYO DE MIGRACIÓN sobre una COPIA de la instalación real.
 *
 * Qué demuestra (o refuta):
 *   (A) Round-trip byte-exacto: TODAS las filas `_puck_data` de la BD real pasan por
 *       toNormalized→fromNormalized y vuelven a serializar EXACTAMENTE igual
 *       (JSON.stringify byte-a-byte, no deep-equal: el orden de claves también es
 *       contrato — un reordenamiento ensucia los diffs de revisiones).
 *       Excepción declarada del contrato: un documento con `zones` legacy vivas se
 *       normaliza a slots (única diferencia permitida); ahí se exige PUNTO FIJO
 *       (2ª pasada idéntica) y CERO pérdida de bloques.
 *   (B) Ensayo de EDICIÓN: sobre N documentos reales se aplica una secuencia de
 *       comandos (insert/move/setProps/setRootProps/duplicate/remove) y después se
 *       deshace entera con los inversos; la serialización final debe ser byte-igual
 *       a la de partida.
 *
 * La BD viva NUNCA se abre en escritura: se copia (backup API de SQLite) y se lee
 * la copia en readonly.
 *
 * Uso:
 *   node scripts/verso-drills/drill1-migration-rehearsal.cjs [--docs=10] [--cmds=40] [--seed=1337] [--keep-copy]
 */

'use strict';

const {
    Reporter, copyLiveDb, dropCopy, openReadonly, readPuckRows, loadKernel, mulberry32, firstDiff,
} = require('./_common.cjs');

const argv = process.argv.slice(2);
const argNum = (name, def) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? Number(hit.split('=')[1]) : def;
};
const DOCS = argNum('docs', 10);
const CMDS = argNum('cmds', 40);
const SEED = argNum('seed', 1337);
const KEEP = argv.includes('--keep-copy');

/* ------------------------------------------------------------------ */
/* Generador de secuencias de comandos realistas                       */
/* ------------------------------------------------------------------ */

function makeCommandGen(K) {
    const { ROOT_ID, ROOT_SLOT } = K;
    const pickInt = (rng, n) => Math.floor(rng() * n);

    /** Destinos de inserción: la raíz, todos los slots poblados y los arrays vacíos. */
    const insertTargets = (doc) => {
        const out = [{ parentId: ROOT_ID, slotKey: ROOT_SLOT }];
        for (const node of Object.values(doc.nodes)) {
            for (const sk of Object.keys(node.slots)) out.push({ parentId: node.id, slotKey: sk });
            for (const [k, v] of Object.entries(node.props)) {
                if (k !== 'id' && Array.isArray(v) && v.length === 0) out.push({ parentId: node.id, slotKey: k });
            }
        }
        return out;
    };
    const targetLength = (doc, t) =>
        t.parentId === ROOT_ID ? doc.rootChildren.length : (doc.nodes[t.parentId].slots[t.slotKey]?.length ?? 0);
    const subtreeSet = (doc, key) => {
        const out = new Set();
        const stack = [key];
        while (stack.length) {
            const k = stack.pop();
            if (out.has(k)) continue;
            out.add(k);
            const n = doc.nodes[k];
            if (n) for (const children of Object.values(n.slots)) stack.push(...children);
        }
        return out;
    };

    /**
     * Comando "de usuario": las mismas acciones que produce la UI (arrastrar un
     * bloque nuevo de la paleta, moverlo, escribir en un campo, duplicar, borrar).
     */
    return function randomCommand(doc, rng, nextId) {
        const keys = Object.keys(doc.nodes);
        const roll = rng();

        if (keys.length === 0 || roll < 0.30) {
            const targets = insertTargets(doc);
            const t = targets[pickInt(rng, targets.length)];
            const id = nextId();
            const item = rng() < 0.25
                ? { type: 'Columns', props: { id, 'col-0': [{ type: 'Text', props: { id: nextId(), content: '<p>drill</p>' } }] } }
                : { type: 'Text', props: { id, content: `<p>drill ${id}</p>` } };
            return { kind: 'insertNode', item, parentId: t.parentId, slotKey: t.slotKey, index: pickInt(rng, targetLength(doc, t) + 1) };
        }
        if (roll < 0.55) {
            // setProps sobre una prop EXISTENTE (edición de campo real) o una nueva.
            const key = keys[pickInt(rng, keys.length)];
            const node = doc.nodes[key];
            const editable = Object.keys(node.props).filter((k) => k !== 'id' && !(k in node.slots));
            const patch = {};
            if (editable.length && rng() < 0.7) {
                patch[editable[pickInt(rng, editable.length)]] = `drill-${pickInt(rng, 10000)}`;
            } else {
                patch[`drillProp${pickInt(rng, 3)}`] = pickInt(rng, 1000);
            }
            return { kind: 'setProps', nodeId: key, patch };
        }
        if (roll < 0.62) {
            return { kind: 'setRootProps', patch: { [`drillRoot${pickInt(rng, 2)}`]: `r${pickInt(rng, 100)}` } };
        }
        if (roll < 0.82) {
            const key = keys[pickInt(rng, keys.length)];
            const forbidden = subtreeSet(doc, key);
            const targets = insertTargets(doc).filter((t) => !forbidden.has(t.parentId));
            if (!targets.length) return null;
            const t = targets[pickInt(rng, targets.length)];
            return { kind: 'moveNode', nodeId: key, toParentId: t.parentId, toSlotKey: t.slotKey, toIndex: pickInt(rng, targetLength(doc, t) + 1) };
        }
        if (roll < 0.92) {
            const key = keys[pickInt(rng, keys.length)];
            return { kind: 'duplicateSubtree', nodeId: key };
        }
        const key = keys[pickInt(rng, keys.length)];
        return { kind: 'removeNode', nodeId: key };
    };
}

/* ------------------------------------------------------------------ */

async function main() {
    const rep = new Reporter('DRILL 1 — ensayo de migración sobre copia real');
    const { kernel: K } = await loadKernel();
    const { toNormalized, fromNormalized, applyCommand } = K;

    const copy = await copyLiveDb('drill1');
    rep.note(`copia: ${copy.file} (${copy.bytes} bytes, método ${copy.method})`);
    rep.note(`origen: ${copy.source} — abierto SOLO en readonly`);

    const db = openReadonly(copy.file);
    let rows;
    try {
        rows = readPuckRows(db);
    } finally {
        db.close();
    }

    rep.set('filas__puck_data', rows.length);
    rep.set('posts_distintos', new Set(rows.map((r) => r.postId)).size);

    /* ---------------- FASE A: round-trip byte-a-byte ---------------- */
    // Una fila cuyo post ya no existe (LEFT JOIN sin match) es meta HUÉRFANA de un post
    // borrado: no es contenido de nadie. Se cuenta y se enseña, pero no puede "perderse".
    const docs = [];
    for (const row of rows) {
        const orphan = row.postType === null || row.postType === undefined;
        if (orphan) rep.bump('metas_huerfanas_post_borrado');

        let parsed;
        try {
            parsed = JSON.parse(row.raw);
        } catch (e) {
            rep.bump('json_invalido');
            const msg = `post ${row.postId} (meta ${row.metaId}${orphan ? ', HUÉRFANA' : ''}): _puck_data no es JSON — ${e.message} — valor=${JSON.stringify(row.raw.slice(0, 40))}`;
            if (orphan) rep.note(msg); else rep.fail(msg);
            continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            rep.bump('json_no_objeto');
            const msg = `post ${row.postId}${orphan ? ' (HUÉRFANA)' : ''}: _puck_data parsea pero no es objeto`;
            if (orphan) rep.note(msg); else rep.fail(msg);
            continue;
        }
        const canonical = JSON.stringify(parsed);
        if (canonical === row.raw) rep.bump('bytes_almacenados_ya_canonicos');

        let doc;
        let out1;
        try {
            doc = toNormalized(parsed);
            out1 = fromNormalized(doc);
        } catch (e) {
            rep.bump('throw_en_roundtrip');
            rep.fail(`post ${row.postId}: THROW en round-trip — ${e.stack || e.message}`);
            continue;
        }
        if (doc.warnings.length) rep.bump('docs_con_warnings_fail_soft');

        const hasZones = !!parsed.zones && Object.keys(parsed.zones).length > 0;
        const s1 = JSON.stringify(out1);
        if (hasZones) {
            rep.bump('docs_con_zones_legacy');
            const s2 = JSON.stringify(fromNormalized(toNormalized(out1)));
            if (s2 !== s1) {
                rep.bump('zones_no_punto_fijo');
                rep.fail(`post ${row.postId}: zones→slots NO es punto fijo — ${JSON.stringify(firstDiff(s1, s2))}`);
            } else {
                rep.bump('zones_punto_fijo_ok');
            }
            // Cero pérdida: mismo nº de bloques antes y después de migrar las zonas.
            const before = countItems(parsed);
            const after = countItems(out1);
            if (before !== after) {
                rep.bump('zones_perdida_de_bloques');
                rep.fail(`post ${row.postId}: bloques ${before} → ${after} al migrar zones`);
            }
        } else if (s1 !== canonical) {
            rep.bump('roundtrip_byte_FALLA');
            rep.fail(`post ${row.postId} (${row.postType}/${row.postStatus}): round-trip NO byte-igual — ${JSON.stringify(firstDiff(canonical, s1))}`);
        } else {
            rep.bump('roundtrip_byte_ok');
        }

        docs.push({ row, parsed, canonical, blocks: countItems(parsed) });
    }

    /* ------- FASE B: secuencia de comandos + undo total ------------- */
    const randomCommand = makeCommandGen(K);
    const chosen = [...docs]
        .filter((d) => Array.isArray(d.parsed.content) && d.parsed.content.length > 0)
        .sort((a, b) => b.blocks - a.blocks || a.row.postId - b.row.postId)
        .slice(0, DOCS);
    rep.set('docs_editados', chosen.length);
    rep.set('comandos_por_doc', CMDS);

    let applied = 0;
    let rejected = 0;
    for (const d of chosen) {
        const rng = mulberry32(SEED + d.row.postId);
        let n = 0;
        const nextId = () => `drill-${d.row.postId}-${n++}`;
        let doc = toNormalized(d.parsed);
        const before = JSON.stringify(fromNormalized(doc));
        if (before !== d.canonical) {
            // No debería ocurrir salvo docs con zones (ya contabilizado en fase A).
            rep.note(`post ${d.row.postId}: base de la fase B = doc ya migrado (zones→slots)`);
        }
        const inverses = [];
        for (let i = 0; i < CMDS; i++) {
            const cmd = randomCommand(doc, rng, nextId);
            if (!cmd) continue;
            try {
                const res = applyCommand(doc, cmd);
                doc = res.doc;
                inverses.push(res.inverse);
                applied++;
            } catch (e) {
                // Un comando inválido NO debe tocar el doc: se cuenta y se sigue.
                rejected++;
                if (e.name !== 'VersoCommandError') {
                    rep.fail(`post ${d.row.postId}: throw NO tipado en ${cmd.kind} — ${e.stack || e.message}`);
                }
            }
        }
        const edited = JSON.stringify(fromNormalized(doc));
        if (edited === before) rep.bump('docs_sin_cambio_efectivo');

        // Deshacer TODO en orden inverso.
        let undoOk = true;
        for (let i = inverses.length - 1; i >= 0; i--) {
            try {
                doc = applyCommand(doc, inverses[i]).doc;
            } catch (e) {
                undoOk = false;
                rep.fail(`post ${d.row.postId}: THROW al deshacer #${i} (${inverses[i].kind}) — ${e.message}`);
                break;
            }
        }
        const after = JSON.stringify(fromNormalized(doc));
        if (!undoOk) {
            rep.bump('undo_con_throw');
        } else if (after !== before) {
            rep.bump('undo_NO_restaura_bytes');
            rep.fail(`post ${d.row.postId}: tras deshacer ${inverses.length} comandos la serialización difiere — ${JSON.stringify(firstDiff(before, after))}`);
        } else {
            rep.bump('undo_byte_exacto_ok');
        }
    }
    rep.set('comandos_aplicados', applied);
    rep.set('comandos_rechazados_sin_tocar_doc', rejected);

    if (!KEEP) dropCopy(copy.file);
    else rep.note(`copia CONSERVADA en ${copy.file}`);

    process.exit(rep.finish());
}

/** Nº de items (bloques) en un Data persistido, contando slots anidados y zonas. */
function countItems(data) {
    let n = 0;
    const walkArray = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const it of arr) {
            if (!it || typeof it !== 'object' || typeof it.type !== 'string' || !it.props) continue;
            n++;
            for (const v of Object.values(it.props)) if (Array.isArray(v)) walkArray(v);
        }
    };
    walkArray(data.content);
    if (data.zones && typeof data.zones === 'object' && !Array.isArray(data.zones)) {
        for (const z of Object.values(data.zones)) walkArray(z);
    }
    return n;
}

main().catch((e) => {
    console.error('❌ drill 1 abortó:', e);
    process.exit(2);
});
