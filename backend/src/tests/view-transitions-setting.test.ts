/**
 * C1 — el ajuste `wjs_view_transitions` (transiciones entre páginas), en el lado del servidor.
 *
 * Tres cosas que ningún test cubría y que, si se rompen, fallan EN SILENCIO:
 *
 *  1. Es PÚBLICO. El layout público lo lee en el servidor para emitir el CSS, y la variante entre
 *     documentos exige la regla en el documento que sale Y en el que entra. Si deja de ser público,
 *     el sitio simplemente no transiciona y no hay error en ninguna parte.
 *  2. La escritura es de VOCABULARIO CERRADO y fail-closed: el valor elige entre variantes ya
 *     escritas en código, así que cualquier otra cosa se rechaza con 400 — y el test comprueba el
 *     ESPACIO NEGATIVO: tras el 400, la opción sigue valiendo lo de antes.
 *  3. Cambiarlo purga la caché del frontend. Sin esa purga, encenderlo dejaría medio sitio con la
 *     regla y medio sin ella (es decir: sin transición y sin explicación).
 *
 * Mismo orden de sandbox por CWD que document-language.test.ts: chdir a un raíz temporal ANTES de
 * requerir nada que resuelva rutas desde el CWD al cargarse.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-vt-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

describe('wjs_view_transitions (settings contract)', () => {
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

    it('is exposed on the ANONYMOUS read — the public layout compiles its CSS on the server', async () => {
        await asAdmin(request(app).put('/api/v1/settings')).send({ wjs_view_transitions: 'fade' });
        const res = await request(app).get('/api/v1/settings');
        assert.strictEqual(res.status, 200);
        assert.ok(
            Object.prototype.hasOwnProperty.call(res.body, 'wjs_view_transitions'),
            'wjs_view_transitions must be public — without it the site silently stops transitioning'
        );
        assert.strictEqual(res.body.wjs_view_transitions, 'fade');
    });

    it('accepts exactly the closed vocabulary, plus the empty "off" sentinel', async () => {
        for (const value of ['off', 'fade', 'slide', '']) {
            const res = await asAdmin(request(app).put('/api/v1/settings/wjs_view_transitions')).send({ value });
            assert.strictEqual(res.status, 200, `${JSON.stringify(value)} should be accepted, got ${res.status}`);
            assert.strictEqual(await optionValue('wjs_view_transitions'), value);
        }
        // null ≡ unset ≡ '' — las opciones nunca persisten el texto "null" (core/options updateOption).
        const res = await asAdmin(request(app).put('/api/v1/settings/wjs_view_transitions')).send({ value: null });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await optionValue('wjs_view_transitions'), '');
    });

    it('rejects anything else with 400 and leaves the option untouched', async () => {
        await asAdmin(request(app).put('/api/v1/settings/wjs_view_transitions')).send({ value: 'slide' });
        assert.strictEqual(await optionValue('wjs_view_transitions'), 'slide');

        const hostile = [
            'FADE',                                   // el vocabulario es exacto, no case-insensitive
            'auto',                                   // valor de OTRO ajuste (site_text_direction)
            'fade;}body{display:none}',               // fuga de CSS: el valor viaja a una hoja
            '</style><script>alert(1)</script>',      // inyección de marcado
            'navigation:auto',
            'slide ',                                 // espacio final
            42,
            true,
            ['fade'],
            { value: 'fade' },
        ];
        for (const value of hostile) {
            const res = await asAdmin(request(app).put('/api/v1/settings/wjs_view_transitions')).send({ value });
            assert.strictEqual(res.status, 400, `${JSON.stringify(value)} must be rejected, got ${res.status}`);
            assert.strictEqual(
                await optionValue('wjs_view_transitions'),
                'slide',
                `${JSON.stringify(value)} was rejected but the option changed anyway`
            );
        }
    });

    it('is wired into the frontend cache purge — otherwise half the site keeps the old rule', () => {
        const purge = fs.readFileSync(path.join(__dirname, '..', 'core', 'frontend-purge.ts'), 'utf8');
        const set = purge.slice(purge.indexOf('const SETTINGS_OPTIONS'), purge.indexOf('])', purge.indexOf('const SETTINGS_OPTIONS')));
        assert.ok(set.includes("'wjs_view_transitions'"), 'wjs_view_transitions must purge the public pages when it changes');
    });
});
