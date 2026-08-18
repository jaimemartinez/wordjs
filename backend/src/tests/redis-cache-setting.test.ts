/**
 * `redis_cache_enabled` (y su vecino `require_email_verification`) a través de las rutas de ajustes.
 *
 * Lo que se arregla y se fija aquí es un interruptor INERTE EN LAS DOS DIRECCIONES. La opción estaba
 * seeded (core/options), se aplicaba al escribirla (updateOption → cache.setEnabled), se releía en
 * cada arranque (initCacheSetting) y en cada nodo del clúster (core/coherence), y la pantalla de
 * ajustes pintaba un interruptor de verdad para ella… pero la clave no estaba en ALL_SETTINGS, así
 * que GET /settings/all no la devolvía (el interruptor se pintaba siempre apagado) y PUT la
 * descartaba en silencio (encenderlo no encendía nada). Un fallo así no da ningún error: la caché
 * simplemente nunca se enciende, y quien mira la pantalla cree que sí.
 *
 * Y una segunda trampa, asimétrica, que solo se ve al REINICIAR: `cache.setEnabled` acepta
 * exactamente `1`, `'1'` y `true`. Guardar un `true` de JSON enciende la caché en caliente pero deja
 * la cadena `"true"` en la tabla, que en el siguiente arranque resuelve a APAGADO. Por eso el valor
 * se normaliza a '1'/'0' antes de escribir, y eso es lo que se comprueba: lo ALMACENADO, no solo el
 * 200 de la respuesta.
 *
 * Mismo orden de sandbox por CWD que el resto de esta carpeta: chdir ANTES de requerir nada.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-rediscache-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

describe('redis_cache_enabled / require_email_verification (settings contract)', () => {
    let request: any;
    let app: any;
    let dbAsync: any;
    let adminToken: string;

    const asAdmin = (r: any) => r.set('Authorization', `Bearer ${adminToken}`);
    /**
     * El valor tal y como queda EN LA TABLA. Deliberadamente crudo, sin pasar por getOption: lo que
     * importa de la normalización es el texto almacenado, que es lo que releerá el próximo arranque.
     */
    const optionValue = async (name: string) => {
        const row = await dbAsync.get('SELECT option_value FROM options WHERE option_name = ?', [name]);
        return row ? row.option_value : undefined;
    };
    // Las LECTURAS de la API pasan por getOption, que hace JSON.parse: el '1' de la tabla sale como
    // número 1 (y así llega al setEnabled del arranque, que acepta 1). Es el comportamiento de SIEMPRE
    // de todas las opciones numéricas, no algo propio de esta clave; se fija para que quede dicho.
    const READ_ON = 1;
    const READ_OFF = 0;

    before(async () => {
        request = require('supertest');

        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        dbAsync = database.getDbAsync();
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
            ['admin', 'x', 'admin@example.com', 'Administrator']
        );
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        await dbAsync.run(
            `INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`,
            [admin.id]
        );
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json({ limit: '1mb' }));
        app.use('/api/v1/settings', require('../routes/settings'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('round-trips through PUT /settings → GET /settings/all, in BOTH directions', async () => {
        // ENCENDER. El fallo original devolvía 200 con un cuerpo VACÍO aquí: la clave se descartaba
        // sin decir nada, así que hay que mirar el cuerpo, no solo el status.
        const on = await asAdmin(request(app).put('/api/v1/settings')).send({ redis_cache_enabled: '1' });
        assert.strictEqual(on.status, 200);
        assert.strictEqual(on.body.redis_cache_enabled, '1', 'PUT must ACCEPT the key, not silently drop it');
        assert.strictEqual(await optionValue('redis_cache_enabled'), '1');

        let all = await asAdmin(request(app).get('/api/v1/settings/all'));
        assert.strictEqual(all.status, 200);
        assert.ok(
            Object.prototype.hasOwnProperty.call(all.body, 'redis_cache_enabled'),
            'GET /settings/all must RETURN the key — without it the toggle always renders "off"'
        );
        assert.strictEqual(all.body.redis_cache_enabled, READ_ON);

        // APAGAR. La otra dirección estaba igual de rota, y es la que más duele: creer que se apagó
        // una caché compartida que sigue sirviendo páginas viejas.
        const off = await asAdmin(request(app).put('/api/v1/settings')).send({ redis_cache_enabled: '0' });
        assert.strictEqual(off.status, 200);
        assert.strictEqual(off.body.redis_cache_enabled, '0');
        assert.strictEqual(await optionValue('redis_cache_enabled'), '0');

        all = await asAdmin(request(app).get('/api/v1/settings/all'));
        assert.strictEqual(all.body.redis_cache_enabled, READ_OFF);
    });

    it('round-trips through the SINGLE-key PUT /settings/:key too', async () => {
        const res = await asAdmin(request(app).put('/api/v1/settings/redis_cache_enabled')).send({ value: '1' });
        assert.strictEqual(res.status, 200, 'the single-key writer rejected it as an unknown setting');
        assert.strictEqual(res.body.value, READ_ON);
        assert.strictEqual(await optionValue('redis_cache_enabled'), '1');
    });

    it('NORMALIZES every boolean-ish spelling to the "1"/"0" that cache.setEnabled understands', async () => {
        // cache.setEnabled (core/cache) reconoce EXACTAMENTE 1, '1' y true. Guardar cualquier otro
        // "sí" ('true', 'on', 'yes') dejaría en la tabla un valor que el SIGUIENTE ARRANQUE lee como
        // apagado — el interruptor diría encendido y la caché estaría muerta. Por eso se canoniza.
        const truthy: any[] = ['1', 1, true, 'true', 'TRUE', 'on', 'yes', ' 1 '];
        for (const value of truthy) {
            await asAdmin(request(app).put('/api/v1/settings/redis_cache_enabled')).send({ value: '0' });
            const res = await asAdmin(request(app).put('/api/v1/settings/redis_cache_enabled')).send({ value });
            assert.strictEqual(res.status, 200, `${JSON.stringify(value)} should be accepted, got ${res.status}`);
            assert.strictEqual(
                await optionValue('redis_cache_enabled'), '1',
                `${JSON.stringify(value)} must be STORED as "1" — anything else reads as OFF on the next boot`
            );
        }

        const falsy: any[] = ['0', 0, false, 'false', 'off', 'no', '', null];
        for (const value of falsy) {
            await asAdmin(request(app).put('/api/v1/settings/redis_cache_enabled')).send({ value: '1' });
            const res = await asAdmin(request(app).put('/api/v1/settings/redis_cache_enabled')).send({ value });
            assert.strictEqual(res.status, 200, `${JSON.stringify(value)} should be accepted, got ${res.status}`);
            assert.strictEqual(
                await optionValue('redis_cache_enabled'), '0',
                `${JSON.stringify(value)} must be STORED as "0"`
            );
        }

        // El cuerpo de la respuesta bulk devuelve lo ALMACENADO, no lo recibido: es lo que el cliente
        // usa para repintar el interruptor, y decirle otra cosa es cómo acaba mintiendo.
        const bulk = await asAdmin(request(app).put('/api/v1/settings')).send({ redis_cache_enabled: true });
        assert.strictEqual(bulk.body.redis_cache_enabled, '1');
    });

    it('rejects a non-boolean with 400 and leaves the option untouched', async () => {
        await asAdmin(request(app).put('/api/v1/settings/redis_cache_enabled')).send({ value: '1' });
        assert.strictEqual(await optionValue('redis_cache_enabled'), '1');

        const hostile = [
            'enabled',                 // sinónimo razonable que NO está en la lista
            '2',
            'redis://attacker:6379',   // no es un destino: es un interruptor
            ['1'],
            { value: '1' },
        ];
        for (const value of hostile) {
            const res = await asAdmin(request(app).put('/api/v1/settings/redis_cache_enabled')).send({ value });
            assert.strictEqual(res.status, 400, `${JSON.stringify(value)} must be rejected, got ${res.status}`);
            assert.strictEqual(
                await optionValue('redis_cache_enabled'), '1',
                'a rejected write must not have touched the stored value'
            );
        }

        // Y en el bulk, el rechazo es de TODO el payload: nada a medias.
        const bulk = await asAdmin(request(app).put('/api/v1/settings'))
            .send({ blogname: 'Sitio nuevo', redis_cache_enabled: 'enabled' });
        assert.strictEqual(bulk.status, 400);
        assert.notStrictEqual(await optionValue('blogname'), 'Sitio nuevo');
    });

    it('is ADMIN-ONLY: never on the anonymous read, and not writable without a session', async () => {
        const publicRes = await request(app).get('/api/v1/settings');
        assert.strictEqual(publicRes.status, 200);
        assert.ok(
            !Object.prototype.hasOwnProperty.call(publicRes.body, 'redis_cache_enabled'),
            'infrastructure posture must not ride the public settings payload'
        );
        // El lector de una sola clave también cierra: no es PUBLIC_SETTINGS.
        const single = await request(app).get('/api/v1/settings/redis_cache_enabled');
        assert.strictEqual(single.status, 403);

        const anon = await request(app).put('/api/v1/settings').send({ redis_cache_enabled: '1' });
        assert.ok(anon.status === 401 || anon.status === 403, `anonymous write must be refused, got ${anon.status}`);
    });

    it('require_email_verification is readable AND writable through the same routes', async () => {
        // La auditoría decía que esta clave YA estaba en ALL_SETTINGS. Se comprueba en vez de creerse,
        // porque es exactamente el mismo modo de fallo silencioso: la pantalla ofrece el ajuste, el
        // backend lo descarta, y nadie se entera hasta que alguien se registra sin verificar nada.
        const res = await asAdmin(request(app).put('/api/v1/settings')).send({ require_email_verification: '1' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.require_email_verification, '1', 'PUT dropped the key');
        assert.strictEqual(await optionValue('require_email_verification'), '1');

        const all = await asAdmin(request(app).get('/api/v1/settings/all'));
        assert.strictEqual(all.body.require_email_verification, READ_ON);

        const off = await asAdmin(request(app).put('/api/v1/settings/require_email_verification')).send({ value: '0' });
        assert.strictEqual(off.status, 200);
        assert.strictEqual(await optionValue('require_email_verification'), '0');

        // Sigue siendo admin-only: quién debe verificar su correo no es asunto del visitante.
        const publicRes = await request(app).get('/api/v1/settings');
        assert.ok(!Object.prototype.hasOwnProperty.call(publicRes.body, 'require_email_verification'));
    });
});
