/**
 * VERSO F7 — DRILL 4: FUZZ DE CARGA REAL contra el GUARD del motor inline.
 *
 * El guard fail-closed de VersoTextSurface (components/verso/inline/VersoTextSurface.tsx
 * :563-577) compara, al montar una sesión rich, el texto plano del HTML inicial con el
 * texto que el pipeline entiende. Si detecta pérdida, la sesión entra en SOLO LECTURA.
 * Eso protege el contenido… pero un FALSO POSITIVO deja al autor sin poder editar el
 * bloque. Este drill mide falsos positivos con CONTENIDO LEGÍTIMO de la instalación real.
 *
 * Se replica el pipeline del guard con el código REAL:
 *     refText = htmlToText(sanitizeHTML(valor))          ← equivalente node de div.textContent
 *     modelo  = parseRichHtml(valor)
 *     (a) inlineGuardLosesText(refText, docGuardText(modelo))
 *     (b) inlineGuardLosesText(refText, docGuardText(parseRichHtml(serializeDocForEditor(modelo))))
 *
 * LÍMITE HONESTO: la pata (b) del guard real relee el DOM ya pintado con el walker
 * `readRichModel` (capa DOM, imposible sin navegador). Aquí se sustituye por la
 * re-lectura del HTML emitido — cubre motor y serializador, NO el walker. Esa mitad la
 * cubre el E2E de navegador.
 *
 * Uso: node scripts/verso-drills/drill4-inline-guard-load.cjs [--docs=20] [--all-props]
 */

'use strict';

const { Reporter, copyLiveDb, dropCopy, openReadonly, readPuckRows, loadKernel } = require('./_common.cjs');

const argv = process.argv.slice(2);
const argNum = (name, def) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? Number(hit.split('=')[1]) : def;
};
const DOCS = argNum('docs', 20);
const KEEP = argv.includes('--keep-copy');

/** Único campo declarado `inline: { schema: "rich" }` en el registry (coreBlocks.tsx:291). */
const RICH_FIELDS = new Set(['Text.content']);
const LOOKS_LIKE_HTML = /<[a-zA-Z!/]|&[a-zA-Z#][\w]{1,8};/;

/** Recorre un Data persistido acumulando {type, key, value} de cada prop string. */
function collectStringProps(data, out, depthOut) {
    const walk = (arr, depth) => {
        if (!Array.isArray(arr)) return;
        for (const it of arr) {
            if (!it || typeof it !== 'object' || typeof it.type !== 'string' || !it.props) continue;
            depthOut.max = Math.max(depthOut.max, depth);
            for (const [k, v] of Object.entries(it.props)) {
                if (typeof v === 'string') out.push({ type: it.type, key: k, value: v });
                else if (Array.isArray(v)) walk(v, depth + 1);
                else if (v && typeof v === 'object') {
                    // Sub-objetos de campos compartidos (look/anim/css…): también son strings del autor.
                    for (const [k2, v2] of Object.entries(v)) {
                        if (typeof v2 === 'string') out.push({ type: it.type, key: `${k}.${k2}`, value: v2 });
                    }
                }
            }
        }
    };
    walk(data.content, 1);
    if (data.zones && typeof data.zones === 'object' && !Array.isArray(data.zones)) {
        for (const z of Object.values(data.zones)) walk(z, 1);
    }
}

async function main() {
    const rep = new Reporter('DRILL 4 — guard inline fail-closed contra carga real');
    const { kernel: K } = await loadKernel();
    const {
        sanitizeHTML, htmlToText, parseRichHtml, serializeDocForEditor,
        docGuardText, inlineGuardLosesText, normalizeGuardText,
    } = K;

    const copy = await copyLiveDb('drill4');
    rep.note(`copia: ${copy.file} (${copy.bytes} bytes, ${copy.method})`);
    const db = openReadonly(copy.file);
    let rows;
    try { rows = readPuckRows(db); } finally { db.close(); }

    /* --- los N documentos más grandes / más profundos ---------------- */
    const parsed = [];
    for (const row of rows) {
        let data;
        try { data = JSON.parse(row.raw); } catch { continue; }
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        const props = [];
        const depth = { max: 0 };
        collectStringProps(data, props, depth);
        parsed.push({ row, bytes: row.raw.length, depth: depth.max, props });
    }
    rep.set('docs_con__puck_data_valido', parsed.length);

    const byBytes = [...parsed].sort((a, b) => b.bytes - a.bytes);
    const byDepth = [...parsed].sort((a, b) => b.depth - a.depth || b.bytes - a.bytes);
    const chosen = [];
    const seen = new Set();
    const take = (d) => { if (d && !seen.has(d.row.metaId)) { seen.add(d.row.metaId); chosen.push(d); } };
    for (let i = 0; i < Math.ceil(DOCS / 2); i++) take(byBytes[i]);
    for (let i = 0; chosen.length < DOCS && i < byDepth.length; i++) take(byDepth[i]);
    for (let i = 0; chosen.length < DOCS && i < byBytes.length; i++) take(byBytes[i]);

    rep.set('docs_analizados', chosen.length);
    rep.set('bytes_max_doc', chosen.length ? Math.max(...chosen.map((d) => d.bytes)) : 0);
    rep.set('profundidad_max_doc', chosen.length ? Math.max(...chosen.map((d) => d.depth)) : 0);

    /* --- universo de valores ---------------------------------------- */
    const richValues = [];   // lo que el guard ejecuta DE VERDAD (campos declarados rich)
    const htmlValues = [];   // superset: cualquier prop string con marcado
    for (const d of chosen) {
        for (const p of d.props) {
            if (p.value.length === 0) continue;
            const fq = `${p.type}.${p.key}`;
            const entry = { ...p, fq, postId: d.row.postId };
            if (RICH_FIELDS.has(fq)) richValues.push(entry);
            else if (LOOKS_LIKE_HTML.test(p.value)) htmlValues.push(entry);
        }
    }
    rep.set('valores_rich_declarados', richValues.length);
    rep.set('valores_rich_distintos', new Set(richValues.map((v) => v.value)).size);
    rep.set('otros_valores_con_marcado', htmlValues.length);
    rep.set('bytes_totales_analizados', [...richValues, ...htmlValues].reduce((s, v) => s + v.value.length, 0));

    /* --- ejecución del guard ---------------------------------------- */
    const runGuard = (value) => {
        const refText = htmlToText(sanitizeHTML(value));
        const model = parseRichHtml(value);
        const a = inlineGuardLosesText(refText, docGuardText(model));
        if (a) return { readOnly: true, leg: 'a-motor' };
        const emitted = serializeDocForEditor(model);
        const reparsed = parseRichHtml(emitted);
        const b = inlineGuardLosesText(refText, docGuardText(reparsed));
        if (b) return { readOnly: true, leg: 'b-serializar-y-releer', emitted };
        // Extra: punto fijo del motor (no es parte del guard, pero un no-punto-fijo
        // sería deriva del contenido en cada apertura del editor).
        const fixed = serializeDocForEditor(reparsed) === emitted;
        return { readOnly: false, fixed, refText, model };
    };

    const describe = (value, res) => {
        const ref = normalizeGuardText(htmlToText(sanitizeHTML(value)));
        const got = normalizeGuardText(docGuardText(parseRichHtml(value)));
        let i = 0;
        while (i < ref.length && i < got.length && ref[i] === got[i]) i++;
        return `pata=${res.leg} refLen=${ref.length} gotLen=${got.length} divergeEn=${i} ref="${ref.slice(Math.max(0, i - 15), i + 45)}" got="${got.slice(Math.max(0, i - 15), i + 45)}"`;
    };

    /* --- CONTROL NEGATIVO: el arnés debe saber detectar un disparo ---- */
    // Sin esto, "0 disparos" podría significar simplemente que el arnés está inerte.
    {
        const full = '<p>parrafo uno</p><p>parrafo dos</p>';
        const ref = htmlToText(sanitizeHTML(full));
        const lossy = parseRichHtml('<p>parrafo uno</p>');   // pipeline que pierde el 2º párrafo
        if (inlineGuardLosesText(ref, docGuardText(lossy))) rep.bump('control_negativo_detecta_perdida');
        else rep.fail('CONTROL NEGATIVO ROTO: el arnés no detecta una pérdida evidente — los "0 disparos" no valdrían nada');
    }

    /* --- inventario de clases conocidas de disparo -------------------- */
    // Valores que el SANEADOR permite (están en ALLOWED_TAGS de lib/sanitize.ts) pero
    // que el motor inline no modela. No aparecen en el corpus actual; se listan porque
    // un autor puede pegarlos en un bloque Text y el bloque quedaría en solo lectura.
    const KNOWN_PROBES = [
        '<textarea>hola</textarea>',
        '<select><option>uno</option></select>',
        '<p>texto</p><table><tr><td>celda</td></tr></table>',
        '<details><summary>tit</summary>cuerpo</details>',
        '<blockquote>cita</blockquote>',
        '<pre>codigo</pre>',
        '<button>boton</button>',
        '<label>etiqueta</label>',
    ];
    const probeHits = [];
    for (const p of KNOWN_PROBES) {
        if (runGuard(p).readOnly) probeHits.push(p);
    }
    rep.set('sondas_sinteticas', KNOWN_PROBES.length);
    rep.set('sondas_que_disparan', probeHits.length);
    if (probeHits.length) rep.note(`clases que dejarían el bloque en SOLO LECTURA si un autor las pega: ${probeHits.map((p) => JSON.stringify(p)).join(', ')} — el saneador las conserva, el motor inline no las modela`);

    for (const v of richValues) {
        const res = runGuard(v.value);
        if (res.readOnly) {
            rep.bump('GUARD_DISPARA_en_campo_rich');
            rep.fail(`post ${v.postId} · ${v.fq}: el guard pondría la sesión en SOLO LECTURA — ${describe(v.value, res)} — valor=${JSON.stringify(v.value.slice(0, 160))}`);
        } else {
            rep.bump('rich_ok_editable');
            if (!res.fixed) {
                rep.bump('rich_no_punto_fijo');
                rep.fail(`post ${v.postId} · ${v.fq}: parse→serialize NO es punto fijo (el contenido derivaría al reabrir) — valor=${JSON.stringify(v.value.slice(0, 160))}`);
            }
        }
    }

    // Superset informativo: props NO declaradas rich hoy. Un disparo aquí no rompe a
    // nadie ahora mismo, pero marca qué contenido no soportaría el motor si mañana se
    // promocionara ese campo a rich.
    const supersetHits = [];
    for (const v of htmlValues) {
        const res = runGuard(v.value);
        if (res.readOnly) { rep.bump('superset_dispararia_si_fuera_rich'); supersetHits.push(`${v.fq} (post ${v.postId})`); }
        else rep.bump('superset_ok');
    }
    // Barrido COMPLETO: los 20 más grandes son en buena parte revisiones de las mismas
    // páginas, así que el universo distinto es pequeño. Se pasa el guard por TODOS los
    // valores rich DISTINTOS del corpus entero para que el número signifique algo.
    const allRich = new Map(); // valor → primer {postId, fq}
    for (const d of parsed) {
        for (const p of d.props) {
            if (!p.value.length) continue;
            const fq = `${p.type}.${p.key}`;
            if (!RICH_FIELDS.has(fq)) continue;
            if (!allRich.has(p.value)) allRich.set(p.value, { postId: d.row.postId, fq });
        }
    }
    rep.set('corpus_completo_valores_rich_distintos', allRich.size);
    for (const [value, meta] of allRich) {
        const res = runGuard(value);
        if (res.readOnly) {
            rep.bump('corpus_completo_GUARD_DISPARA');
            rep.fail(`[corpus completo] post ${meta.postId} · ${meta.fq}: SOLO LECTURA — ${describe(value, res)} — valor=${JSON.stringify(value.slice(0, 160))}`);
        } else {
            rep.bump('corpus_completo_ok_editable');
            if (!res.fixed) {
                rep.bump('corpus_completo_no_punto_fijo');
                rep.fail(`[corpus completo] post ${meta.postId} · ${meta.fq}: parse→serialize NO es punto fijo — valor=${JSON.stringify(value.slice(0, 160))}`);
            }
        }
    }

    if (supersetHits.length) {
        const byField = {};
        for (const h of supersetHits) { const f = h.split(' ')[0]; byField[f] = (byField[f] || 0) + 1; }
        rep.note(`campos NO-rich que dispararían: ${JSON.stringify(byField)}`);
    }

    if (!KEEP) dropCopy(copy.file); else rep.note(`copia CONSERVADA en ${copy.file}`);
    process.exit(rep.finish());
}

main().catch((e) => {
    console.error('❌ drill 4 abortó:', e);
    process.exit(2);
});
