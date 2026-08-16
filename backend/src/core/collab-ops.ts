/**
 * WordJS — Verso/colaboración: FRONTERA DE CONFIANZA de las operaciones CRDT (F8.3, D17).
 *
 * Toda operación que entra por el canal colaborativo es DATO HOSTIL. Este módulo es el único
 * sitio donde una op cruza de "lo que dijo un cliente" a "lo que el servidor persiste y reparte".
 *
 * Tres reglas que gobiernan el fichero entero:
 *
 *  1. **RECONSTRUCCIÓN, no validación por encima.** Cada op se vuelve a construir campo a campo
 *     a partir de la entrada. Nada que no esté enumerado aquí sobrevive. Esto cierra de raíz dos
 *     clases enteras: el contrabando de campos (usar la op como canal lateral entre editores) y
 *     la contaminación de prototipos (`__proto__`/`constructor` como clave de un objeto de props).
 *     Y donde la clave la elige el cliente —`props`, los valores JSON, el version vector— la
 *     estructura NO la elige: destino sin prototipo y escritura por `setOwn`, para que el filtro de
 *     nombres sea defensa en profundidad y no el único muro (ver `setOwn`).
 *  2. **SANEADO CON EL MISMO MÓDULO QUE LA RUTA DE ESCRITURA.** Los valores que acaban pintados
 *     en el canvas del OTRO editor pasan por `sanitizePuckTree`/`safePuckUrl` de
 *     `core/sanitize-meta.ts` — el mismo código que ya sanea `_puck_data` en `PUT /posts/:id`.
 *     Sin esto el canal sería un bypass de XSS de editor a editor DENTRO del admin autenticado
 *     (§4.5 de la spec): el saneado del guardado llegaría tarde, el script ya habría corrido.
 *  3. **EL SANEADO OCURRE UNA SOLA VEZ, EN EL INGEST.** Lo que se persiste es exactamente lo que
 *     se difunde. Si dos nodos sanearan el mismo valor y obtuvieran resultados distintos, las
 *     réplicas divergirían; saneando una vez en el ingest, el valor saneado es el único que viaja.
 *     La idempotencia del saneador se verifica igualmente en el gate `collab-sanitize.test.ts`.
 *
 * Nota de arquitectura: este validador NO comparte código con el núcleo CRDT del frontend (que es
 * ESM/TSX bajo `frontend/src/lib/verso/crdt/`). Es deliberado: el servidor no necesita — ni debe —
 * ejecutar el algoritmo para autorizar y sanear. Valida la FORMA del sobre; la convergencia la
 * garantiza el álgebra en los clientes. Lo único que ambos lados deben compartir es el catálogo de
 * `k` y la forma de los campos, que está fijado en `documentation/verso/crdt-spec.md` §3.1.
 */

const { sanitizePuckTree, safePuckUrl } = require('./sanitize-meta');

/** Prefijo reservado de las posiciones SEMILLA (identity.ts `SEED_PREFIX`). */
const SEED_PREFIX = '~';

// Límites duros. No son "configuración": son el techo de lo que un cliente puede imponerle a la
// memoria de los DEMÁS clientes de la sala, porque todo lo que pasa por aquí se reenvía a todos.
const LIMITS = {
    /** Longitud de un `siteId`, un `nodeId` o una `PosRef`. */
    ID: 200,
    /** Longitud de una clave de prop / slot / campo de texto. */
    KEY: 160,
    /** Profundidad de anidamiento de un valor JSON de prop. */
    DEPTH: 16,
    /** Claves de un objeto dentro de un valor de prop. */
    OBJECT_KEYS: 512,
    /** Elementos de un array dentro de un valor de prop. */
    ARRAY_LEN: 2048,
    /** Bytes de una cadena suelta dentro de un valor de prop. */
    STRING: 256 * 1024,
    /** Claves de `props` en un `nodeCreate`. */
    PROPS: 512,
    /** Slots declarados en un `nodeCreate`. */
    SLOTS: 128,
    /** Ops en un solo frame (una transacción del editor). */
    OPS_PER_FRAME: 512,
} as const;

const OP_KINDS = new Set([
    'nodeCreate', 'listInsert', 'listMove', 'nodeDelete',
    'propSet', 'propDelete', 'textInsert', 'textDelete',
    'markSet', 'shapeSet',
]);

const MARK_NAMES = new Set(['bold', 'italic', 'link']);

const SHAPE_SCALARS = new Set(['topKeyOrder', 'contentKeyState', 'rootKeyPresent', 'zonesKeyPresent', 'rootKeyOrder']);

/** Motivo TIPADO del rechazo. Nunca una excepción: un fuzzer no debe poder provocar un 500. */
export type OpRejectCode =
    | 'not-an-object' | 'unknown-kind' | 'bad-op-id' | 'forged-site' | 'seed-site'
    | 'bad-hlc' | 'hlc-site-mismatch' | 'bad-node-id' | 'bad-key' | 'bad-position'
    | 'bad-value' | 'bad-atom' | 'bad-mark' | 'bad-shape-key' | 'too-large';

export type ValidateResult =
    /**
     * `changed` = el saneado REESCRIBIÓ algún valor de la op. Se propaga porque el emisor es el único
     * que no recibe la difusión (ya la aplicó localmente, en CRUDO): sin devolvérselo, su réplica se
     * queda con el valor sin sanear mientras todas las demás tienen el saneado — divergencia
     * permanente dentro del epoch, y el `resync` tampoco la repara porque su version vector ya cubre
     * ese dot.
     */
    | { ok: true; op: any; kind: string; counter: number; changed: boolean }
    | { ok: false; code: OpRejectCode };

const bad = (code: OpRejectCode): ValidateResult => ({ ok: false, code });

const isPlainObject = (v: any): boolean =>
    !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Una clave que un atacante puede usar para envenenar `Object.prototype` al reconstruirse el objeto
 * en el CLIENTE receptor. Se rechaza aquí, no se filtra: una op con una clave así es hostil por
 * construcción y no hay motivo legítimo para dejar pasar el resto de la op.
 *
 * Esta lista es COMPLETA para lo que hace (a diferencia de una denylist de nombres de módulos, que
 * envejece): en JS solo `__proto__` es un accesor de `Object.prototype` que redirige una escritura, y
 * `constructor`/`prototype` son los dos pasos del único gadget indirecto. Aun así NO es de lo que
 * cuelga la seguridad de este fichero — de eso se encarga `setOwn`, que no puede alcanzar un
 * prototipo ni aunque la lista se quedara corta o alguien la borrara.
 */
const isUnsafeKey = (k: string): boolean =>
    k === '__proto__' || k === 'constructor' || k === 'prototype';

/**
 * ESCRIBIR UNA CLAVE QUE ELIGE EL CLIENTE, SIN QUE LA CLAVE PUEDA ELEGIR LA ESTRUCTURA.
 *
 * Los tres sitios de este fichero que escriben bajo una clave remota pasan por aquí. `obj[k] = v`
 * consulta la cadena de prototipos y puede acabar invocando un ACCESOR heredado (`__proto__` es
 * exactamente eso); `Object.defineProperty` no: define siempre una propiedad PROPIA de datos sobre
 * el objeto indicado, pase lo que pase por encima. Combinado con destinos creados sin prototipo
 * (`Object.create(null)`), la escritura no tiene ningún prototipo al que llegar.
 *
 * Esto es lo que convierte el filtro de claves en defensa en profundidad en vez de en el único muro.
 * Este proyecto ya se comió el otro modelo en los permisos de plugins, donde un slug `__proto__`
 * hacía que la comprobación fallara EN ABIERTO: la lección fue no inferir seguridad de la AUSENCIA
 * de un nombre en una lista.
 */
function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function okString(v: any, max: number): boolean {
    return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function okKey(v: any): boolean {
    return okString(v, LIMITS.KEY) && !isUnsafeKey(v);
}

/** Entero no negativo y seguro (un `counter` de 1e300 rompe la aritmética de todas las réplicas). */
function okCounter(v: any): boolean {
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * `PosRef = "<site>@<counter>"`. Un sitio SEMILLA (`~s`, `~t:<node>:<field>`) SÍ es una posición
 * legítima — es el contenido que ya existía al abrir la sala — así que aquí no se filtra el `~`.
 * Donde sí se filtra es en el `OpId` de la op (ver `readOpId`): suplantar un sitio semilla
 * reordenaría el documento en todas las réplicas.
 */
function okPosRef(v: any): boolean {
    if (!okString(v, LIMITS.ID)) return false;
    const at = v.lastIndexOf('@');
    if (at <= 0 || at === v.length - 1) return false;
    const counter = Number(v.slice(at + 1));
    return Number.isSafeInteger(counter) && counter >= 0;
}

/** `left`/`right` son opcionales (null = principio/final de la lista). */
function readSide(v: any): { ok: boolean; value: string | null } {
    if (v === null || v === undefined) return { ok: true, value: null };
    if (!okPosRef(v)) return { ok: false, value: null };
    return { ok: true, value: v };
}

/**
 * Valor JSON de una prop: se copia RECURSIVAMENTE dentro de los límites, descartando todo lo que no
 * sea JSON puro (funciones, símbolos, undefined, ciclos — un ciclo ni siquiera llega, el body ya
 * viene de `JSON.parse`). Devuelve `undefined` si el valor viola un límite.
 */
function cloneJson(v: any, depth: number): any {
    if (depth > LIMITS.DEPTH) return undefined;
    if (v === null) return null;
    const t = typeof v;
    if (t === 'boolean') return v;
    if (t === 'number') return Number.isFinite(v) ? v : undefined;
    if (t === 'string') return v.length <= LIMITS.STRING ? v : undefined;
    if (Array.isArray(v)) {
        if (v.length > LIMITS.ARRAY_LEN) return undefined;
        const out: any[] = [];
        for (const item of v) {
            const c = cloneJson(item, depth + 1);
            if (c === undefined) return undefined;
            out.push(c);
        }
        return out;
    }
    if (t === 'object') {
        // `Object.keys` solo devuelve claves PROPIAS y enumerables, así que `v[k]` de abajo nunca lee
        // nada heredado por muy envenenado que esté `Object.prototype` en este proceso.
        const keys = Object.keys(v);
        if (keys.length > LIMITS.OBJECT_KEYS) return undefined;
        // Destino SIN PROTOTIPO: no hay accesor heredado que una clave remota pueda despertar, ni
        // `Object.prototype` al que llegar. (Aquí es transitorio —`sanitizePuckTree` reconstruye el
        // valor después— pero la ESCRITURA de este bucle deja de poder tocar estructura, que es lo
        // que se estaba señalando.)
        const out: Record<string, any> = Object.create(null);
        for (const k of keys) {
            if (k.length > LIMITS.KEY || isUnsafeKey(k)) return undefined;
            const c = cloneJson(v[k], depth + 1);
            if (c === undefined) return undefined;
            setOwn(out, k, c);
        }
        return out;
    }
    return undefined; // function / symbol / undefined / bigint
}

/**
 * JSON con las claves de objeto ORDENADAS. Sirve para comparar "antes y después del saneado" sin
 * que un simple cambio de orden de claves cuente como reescritura (produciría correcciones
 * espurias en el emisor).
 */
function canonicalJson(v: any): string {
    return JSON.stringify(v, (_k: string, val: any) => {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            const out: Record<string, any> = {};
            for (const k of Object.keys(val).sort()) out[k] = val[k];
            return out;
        }
        return val;
    });
}

/**
 * Copia + SANEA un valor de prop, diciendo además si el saneador cambió algo. `keyHint` es la clave
 * bajo la que el valor viaja: es lo que hace que `sanitizePuckTree` sepa que `text`/`content`/`html`…
 * son HTML y haya que pasarlos por el sanitizador de HTML, mientras que el resto de cadenas solo
 * pierden los esquemas peligrosos.
 *
 * (Tenía delante un `cleanValue` que solo se quedaba con el valor y al que ya no llamaba nadie: el
 * emisor necesita saber qué se le reescribió, así que todos los caminos pasan por la versión que lo
 * dice. Se barre en vez de dejarlo como warning perpetuo del linter.)
 */
function cleanValueEx(v: any, keyHint: string | null): { value: any; changed: boolean } {
    const cloned = cloneJson(v, 0);
    if (cloned === undefined) return { value: undefined, changed: false };
    const value = sanitizePuckTree(cloned, keyHint);
    return { value, changed: canonicalJson(value) !== canonicalJson(cloned) };
}

/** Lista de cadenas cortas (orden de claves, claves de slot). */
function readStringList(v: any, max: number): string[] | null {
    if (!Array.isArray(v) || v.length > max) return null;
    const out: string[] = [];
    for (const s of v) {
        if (!okKey(s)) return null;
        out.push(s);
    }
    return out;
}

/**
 * Marcas de un átomo, normalizadas EXACTAMENTE a la forma que produce `sanitizeWireMarks` del
 * núcleo (`{bold, italic, link:{href,newTab}|null}`) y con el `href` pasado por `safePuckUrl`.
 *
 * Que el servidor sanee el href y NO el cliente es lo que hace converger esto: el valor que llega a
 * todas las réplicas es el mismo valor ya saneado. Si cada réplica saneara por su cuenta, bastaría
 * una versión distinta del sanitizador en un cliente para divergir.
 */
function cleanMarks(v: any): any {
    const m = isPlainObject(v) ? v : {};
    const link = m.link;
    let outLink: { href: string; newTab: boolean } | null = null;
    if (isPlainObject(link) && typeof link.href === 'string' && link.href.length <= LIMITS.STRING) {
        outLink = { href: safePuckUrl(link.href), newTab: link.newTab === true };
    }
    return { bold: m.bold === true, italic: m.italic === true, link: outLink };
}

/**
 * Un átomo es 1 code unit o un salto duro. `ch` se recorta a 1 unidad igual que hace el núcleo
 * (`TextField.insert`), de modo que un cliente no puede colar un párrafo entero en un solo átomo y
 * saltarse los límites de tamaño del campo.
 */
function cleanAtom(v: any): any | null {
    if (!isPlainObject(v)) return null;
    const br = v.br === true;
    if (br) return { br: true, ch: '', marks: cleanMarks(v.marks) };
    if (typeof v.ch !== 'string' || v.ch.length === 0 || v.ch.length > 2) return null;
    return { br: false, ch: v.ch.slice(0, 1), marks: cleanMarks(v.marks) };
}

/**
 * Valida y RECONSTRUYE una operación.
 *
 * @param raw       la op tal cual la mandó el cliente
 * @param siteId    el `siteId` ATADO A LA CONEXIÓN. La op debe declararlo como suyo: sin esto un
 *                  cliente podría emitir ops atribuidas a otro editor (§2.1, último punto).
 */
function validateOp(raw: any, siteId: string): ValidateResult {
    if (!isPlainObject(raw)) return bad('not-an-object');
    const k = raw.k;
    if (typeof k !== 'string' || !OP_KINDS.has(k)) return bad('unknown-kind');

    // --- OpId: identidad y ATRIBUCIÓN -----------------------------------------------------------
    const id = raw.id;
    if (!isPlainObject(id) || !okString(id.site, LIMITS.ID) || !okCounter(id.counter) || id.counter < 1) {
        return bad('bad-op-id');
    }
    if (String(id.site).startsWith(SEED_PREFIX)) return bad('seed-site');
    if (id.site !== siteId) return bad('forged-site');
    const opId = { site: siteId, counter: id.counter };

    // --- HLC ------------------------------------------------------------------------------------
    // `docReset` no viaja por este canal (§3.3: va por HTTP con su propia revisión), así que las ops
    // que llegan aquí llevan reloj... salvo `listInsert`, que NO LO TIENE EN EL CATÁLOGO: su posición
    // la arbitra Fugue por las posiciones vecinas, no un LWW, así que el emisor no lo manda (ver
    // `ListInsertOp` en frontend/src/lib/verso/crdt/types.ts). Exigirlo aquí rechazaba con `bad-hlc`
    // TODA inserción y TODA duplicación de bloque: el bloque aparecía en el editor que lo creó y no
    // llegaba a nadie más.
    const hlcOptional = k === 'listInsert';
    const h = raw.hlc;
    let hlc: { l: number; c: number; site: string } | null = null;
    if (h === undefined || h === null) {
        if (!hlcOptional) return bad('bad-hlc');
    } else {
        if (!isPlainObject(h) || !okCounter(h.l) || !okCounter(h.c) || !okString(h.site, LIMITS.ID)) {
            return bad('bad-hlc');
        }
        // El sitio del reloj es el desempate final del LWW: si se pudiera declarar ajeno, un cliente
        // ganaría (o perdería) empates en nombre de otro.
        if (h.site !== siteId) return bad('hlc-site-mismatch');
        hlc = { l: h.l, c: h.c, site: siteId };
    }

    const base: any = hlc ? { k, id: opId, hlc } : { k, id: opId };

    switch (k) {
        case 'nodeCreate': {
            if (!okString(raw.nodeId, LIMITS.ID) || isUnsafeKey(raw.nodeId)) return bad('bad-node-id');
            if (typeof raw.type !== 'string' || raw.type.length > LIMITS.KEY) return bad('bad-key');
            if (!isPlainObject(raw.props)) return bad('bad-value');
            const propKeys = Object.keys(raw.props);
            if (propKeys.length > LIMITS.PROPS) return bad('too-large');
            // Las claves de `props` son NOMBRES DE CAMPO DE BLOQUE: no hay allowlist posible (cada
            // plugin declara los suyos), así que lo que se acota es la ESTRUCTURA — objeto sin
            // prototipo y escritura por `setOwn` — en vez de fiarlo todo a la lista de nombres
            // prohibidos. `props` viaja después por JSON, así que no tener prototipo no se nota.
            const props: Record<string, any> = Object.create(null);
            let changed = false;
            for (const pk of propKeys) {
                if (!okKey(pk)) return bad('bad-key');
                const val = cleanValueEx(raw.props[pk], pk);
                if (val.value === undefined) return bad('bad-value');
                setOwn(props, pk, val.value);
                if (val.changed) changed = true;
            }
            const propOrder = readStringList(raw.propOrder, LIMITS.PROPS);
            if (!propOrder) return bad('bad-key');
            const slotKeys = readStringList(raw.slotKeys, LIMITS.SLOTS);
            if (!slotKeys) return bad('bad-key');

            const op: any = { ...base, nodeId: raw.nodeId, type: raw.type, props, propOrder, slotKeys };
            if (raw.keyOrder !== undefined) {
                const keyOrder = readStringList(raw.keyOrder, LIMITS.PROPS + LIMITS.SLOTS);
                if (!keyOrder) return bad('bad-key');
                op.keyOrder = keyOrder;
            }
            if (raw.extras !== undefined) {
                if (!isPlainObject(raw.extras)) return bad('bad-value');
                const extras = cleanValueEx(raw.extras, null);
                if (extras.value === undefined) return bad('bad-value');
                op.extras = extras.value;
                if (extras.changed) changed = true;
            }
            return { ok: true, op, kind: k, counter: opId.counter, changed };
        }

        case 'listInsert': {
            if (!okString(raw.parentId, LIMITS.ID) || isUnsafeKey(raw.parentId)) return bad('bad-node-id');
            if (!okString(raw.nodeId, LIMITS.ID) || isUnsafeKey(raw.nodeId)) return bad('bad-node-id');
            if (!okKey(raw.slotKey)) return bad('bad-key');
            const left = readSide(raw.left);
            const right = readSide(raw.right);
            if (!left.ok || !right.ok) return bad('bad-position');
            return {
                ok: true, kind: k, counter: opId.counter, changed: false,
                op: { ...base, parentId: raw.parentId, slotKey: raw.slotKey, left: left.value, right: right.value, nodeId: raw.nodeId },
            };
        }

        case 'listMove': {
            if (!okString(raw.nodeId, LIMITS.ID) || isUnsafeKey(raw.nodeId)) return bad('bad-node-id');
            if (!okString(raw.toParentId, LIMITS.ID) || isUnsafeKey(raw.toParentId)) return bad('bad-node-id');
            if (!okKey(raw.toSlotKey)) return bad('bad-key');
            const left = readSide(raw.left);
            const right = readSide(raw.right);
            if (!left.ok || !right.ok) return bad('bad-position');
            return {
                ok: true, kind: k, counter: opId.counter, changed: false,
                op: { ...base, nodeId: raw.nodeId, toParentId: raw.toParentId, toSlotKey: raw.toSlotKey, left: left.value, right: right.value },
            };
        }

        case 'nodeDelete': {
            if (!okString(raw.nodeId, LIMITS.ID) || isUnsafeKey(raw.nodeId)) return bad('bad-node-id');
            return { ok: true, kind: k, counter: opId.counter, changed: false, op: { ...base, nodeId: raw.nodeId } };
        }

        case 'propSet': {
            if (!okString(raw.nodeId, LIMITS.ID) || isUnsafeKey(raw.nodeId)) return bad('bad-node-id');
            if (!okKey(raw.key)) return bad('bad-key');
            const value = cleanValueEx(raw.value, raw.key);
            if (value.value === undefined) return bad('bad-value');
            return {
                ok: true, kind: k, counter: opId.counter, changed: value.changed,
                op: { ...base, nodeId: raw.nodeId, key: raw.key, value: value.value },
            };
        }

        case 'propDelete': {
            if (!okString(raw.nodeId, LIMITS.ID) || isUnsafeKey(raw.nodeId)) return bad('bad-node-id');
            if (!okKey(raw.key)) return bad('bad-key');
            return { ok: true, kind: k, counter: opId.counter, changed: false, op: { ...base, nodeId: raw.nodeId, key: raw.key } };
        }

        case 'textInsert': {
            if (!okString(raw.nodeId, LIMITS.ID) || isUnsafeKey(raw.nodeId)) return bad('bad-node-id');
            if (!okKey(raw.field)) return bad('bad-key');
            const left = readSide(raw.left);
            const right = readSide(raw.right);
            if (!left.ok || !right.ok) return bad('bad-position');
            const atom = cleanAtom(raw.atom);
            if (!atom) return bad('bad-atom');
            return {
                ok: true, kind: k, counter: opId.counter, changed: false,
                op: { ...base, nodeId: raw.nodeId, field: raw.field, left: left.value, right: right.value, atom },
            };
        }

        case 'textDelete': {
            if (!okString(raw.nodeId, LIMITS.ID) || isUnsafeKey(raw.nodeId)) return bad('bad-node-id');
            if (!okKey(raw.field)) return bad('bad-key');
            if (!okPosRef(raw.pos)) return bad('bad-position');
            return { ok: true, kind: k, counter: opId.counter, changed: false, op: { ...base, nodeId: raw.nodeId, field: raw.field, pos: raw.pos } };
        }

        case 'markSet': {
            if (!okString(raw.nodeId, LIMITS.ID) || isUnsafeKey(raw.nodeId)) return bad('bad-node-id');
            if (!okKey(raw.field)) return bad('bad-key');
            if (!okPosRef(raw.pos)) return bad('bad-position');
            if (typeof raw.mark !== 'string' || !MARK_NAMES.has(raw.mark)) return bad('bad-mark');
            let value: any;
            let changed = false;
            if (raw.mark === 'link') {
                // `null` = quitar el enlace. Cualquier otra cosa debe ser un LinkAttrs saneado.
                if (raw.value === null) value = null;
                else if (isPlainObject(raw.value) && typeof raw.value.href === 'string' && raw.value.href.length <= LIMITS.STRING) {
                    const href = safePuckUrl(raw.value.href);
                    changed = href !== raw.value.href;
                    value = { href, newTab: raw.value.newTab === true };
                } else return bad('bad-mark');
            } else {
                if (typeof raw.value !== 'boolean') return bad('bad-mark');
                value = raw.value;
            }
            return {
                ok: true, kind: k, counter: opId.counter, changed,
                op: { ...base, nodeId: raw.nodeId, field: raw.field, pos: raw.pos, mark: raw.mark, value },
            };
        }

        case 'shapeSet': {
            const key = raw.key;
            if (typeof key !== 'string' || key.length > LIMITS.KEY) return bad('bad-shape-key');
            const known = SHAPE_SCALARS.has(key) || key.startsWith('extras:') || key.startsWith('orphanZones:');
            if (!known) return bad('bad-shape-key');
            if (key.startsWith('extras:') || key.startsWith('orphanZones:')) {
                const sub = key.slice(key.indexOf(':') + 1);
                if (!okKey(sub)) return bad('bad-shape-key');
            }
            const value = cleanValueEx(raw.value, null);
            if (value.value === undefined) return bad('bad-value');
            return { ok: true, kind: k, counter: opId.counter, changed: value.changed, op: { ...base, key, value: value.value } };
        }
    }

    /* c8 ignore next */
    return bad('unknown-kind');
}

/**
 * Valida un FRAME entero (la traducción de una transacción del editor). Devuelve las ops limpias y
 * el detalle de las rechazadas: el emisor tiene que poder enterarse de que algo suyo no pasó, en
 * vez de descubrirlo releyendo su documento.
 *
 * Una op rechazada NO tumba el frame: las ops de un CRDT convergen por separado, así que descartar
 * la mala y aceptar las buenas es correcto y además evita que un bug de una op cancele la escritura
 * entera de un usuario. Lo que sí tumba el frame es pasarse del tope de ops.
 */
function validateFrame(rawOps: any, siteId: string): {
    ok: boolean;
    code?: OpRejectCode;
    ops: any[];
    /** Índice de cada op ACEPTADA dentro del array que mandó el cliente (las rechazadas dejan hueco). */
    srcIndex: number[];
    /** Paralelo a `ops`: el saneado reescribió algo de esa op. */
    changed: boolean[];
    rejected: { index: number; code: OpRejectCode }[];
} {
    const empty = { ops: [] as any[], srcIndex: [] as number[], changed: [] as boolean[], rejected: [] as { index: number; code: OpRejectCode }[] };
    if (!Array.isArray(rawOps)) return { ok: false, code: 'not-an-object', ...empty };
    if (rawOps.length > LIMITS.OPS_PER_FRAME) return { ok: false, code: 'too-large', ...empty };
    const ops: any[] = [];
    const srcIndex: number[] = [];
    const changed: boolean[] = [];
    const rejected: { index: number; code: OpRejectCode }[] = [];
    for (let i = 0; i < rawOps.length; i++) {
        const r = validateOp(rawOps[i], siteId);
        if (r.ok) { ops.push(r.op); srcIndex.push(i); changed.push(r.changed); }
        else rejected.push({ index: i, code: r.code });
    }
    return { ok: true, ops, srcIndex, changed, rejected };
}

/**
 * Version vector saneado: `{ siteId: counter }`. Llega del cliente en el `resync`, así que también
 * es dato hostil — un VV con 10⁶ entradas sería un vector de agotamiento de CPU en el filtrado.
 */
function sanitizeVersionVector(raw: any, maxSites = 256): Record<string, number> {
    // SIN PROTOTIPO, y aquí no es transitorio: este objeto se consulta tal cual en el filtro del
    // `resync` (`vvCovers`). Con `{}`, un `Object.prototype` envenenado por CUALQUIER otro punto del
    // proceso haría que el vector "contuviera" sitios que el cliente nunca declaró, y el filtro
    // dejaría fuera ops que sí le faltan: pérdida silenciosa de trabajo ajeno al reanudar.
    const out: Record<string, number> = Object.create(null);
    if (!isPlainObject(raw)) return out;
    let n = 0;
    // `Object.entries` = solo propias y enumerables: nada heredado entra al vector.
    for (const [site, counter] of Object.entries(raw)) {
        if (n++ >= maxSites) break;
        if (!okString(site, LIMITS.ID) || isUnsafeKey(site)) continue;
        if (!okCounter(counter)) continue;
        setOwn(out, site, counter as number);
    }
    return out;
}

/**
 * ¿El VV ya cubre este dot? (dedup e idempotencia del `resync`).
 *
 * `Object.hasOwn` ANTES de leer, siempre: la pregunta es "¿lo declaró el cliente?", no "¿sale algo al
 * leerlo?". Sin ella, un `Object.prototype` con `toString` numérico —o cualquier clave heredada—
 * respondería que sí a un sitio que nadie mencionó.
 */
function vvCovers(vv: Record<string, number>, site: string, counter: number): boolean {
    return Object.hasOwn(vv, site) && vv[site] >= counter;
}

/**
 * `setOwn` y `cloneJson` se exponen SOLO para poder falsearlos, igual que `_sseWrite` en
 * `routes/collab.ts` y por el mismo motivo.
 *
 * Son DOS DE LOS TRES PILARES con los que se descartaron #689/#690/#691 —destino sin prototipo,
 * definición de propiedad de datos y `Object.hasOwn` en la única lectura del version vector— y desde
 * fuera son INVISIBLES: con destinos sin prototipo, `setOwn` y `obj[k]=v` se comportan igual, y el
 * valor que devuelve `cloneJson` lo reconstruye después `sanitizePuckTree` sobre un `{}` normal. O
 * sea: ninguno de los dos puede tener un rojo de caja negra, y sin esta puerta se quedaban como
 * "defensa en profundidad que nadie falsea", que es la que desaparece en el siguiente refactor —
 * dejando la seguridad colgando otra vez de una LISTA DE NOMBRES, que es el modelo que ya le costó
 * caro a este proyecto en los permisos de plugins.
 *
 * Lo que se prueba a través de ellos es su CONTRATO, no un exploit: que escribir bajo una clave
 * remota no pueda despertar un accesor heredado, y que el objeto que se construye no herede nada.
 */
module.exports = { validateOp, validateFrame, sanitizeVersionVector, vvCovers, LIMITS, setOwn, cloneJson };
