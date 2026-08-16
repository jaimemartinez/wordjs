/**
 * POST /api/v1/themes/upload — DONDE vive el fichero temporal, y quien prueba que vive ahi.
 *
 * QUE FIJA ESTE FICHERO. Ocho alertas js/path-injection colgaban de `zipPath` en routes/themes.ts:
 * el sumidero es `fs.unlinkSync(zipPath)` (siete salidas del handler mas la del catch) y `zipPath`
 * era `req.file.path` sin mas. Empiricamente NO eran explotables — multer con almacenamiento en
 * disco compone la ruta como `<dest>/<32 hex aleatorios>` y el `originalname` del atacante no aporta
 * ni un byte — pero el analizador no puede verlo, y la contencion que si teniamos vivia en helpers
 * (core/safe-path) DE OTRO MODULO. Ese es el punto entero:
 *
 *   los barriers de rutas contaminadas son INTRAPROCEDURALES. Una prueba de contencion escrita en
 *   otra funcion no apaga el sumidero del llamante, por correcta que sea.
 *
 * Asi que la prueba se escribio INLINE en el handler (resolucion canonica + prefijo con separador),
 * y ademas el `dest` de multer paso de la cadena relativa 'os-tmp/' a una base ABSOLUTA resuelta una
 * sola vez al cargar el modulo. Eso ultimo no es cosmetico y es lo que mide el primer test: con un
 * `dest` relativo, el directorio de trabajo lo elegia el cwd DE LA PETICION.
 *
 * Contra el codigo anterior: "el temporal cae en la base absoluta" y los dos tests estructurales van
 * en ROJO; los controles de subida van en verde a ambos lados.
 *
 * Orden del sandbox de CWD copiado de theme-upload-identity.test.ts: hay que chdir ANTES de requerir
 * nada que resuelva rutas desde el cwd al cargar (THEMES_DIR = path.resolve('./themes')).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox del cwd PRIMERO.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-theme-scratch-'));
fs.mkdirSync(path.join(TMP_ROOT, 'themes'), { recursive: true });
process.chdir(TMP_ROOT);

// 2. Base de datos a un fichero temporal ANTES de que carguen la capa de DB y los routers.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

const THEMES_DIR = path.join(TMP_ROOT, 'themes');
const ZIP_DIR = path.join(TMP_ROOT, 'zips');

const SRC_DIR = path.resolve(__dirname, '..');
const readSrc = (rel: string) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');

/**
 * Fuente sin lineas de comentario. Las aserciones de "no puede aparecer" describen lo que hace el
 * CODIGO, y el arreglo lleva comentarios que CITAN el patron que se elimino — un escaneo del texto
 * crudo fallaria sobre la propia prosa que lo explica.
 */
const codeOnly = (src: string) => src
    .split('\n')
    .map((l: string) => l.replace(/\r$/, ''))
    .filter((l: string) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
    .join('\n');

describe('POST /themes/upload — el zip temporal esta contenido, y la prueba vive en el handler', () => {
    let request: any;
    let app: any;
    let themeRoutes: any;
    let adminToken: string;
    const asAdmin = (r: any) => r.set('Authorization', `Bearer ${adminToken}`);

    /** Construye un zip en disco y devuelve su ruta. `entries` es {entryName: contenido}. */
    const makeZip = (fileName: string, entries: Record<string, string>): string => {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        for (const [name, body] of Object.entries(entries)) zip.addFile(name, Buffer.from(body));
        fs.mkdirSync(ZIP_DIR, { recursive: true });
        const p = path.join(ZIP_DIR, fileName);
        zip.writeZip(p);
        return p;
    };

    const themeEntries = (root: string, marker: string) => ({
        [`${root}/theme.json`]: JSON.stringify({ name: root, version: '1.0.0' }),
        [`${root}/style.css`]: `/* ${marker} */\n`,
    });

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        const dbAsync = database.getDbAsync();
        await dbAsync.run('INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
            ['admin', 'x', 'admin@example.com', 'Administrator']);
        const admin = await dbAsync.get("SELECT id FROM users WHERE user_login = 'admin'");
        await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, ?, ?)", [admin.id, 'role', 'administrator']);
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        themeRoutes = require('../routes/themes');
        app = express();
        app.use(express.json({ limit: '2mb' }));
        app.use('/api/v1/themes', themeRoutes);
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('la base de contencion es absoluta y se resuelve UNA vez, junto a THEMES_DIR', () => {
        assert.strictEqual(themeRoutes.OS_TMP_DIR, path.join(TMP_ROOT, 'os-tmp'));
        assert.ok(path.isAbsolute(themeRoutes.OS_TMP_DIR));
    });

    it('una subida normal instala el tema y consume su temporal (el control)', async () => {
        const zip = makeZip('tidy.zip', themeEntries('tidy', 'original'));
        const res = await asAdmin(request(app).post('/api/v1/themes/upload')).attach('theme', zip);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.ok(fs.existsSync(path.join(THEMES_DIR, 'tidy', 'theme.json')));
        const leftovers = fs.existsSync(themeRoutes.OS_TMP_DIR) ? fs.readdirSync(themeRoutes.OS_TMP_DIR) : [];
        assert.deepStrictEqual(leftovers, [], 'el zip temporal se borra tras instalar');
    });

    it('el temporal cae en la base ABSOLUTA aunque el proceso cambie de cwd', async () => {
        // ANTES: `dest: 'os-tmp/'` era una cadena relativa que multer reinterpretaba contra el cwd DE
        // LA PETICION, y `req.file.path` salia relativo. El "directorio de trabajo" era el mismo sitio
        // que el que cuelga de THEMES_DIR solo mientras nadie llamase a process.chdir(): con otro cwd,
        // el zip aterrizaba —y se borraba— en <cwd>/os-tmp, fuera de la unica base que el handler
        // conoce. AHORA la base es absoluta, asi que el temporal siempre cae donde se prueba.
        const elsewhere = path.join(TMP_ROOT, 'elsewhere');
        fs.mkdirSync(elsewhere, { recursive: true });
        const zip = makeZip('cwd-proof.zip', themeEntries('cwd-proof', 'x'));
        process.chdir(elsewhere);
        try {
            const res = await asAdmin(request(app).post('/api/v1/themes/upload')).attach('theme', zip);
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        } finally {
            process.chdir(TMP_ROOT);
        }
        assert.strictEqual(fs.existsSync(path.join(elsewhere, 'os-tmp')), false,
            'el temporal no puede aterrizar en un os-tmp relativo al cwd de la peticion');
        assert.ok(fs.existsSync(path.join(THEMES_DIR, 'cwd-proof', 'theme.json')),
            'y la instalacion sigue funcionando igual');
    });

    it('la contencion esta ESCRITA en el handler de /upload, no delegada a un helper', () => {
        const src = codeOnly(readSrc('routes/themes.ts'));
        // Base absoluta resuelta una vez a nivel de modulo, y multer escribiendo EN ELLA.
        assert.match(src, /const OS_TMP_DIR = path\.resolve\(THEMES_DIR, '\.\.', 'os-tmp'\);/);
        assert.match(src, /dest: OS_TMP_DIR,/);
        // Resolucion canonica + prefijo CON separador, dentro del propio handler: esto es lo que apaga
        // las ocho alertas. Sacarlo a una utilidad las reabre — el barrier no cruza funciones.
        assert.match(src, /const zipPath = path\.resolve\(uploadedPath\);/);
        assert.match(src, /if \(!zipPath\.startsWith\(OS_TMP_DIR \+ path\.sep\)\) \{/);
        // Y el valor crudo de la peticion no vuelve a alimentar una operacion de fichero.
        assert.doesNotMatch(src, /const zipPath = req\.file\.path/);
        assert.doesNotMatch(src, /fs\.\w+\(req\.file\.path/);
        // El almacenamiento sigue siendo EN DISCO: memoryStorage cargaria temas enteros en RAM.
        assert.doesNotMatch(src, /memoryStorage/);
    });

    it('la contencion se prueba ANTES del primer borrado del temporal', () => {
        const src = codeOnly(readSrc('routes/themes.ts'));
        const guardAt = src.indexOf('if (!zipPath.startsWith(OS_TMP_DIR + path.sep))');
        const firstSink = src.indexOf('fs.unlinkSync(zipPath)');
        assert.ok(guardAt > -1, 'la contencion tiene que estar en el fichero');
        assert.ok(firstSink > guardAt, 'nada se borra antes de haber probado donde esta');
    });
});
