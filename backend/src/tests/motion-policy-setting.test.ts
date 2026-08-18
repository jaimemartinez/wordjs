/**
 * C5 — el ajuste `wjs_motion` (política de movimiento del sitio), en el lado del servidor.
 *
 * Es la palanca que decide, POR ENCIMA de lo que ponga cada bloque, si el sitio se mueve como lo
 * dejaron sus autores (`full`), si nada se mueve en bucle (`calm`) o si no se emite ni una regla de
 * interacción (`off`). Lo que se fija aquí es lo que fallaría en silencio:
 *
 *  1. Es PÚBLICO: la página lo lee EN EL SERVIDOR al compilar sus interacciones. Si deja de serlo,
 *     el sitio vuelve a moverse entero y no hay ningún error en ninguna parte.
 *  2. Vocabulario CERRADO y fail-closed, con el espacio negativo comprobado: tras un 400, el ajuste
 *     sigue valiendo lo de antes.
 *  3. Purga la caché del frontend: sin ella, apagarlo dejaría media web quieta y media moviéndose.
 *
 * Mismo orden de sandbox por CWD que el resto de esta carpeta: chdir ANTES de requerir nada.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-motion-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

describe('wjs_motion (settings contract)', () => {
    let request: any;
    let app: any;
    let dbAsync: any;
    let adminToken: string;

    const asAdmin = (r: any) => r.set('Authorization', `Bearer ${adminToken}`);
    const optionValue = async (name: string) => {
        const row = await dbAsync.get('SELECT option_value FROM options WHERE option_name = ?', [name]);
        return row ? row.option_value : undefined;
    };

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

    it('is exposed on the ANONYMOUS read — the page compiles its motion on the server', async () => {
        await asAdmin(request(app).put('/api/v1/settings')).send({ wjs_motion: 'calm' });
        const res = await request(app).get('/api/v1/settings');
        assert.strictEqual(res.status, 200);
        assert.ok(
            Object.prototype.hasOwnProperty.call(res.body, 'wjs_motion'),
            'wjs_motion must be public — without it the site silently ignores the policy'
        );
        assert.strictEqual(res.body.wjs_motion, 'calm');
    });

    it('accepts exactly the closed vocabulary, plus the empty "default" sentinel', async () => {
        for (const value of ['full', 'calm', 'off', '']) {
            const res = await asAdmin(request(app).put('/api/v1/settings/wjs_motion')).send({ value });
            assert.strictEqual(res.status, 200, `${JSON.stringify(value)} should be accepted, got ${res.status}`);
            assert.strictEqual(await optionValue('wjs_motion'), value);
        }
        // null ≡ unset ≡ '' — las opciones nunca persisten el texto "null" (core/options updateOption).
        const res = await asAdmin(request(app).put('/api/v1/settings/wjs_motion')).send({ value: null });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await optionValue('wjs_motion'), '');
    });

    it('rejects anything else with 400 and leaves the option untouched', async () => {
        await asAdmin(request(app).put('/api/v1/settings/wjs_motion')).send({ value: 'off' });
        assert.strictEqual(await optionValue('wjs_motion'), 'off');

        const hostile = [
            'OFF',                                    // el vocabulario es exacto, no case-insensitive
            'none',                                   // sinónimo razonable que NO está en la lista
            'reduce',                                 // valor de OTRA cosa (prefers-reduced-motion)
            'calm;}body{display:none}',
            '</style><script>alert(1)</script>',
            'off ',                                   // espacio final
            0,
            false,
            ['off'],
            { value: 'off' },
        ];
        for (const value of hostile) {
            const res = await asAdmin(request(app).put('/api/v1/settings/wjs_motion')).send({ value });
            assert.strictEqual(res.status, 400, `${JSON.stringify(value)} must be rejected, got ${res.status}`);
            assert.strictEqual(
                await optionValue('wjs_motion'),
                'off',
                `${JSON.stringify(value)} was rejected but the option changed anyway`
            );
        }
    });

    it('is wired into the frontend cache purge — otherwise half the site keeps moving', () => {
        const purge = fs.readFileSync(path.join(__dirname, '..', 'core', 'frontend-purge.ts'), 'utf8');
        const set = purge.slice(purge.indexOf('const SETTINGS_OPTIONS'), purge.indexOf('])', purge.indexOf('const SETTINGS_OPTIONS')));
        assert.ok(set.includes("'wjs_motion'"), 'wjs_motion must purge the public pages when it changes');
    });
});
