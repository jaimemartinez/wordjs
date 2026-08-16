/**
 * Verso/colaboración — FRONTERA DE CONFIANZA del ingest de operaciones (F8.3).
 *
 * `core/collab-ops.ts` es el único punto donde una op pasa de "lo que dijo un cliente" a "lo que el
 * servidor persiste y reparte a los demás editores". Esta suite fija lo que ese punto garantiza:
 *
 *   1. el catálogo de ops es CERRADO y la op se RECONSTRUYE (nada no enumerado sobrevive: ni un
 *      campo de contrabando, ni una clave que contamine prototipos);
 *   2. la ATRIBUCIÓN no se puede falsificar (`siteId` de la op atado al de la conexión, y los
 *      sitios SEMILLA — los que ordenan el contenido preexistente — son irreclamables);
 *   3. el HTML y las URL que acabarán pintados en el canvas del OTRO editor pasan por el MISMO
 *      saneador que la ruta de escritura de posts (si no, el canal es XSS de editor a editor);
 *   4. el saneador es IDEMPOTENTE (gate G-F8.3-c): si sanear dos veces cambiara el valor, dos
 *      réplicas podrían acabar con contenidos distintos y el CRDT dejaría de converger;
 *   5. ninguna entrada malformada provoca una EXCEPCIÓN — siempre un rechazo tipado (G-F8.6-a).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { validateOp, validateFrame, sanitizeVersionVector, vvCovers, LIMITS } = require('../core/collab-ops');

const SITE = 's_abcdefghijklmnop';
const hlc = (l = 5, c = 0, site = SITE) => ({ l, c, site });
const dot = (counter = 1, site = SITE) => ({ site, counter });

const propSet = (over: any = {}) => ({
    k: 'propSet', id: dot(), hlc: hlc(), nodeId: 'n1', key: 'color', value: '#fff', ...over,
});

describe('catálogo cerrado y reconstrucción', () => {
    test('una `k` desconocida se rechaza', () => {
        const r = validateOp({ ...propSet(), k: 'dropDatabase' }, SITE);
        assert.equal(r.ok, false);
        assert.equal(r.code, 'unknown-kind');
    });

    test('`docReset` NO viaja por este canal (va por HTTP con su propia revisión)', () => {
        const r = validateOp({ k: 'docReset', id: dot(), epoch: 2, snapshotHash: 'x' }, SITE);
        assert.equal(r.ok, false);
    });

    test('los campos de contrabando NO sobreviven: la op se reconstruye entera', () => {
        const r = validateOp(propSet({ evil: 'payload', extraChannel: [1, 2, 3] }), SITE);
        assert.equal(r.ok, true);
        assert.deepEqual(Object.keys(r.op).sort(), ['hlc', 'id', 'k', 'key', 'nodeId', 'value']);
        assert.equal(r.op.evil, undefined);
        assert.equal(r.op.extraChannel, undefined);
    });

    test('una clave que contamina prototipos dentro de un valor tumba la op', () => {
        // JSON.parse y no un literal: así es como llega de verdad desde `express.json()`, y es la
        // única forma de que `__proto__` sea una clave PROPIA (en un literal solo cambia el
        // prototipo del objeto de test y el ataque ni siquiera se reproduce).
        const raw = JSON.parse(`{"k":"propSet","id":{"site":"${SITE}","counter":1},"hlc":{"l":5,"c":0,"site":"${SITE}"},"nodeId":"n1","key":"color","value":{"__proto__":{"admin":true}}}`);
        const r = validateOp(raw, SITE);
        assert.equal(r.ok, false);
        assert.equal(r.code, 'bad-value');
        assert.equal(({} as any).admin, undefined);
    });

    test('`nodeCreate` con una clave de prop peligrosa se rechaza', () => {
        const r = validateOp({
            k: 'nodeCreate', id: dot(), hlc: hlc(), nodeId: 'n1', type: 'Hero',
            props: { constructor: 'x' }, propOrder: [], slotKeys: [],
        }, SITE);
        assert.equal(r.ok, false);
        assert.equal(r.code, 'bad-key');
    });
});

describe('atribución: un cliente no puede hablar por otro', () => {
    test('una op que declara el siteId de OTRO se rechaza', () => {
        const r = validateOp(propSet({ id: dot(1, 's_otrapersonaaaaa') }), SITE);
        assert.equal(r.ok, false);
        assert.equal(r.code, 'forged-site');
    });

    test('el HLC tampoco puede declarar un sitio ajeno (es el desempate del LWW)', () => {
        const r = validateOp(propSet({ hlc: hlc(5, 0, 's_otrapersonaaaaa') }), SITE);
        assert.equal(r.ok, false);
        assert.equal(r.code, 'hlc-site-mismatch');
    });

    test('un sitio SEMILLA es irreclamable: suplantarlo reordenaría el documento', () => {
        const r = validateOp(propSet({ id: dot(1, '~s'), hlc: hlc(5, 0, '~s') }), '~s');
        assert.equal(r.ok, false);
        assert.equal(r.code, 'seed-site');
    });

    test('en cambio una POSICIÓN semilla sí es legítima (es el contenido preexistente)', () => {
        const r = validateOp({
            k: 'listInsert', id: dot(), hlc: hlc(), parentId: 'root', slotKey: 'children',
            left: '~s@3', right: null, nodeId: 'n9',
        }, SITE);
        assert.equal(r.ok, true);
        assert.equal(r.op.left, '~s@3');
    });

    test('un counter no entero / negativo / gigante se rechaza', () => {
        for (const counter of [0, -1, 1.5, 1e300, Number.NaN, '3']) {
            const r = validateOp(propSet({ id: { site: SITE, counter } }), SITE);
            assert.equal(r.ok, false, `counter ${String(counter)} debería rechazarse`);
        }
    });
});

describe('saneado: el canal no puede ser un bypass de XSS entre editores', () => {
    test('un campo HTML rico pasa por el sanitizador de la ruta de escritura', () => {
        const r = validateOp(propSet({ key: 'text', value: '<img src=x onerror=alert(1)><b>hola</b>' }), SITE);
        assert.equal(r.ok, true);
        assert.ok(!/onerror/i.test(r.op.value), `el manejador sobrevivió: ${r.op.value}`);
        assert.match(r.op.value, /<b>hola<\/b>/);
    });

    test('un esquema peligroso en una prop cualquiera se blanquea (no solo en las claves de URL)', () => {
        const r = validateOp(propSet({ key: 'buttonLink', value: 'javascript:alert(1)' }), SITE);
        assert.equal(r.ok, true);
        assert.equal(r.op.value, '');
    });

    test('el HTML anidado dentro de un objeto de props también se sanea', () => {
        const r = validateOp({
            k: 'nodeCreate', id: dot(), hlc: hlc(), nodeId: 'n1', type: 'Hero',
            props: { items: [{ title: '<script>alert(1)</script>seguro' }] },
            propOrder: ['items'], slotKeys: [],
        }, SITE);
        assert.equal(r.ok, true);
        assert.ok(!/<script/i.test(JSON.stringify(r.op.props)));
    });

    test('el href de una marca `link` se sanea (es el sink real de un XSS por enlace)', () => {
        const r = validateOp({
            k: 'markSet', id: dot(), hlc: hlc(), nodeId: 'n1', field: 'text', pos: `${SITE}@2`,
            mark: 'link', value: { href: 'javascript:alert(1)', newTab: true },
        }, SITE);
        assert.equal(r.ok, true);
        assert.equal(r.op.value.href, '');
        assert.equal(r.op.value.newTab, true);
    });

    test('el href dentro de las marcas de un átomo también', () => {
        const r = validateOp({
            k: 'textInsert', id: dot(), hlc: hlc(), nodeId: 'n1', field: 'text', left: null, right: null,
            atom: { br: false, ch: 'a', marks: { bold: true, italic: 'sí', link: { href: 'vbscript:x', newTab: 1 } } },
        }, SITE);
        assert.equal(r.ok, true);
        assert.equal(r.op.atom.marks.link.href, '');
        // Las marcas se NORMALIZAN a la forma exacta del núcleo: sin esto, dos réplicas podrían
        // guardar `italic:'sí'` y `italic:true` y divergir al comparar.
        assert.deepEqual(r.op.atom.marks, { bold: true, italic: false, link: { href: '', newTab: false } });
    });

    test('IDEMPOTENCIA (gate G-F8.3-c): sanear dos veces da lo mismo que sanear una', () => {
        const corpus = [
            '<b>negrita</b> y <i>cursiva</i>',
            '<img src=x onerror=alert(1)>',
            '<a href="javascript:alert(1)">click</a>',
            '&lt;script&gt;alert(1)&lt;/script&gt;',
            '&amp;amp;lt;b&amp;amp;gt;',
            '<p>uno</p><p>dos</p>',
            '<iframe src="https://www.youtube.com/embed/x"></iframe>',
            '<iframe src="https://evil.example/x"></iframe>',
            'texto llano sin nada',
            '<div style="color:red" class="c" id="i">estilos</div>',
            '<<script>script>alert(1)<</script>/script>',
            '"><svg/onload=alert(1)>',
            ' javascript:alert(1)',
            'JaVaScRiPt:alert(1)',
            'data:text/html;base64,PHNjcmlwdD4=',
        ];
        for (const raw of corpus) {
            const once = validateOp(propSet({ key: 'text', value: raw }), SITE);
            assert.equal(once.ok, true);
            const twice = validateOp(propSet({ key: 'text', value: once.op.value }), SITE);
            assert.equal(twice.ok, true);
            assert.equal(twice.op.value, once.op.value, `no idempotente para: ${raw}`);
        }
    });
});

describe('límites: nadie impone su memoria a la sala', () => {
    test('una cadena por encima del tope tumba la op', () => {
        const r = validateOp(propSet({ value: 'x'.repeat(LIMITS.STRING + 1) }), SITE);
        assert.equal(r.ok, false);
        assert.equal(r.code, 'bad-value');
    });

    test('un anidamiento por encima del tope tumba la op', () => {
        let deep: any = 'fondo';
        for (let i = 0; i < LIMITS.DEPTH + 3; i++) deep = { n: deep };
        const r = validateOp(propSet({ value: deep }), SITE);
        assert.equal(r.ok, false);
    });

    test('un array gigantesco tumba la op', () => {
        const r = validateOp(propSet({ value: new Array(LIMITS.ARRAY_LEN + 1).fill(0) }), SITE);
        assert.equal(r.ok, false);
    });

    test('un frame con más ops que el tope se rechaza ENTERO', () => {
        const ops = new Array(LIMITS.OPS_PER_FRAME + 1).fill(propSet());
        const r = validateFrame(ops, SITE);
        assert.equal(r.ok, false);
        assert.equal(r.code, 'too-large');
    });

    test('un átomo no puede llevar un párrafo entero: `ch` es 1 code unit', () => {
        const long = validateOp({
            k: 'textInsert', id: dot(), hlc: hlc(), nodeId: 'n1', field: 't', left: null, right: null,
            atom: { br: false, ch: 'párrafo entero', marks: {} },
        }, SITE);
        assert.equal(long.ok, false);
        assert.equal(long.code, 'bad-atom');

        // Un par suplente (emoji) SÍ entra como 2 code units y se recorta a la primera, igual que
        // hace el núcleo en `TextField.insert` — el servidor no puede ser más permisivo que él.
        const pair = validateOp({
            k: 'textInsert', id: dot(), hlc: hlc(), nodeId: 'n1', field: 't', left: null, right: null,
            atom: { br: false, ch: '😀', marks: {} },
        }, SITE);
        assert.equal(pair.ok, true);
        assert.equal(pair.op.atom.ch.length, 1);
    });
});

describe('un frame malo no tumba lo bueno del mismo frame', () => {
    test('las ops válidas pasan y las inválidas vuelven identificadas', () => {
        const r = validateFrame([
            propSet({ id: dot(1) }),
            { k: 'basura' },
            propSet({ id: dot(2), key: 'padding', value: 8 }),
        ], SITE);
        assert.equal(r.ok, true);
        assert.equal(r.ops.length, 2);
        assert.deepEqual(r.rejected, [{ index: 1, code: 'unknown-kind' }]);
    });
});

describe('robustez: un fuzzer no debe poder provocar un 500', () => {
    test('ninguna entrada absurda lanza — siempre un rechazo tipado', () => {
        const hostile = [
            null, undefined, 0, '', 'texto', [], [[]], true, Symbol.iterator,
            { k: 'propSet' },
            { k: 'propSet', id: null, hlc: null },
            { k: 'propSet', id: { site: SITE }, hlc: hlc() },
            { k: 'propSet', id: dot(), hlc: { l: 'x', c: 'y', site: SITE }, nodeId: 'n', key: 'k', value: 1 },
            { k: 'listInsert', id: dot(), hlc: hlc(), parentId: 'p', slotKey: 's', left: 'sin-arroba', right: null, nodeId: 'n' },
            { k: 'markSet', id: dot(), hlc: hlc(), nodeId: 'n', field: 'f', pos: `${SITE}@1`, mark: 'tachado', value: true },
            { k: 'shapeSet', id: dot(), hlc: hlc(), key: 'loQueSea', value: 1 },
            { k: 'textDelete', id: dot(), hlc: hlc(), nodeId: 'n', field: 'f', pos: '@' },
            Object.create({ k: 'propSet' }),
        ];
        for (const raw of hostile) {
            const r = validateOp(raw, SITE);
            assert.equal(r.ok, false, `debería rechazarse: ${String(raw)}`);
            assert.equal(typeof r.code, 'string');
        }
    });

    test('`shapeSet` solo acepta las claves de forma del contrato', () => {
        assert.equal(validateOp({ k: 'shapeSet', id: dot(), hlc: hlc(), key: 'topKeyOrder', value: ['root'] }, SITE).ok, true);
        assert.equal(validateOp({ k: 'shapeSet', id: dot(), hlc: hlc(), key: 'extras:mio', value: 1 }, SITE).ok, true);
        assert.equal(validateOp({ k: 'shapeSet', id: dot(), hlc: hlc(), key: 'extras:__proto__', value: 1 }, SITE).ok, false);
        assert.equal(validateOp({ k: 'shapeSet', id: dot(), hlc: hlc(), key: 'inventada', value: 1 }, SITE).ok, false);
    });
});

describe('version vector del resync (también es dato hostil)', () => {
    test('se descartan entradas malformadas y se acota el número de sitios', () => {
        const big: any = { [SITE]: 4, malo: 'x', otro: -1 };
        for (let i = 0; i < 400; i++) big[`s_relleno${i}`] = i;
        const vv = sanitizeVersionVector(big, 10);
        assert.ok(Object.keys(vv).length <= 10);
        assert.equal(vv.malo, undefined);
        assert.equal(vv.otro, undefined);
    });

    test('`vvCovers` decide qué ops le faltan al que reconecta', () => {
        const vv = sanitizeVersionVector({ [SITE]: 4 });
        assert.equal(vvCovers(vv, SITE, 4), true);
        assert.equal(vvCovers(vv, SITE, 5), false);
        assert.equal(vvCovers(vv, 's_desconocido', 1), false);
    });
});
