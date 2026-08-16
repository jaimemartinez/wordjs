/**
 * GUARD DE URLs DE MENÚ — contrabando de autoridad relativa (open redirect almacenado).
 *
 * `safeMenuUrl` (routes/menus.ts) es la ÚNICA defensa: los consumidores del menú pintan
 * `<Link href={item.url}>` sin revalidar (Footer.tsx, ChromeNav.tsx, ChromeNavMobile.tsx), así que
 * lo que se guarda es literalmente lo que navega el visitante.
 *
 * Los dos agujeros que fija esta suite, ambos verificados contra el parser WHATWG real:
 *   · `/\evil.example`   — para un esquema especial el parser trata `\` igual que `/`, así que esto
 *                          es authority-relative (externo). El guard sólo miraba `//` y lo aceptaba.
 *                          No necesita ni un carácter de control.
 *   · `/<TAB>/evil.example` — el parser BORRA tabulador, LF y CR ANTES de parsear, de modo que el
 *                          guard validaba una cadena que el navegador nunca llega a ver.
 *
 * El control positivo importa tanto como el negativo: si las rutas legítimas dejaran de guardarse,
 * un 'todo bloqueado' pasaría por 'seguro'.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-menuurl-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const SECRET = config.jwt.secret;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));

let adminId = 0;
let menuId = 0;
const asAdmin = (m: string, p: string) =>
    (request(app) as any)[m](`/api/v1${p}`).set(
        'Authorization',
        `Bearer ${jwt.sign({ userId: adminId, username: 'admin' }, SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`,
    );

/** Crea un ítem y devuelve la url TAL COMO QUEDÓ PERSISTIDA. */
async function urlGuardada(url: unknown): Promise<string> {
    const res = await asAdmin('post', `/menus/${menuId}/items`).send({ title: 'x', url });
    assert.strictEqual(res.status, 201, `alta del ítem: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.url;
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    const dbAsync = database.getDbAsync();
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('admin', 'x', 'a@example.com', 'admin')`,
    );
    adminId = r.lastID;
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [adminId]);
    await roles.loadRoles();

    const menu = await asAdmin('post', '/menus').send({ name: 'Principal', slug: `principal-${process.pid}` });
    assert.strictEqual(menu.status, 201, `alta del menú: ${menu.status} ${JSON.stringify(menu.body)}`);
    menuId = menu.body.id;
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* */ }
    }
});

describe('safeMenuUrl — autoridad relativa y caracteres de control', () => {
    test('CONTROL POSITIVO: las formas legítimas se guardan intactas', async () => {
        for (const ok of ['/contacto', '/blog/2026/post', '#seccion', '?filtro=1', 'https://ejemplo.test/x', 'mailto:a@b.test', 'tel:+34600000000']) {
            assert.strictEqual(await urlGuardada(ok), ok, `debería guardarse tal cual: ${ok}`);
        }
    });

    test('la barra invertida NO abre una autoridad: /\\host es externo y se neutraliza', async () => {
        // Sin ningún carácter de control: esta era la grafía que el guard dejaba pasar entera.
        assert.strictEqual(await urlGuardada('/\\evil.example/pwn'), '#');
        assert.strictEqual(await urlGuardada('//evil.example/pwn'), '#');
    });

    test('los caracteres que el parser BORRA no pueden colar una autoridad', async () => {
        for (const raw of ['/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/\r\n/evil.example', '/\t\\evil.example']) {
            assert.strictEqual(await urlGuardada(raw), '#', `debería neutralizarse: ${JSON.stringify(raw)}`);
        }
    });

    test('lo que se guarda ya viene limpio: una ruta legítima pierde los caracteres borrados', async () => {
        // No basta con aceptarla: si se guardara con el tabulador dentro, el navegador resolvería otra
        // cosa que la validada. Lo persistido tiene que ser exactamente lo que se comprobó.
        assert.strictEqual(await urlGuardada('/con\ttacto'), '/contacto');
    });

    test('los esquemas ejecutables siguen neutralizados (no hay regresión del XSS original)', async () => {
        for (const raw of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)']) {
            assert.strictEqual(await urlGuardada(raw), '#', `debería neutralizarse: ${raw}`);
        }
    });

    test('PUT aplica el mismo guard que POST (la mitad que se olvida)', async () => {
        const creado = await asAdmin('post', `/menus/${menuId}/items`).send({ title: 'x', url: '/inicio' });
        assert.strictEqual(creado.status, 201);
        const upd = await asAdmin('put', `/menus/items/${creado.body.id}`).send({ url: '/\\evil.example/pwn' });
        assert.strictEqual(upd.status, 200, `actualización: ${upd.status} ${JSON.stringify(upd.body)}`);
        assert.strictEqual(upd.body.url, '#');
    });
});
