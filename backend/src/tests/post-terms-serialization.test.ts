/**
 * TAXONOMÍA SERIALIZADA + los dos filtros que iban con ella (última milla P1).
 *
 * LA CAUSA RAÍZ que cierra este fichero: ninguna ruta devolvía los términos de un post
 * (`Post.toJSON` no los serializaba) y `Post.setTerms` REEMPLAZA. O sea que el editor no podía
 * sembrar un control de categoría/etiquetas, y cualquier control que mandase su valor habría BORRADO
 * en silencio los términos llegados por importación o por API. Aquí se fija el contrato observable:
 *
 *   • `toJSON` emite SIEMPRE `categories` y `tags` como `[{id,name,slug}]`, con `id` = term_id — que
 *     es exactamente lo que `setTerms` espera de vuelta;
 *   • un post SIN términos emite arrays vacíos (información), no claves ausentes (ambigüedad);
 *   • la ruta de LISTADO no degenera en N+1: `hydrateRelations` resuelve la taxonomía de la página
 *     entera en UNA consulta, y se comprueba CONTANDO las consultas que tocan `term_relationships`,
 *     no confiando en que la caché "parezca" llena. El control negativo (`findAll` sin hidratar)
 *     demuestra que el contador mide de verdad;
 *   • un extracto se puede VACIAR por la API (mandar '' borra la columna; omitir la clave no la toca);
 *   • `mime_type` filtra de verdad la biblioteca de medios, y el TOTAL del paginador va con el filtro.
 *
 * Mismo orden que las demás suites con supertest: CWD en un temporal y `config.dbPath` repuntado
 * ANTES de que carguen la capa de BD y los routers.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. CWD en un temporal (las escrituras incidentales no tocan el repo).
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-terms-json-'));
process.chdir(TMP_ROOT);

// 2. BD temporal ANTES de requerir la capa de BD / los routers.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');
const Post = require('../models/Post');

describe('taxonomía en toJSON, extracto vaciable y filtro MIME', () => {
    let request: any;
    let app: any;
    let dbAsync: any;
    let adminToken: string;
    let adminId: number;

    // Términos y posts compartidos por la suite (secuencial).
    let newsId: number, guidesId: number, reactId: number, astroId: number;
    let taggedPostId: number, barePostId: number;

    const as = (token: string) => (r: any) => r.set('Authorization', `Bearer ${token}`);

    /** Crea un término + su fila de taxonomía directamente (sin depender del modelo Term). */
    async function makeTerm(name: string, slug: string, taxonomy: string): Promise<number> {
        const t = await dbAsync.run('INSERT INTO terms (name, slug) VALUES (?, ?)', [name, slug]);
        await dbAsync.run(
            'INSERT INTO term_taxonomy (term_id, taxonomy, description, parent, count) VALUES (?, ?, ?, 0, 0)',
            [t.lastID, taxonomy, '']
        );
        return t.lastID;
    }

    /**
     * Cuenta las consultas que TOCAN la taxonomía mientras corre `fn`.
     *
     * Se parchea el DRIVER (no el proxy `dbAsync`, que resuelve el driver en cada acceso), así que
     * mide las consultas REALES que salen del modelo. Es lo único que distingue "una consulta para
     * toda la página" de "una por post": una aserción sobre la caché podría pasar aunque el camino
     * de respaldo se hubiese disparado igualmente.
     */
    async function withTermQueryCount<T>(fn: () => Promise<T>): Promise<{ result: T; termQueries: number }> {
        const driver = database.getDbAsync();
        const originalAll = driver.all;
        let termQueries = 0;
        driver.all = function patched(sql: any, ...rest: any[]) {
            if (String(sql).includes('term_relationships')) termQueries++;
            return originalAll.call(this, sql, ...rest);
        };
        try {
            const result = await fn();
            return { result, termQueries };
        } finally {
            driver.all = originalAll;
        }
    }

    /**
     * Lo mismo, para las consultas a `users`. `toJSON` dejó de emitir el `author_id` pelado y ahora
     * serializa la IDENTIDAD del autor, así que el listado tiene exactamente el mismo N+1 potencial
     * que tenía la taxonomía — y se mide igual: contando las consultas REALES que salen del modelo.
     */
    async function withUserQueryCount<T>(fn: () => Promise<T>): Promise<{ result: T; userQueries: number }> {
        const driver = database.getDbAsync();
        const originalAll = driver.all;
        let userQueries = 0;
        driver.all = function patched(sql: any, ...rest: any[]) {
            if (/FROM users\b/i.test(String(sql))) userQueries++;
            return originalAll.call(this, sql, ...rest);
        };
        try {
            const result = await fn();
            return { result, userQueries };
        } finally {
            driver.all = originalAll;
        }
    }

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
        // El gate de tipo del router (capsForType) resuelve contra el registro de tipos, que el boot
        // llena DESPUÉS de conectar la BD — sin esto cada create responde 400.
        await require('../core/post-types').initPostTypes();

        // user_nicename SEMBRADO A PROPÓSITO y distinto tanto del login como del nombre visible: es
        // la identidad PÚBLICA del autor, y el serializador debe leer esa columna y ninguna otra.
        await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name, user_nicename) VALUES (?, ?, ?, ?, ?)`,
            ['admin', 'x', 'admin@example.com', 'Administrator', 'administradora']
        );
        const row = await dbAsync.get(`SELECT id FROM users WHERE user_login = ?`, ['admin']);
        adminId = row.id;
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [adminId, 'administrator']);
        adminToken = jwt.sign({ userId: adminId, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        newsId = await makeTerm('Noticias', 'noticias', 'category');
        guidesId = await makeTerm('Guías', 'guias', 'category');
        reactId = await makeTerm('React', 'react', 'post_tag');
        astroId = await makeTerm('Astro', 'astro', 'post_tag');

        const tagged = await Post.create({ authorId: adminId, title: 'Con términos', content: 'Cuerpo', status: 'publish', type: 'post' });
        taggedPostId = tagged.id;
        await Post.setTerms(taggedPostId, [newsId, guidesId], 'category');
        await Post.setTerms(taggedPostId, [reactId, astroId], 'post_tag');

        const bare = await Post.create({ authorId: adminId, title: 'Sin términos', content: 'Cuerpo', status: 'publish', type: 'post' });
        barePostId = bare.id;

        const express = require('express');
        const cookieParser = require('cookie-parser');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json({ limit: '2mb' }));
        app.use(cookieParser());
        app.use('/api/v1/posts', require('../routes/posts'));
        app.use('/api/v1/media', require('../routes/media'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); } catch { /* ignore */ }
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    /* ---------------------------------------------------------------- */
    /* 1. La serialización.                                             */
    /* ---------------------------------------------------------------- */

    it('toJSON emite categories y tags con {id,name,slug} — el id es el term_id que setTerms espera', async () => {
        const post = await Post.findById(taggedPostId);
        const json = await post.toJSON();

        assert.deepStrictEqual(
            json.categories.map((c: any) => ({ id: c.id, name: c.name, slug: c.slug })).sort((a: any, b: any) => a.id - b.id),
            [{ id: newsId, name: 'Noticias', slug: 'noticias' }, { id: guidesId, name: 'Guías', slug: 'guias' }].sort((a, b) => a.id - b.id)
        );
        assert.deepStrictEqual(
            json.tags.map((t: any) => t.id).sort((a: number, b: number) => a - b),
            [reactId, astroId].sort((a, b) => a - b)
        );

        // Y el id serializado vale de verdad como entrada de setTerms (ida y vuelta completa).
        await Post.setTerms(taggedPostId, json.categories.map((c: any) => c.id), 'category');
        const again = await (await Post.findById(taggedPostId)).toJSON();
        assert.deepStrictEqual(
            again.categories.map((c: any) => c.id).sort((a: number, b: number) => a - b),
            [newsId, guidesId].sort((a, b) => a - b),
            'los ids que la API emite deben poder reenviarse tal cual'
        );
    });

    /**
     * EL AUTOR ES UN OBJETO, Y RESOLVERLO NO PUEDE VOLVER EL LISTADO UN N+1.
     *
     * `toJSON` emitía `author: this.authorId` — un NÚMERO pelado — mientras el contrato generado
     * (ContentRecord) lo declara como objeto desde F2: los tres consumidores que leen
     * `post.author?.displayName` (OpenGraph, JSON-LD y la portada) leían `undefined` SIEMPRE. Se
     * mueve el CÓDIGO al CONTRATO, no al revés.
     *
     * La segunda mitad es la lección de la taxonomía, aplicada antes de repetirla: serializar una
     * relación sin hidratarla en lote convierte cualquier página en una consulta por entrada. Se
     * cuentan las consultas de verdad, con su control negativo.
     */
    it('toJSON emite author como {id,displayName,slug}, y el listado lo resuelve en UNA consulta', async () => {
        const json = await (await Post.findById(taggedPostId)).toJSON();
        assert.deepStrictEqual(
            json.author,
            { id: adminId, displayName: 'Administrator', slug: 'administradora' },
            'un número aquí es el bug: display_name es el nombre, y el slug es user_nicename'
        );
        assert.strictEqual(json.authorId, adminId, 'el id crudo conserva una clave propia');

        // NUNCA el correo ni nada más de la fila: una firma de autor no es un listado de cuentas.
        assert.deepStrictEqual(Object.keys(json.author).sort(), ['displayName', 'id', 'slug']);

        // Y NUNCA el login: es lo que teclea el formulario de acceso, y `GET /posts` es anónimo. El
        // respaldo cuando user_nicename está vacío es el id, no `user_login` (models/Post.ts).
        assert.ok(!JSON.stringify(json).includes('"admin"'),
            'el login no puede aparecer en el post serializado');

        const hydrated = await withUserQueryCount(async () => {
            const posts = await Post.findAllWithRelations({ type: 'post', status: 'publish', limit: 50 });
            assert.ok(posts.length >= 2, 'hacen falta varias entradas para que el contador signifique algo');
            for (const post of posts) {
                assert.ok(post._authorCache !== undefined, `el post ${post.id} debe salir hidratado con el autor DEFINIDO`);
            }
            return await Promise.all(posts.map((p: any) => p.toJSON()));
        });
        assert.strictEqual(hydrated.userQueries, 1,
            `el listado hidratado debe resolver TODOS los autores en una consulta, hizo ${hydrated.userQueries}`);
        for (const serialized of hydrated.result) {
            assert.strictEqual(typeof serialized.author, 'object', 'ninguna entrada del listado puede volver al número');
        }

        // CONTROL NEGATIVO: sin hidratar, el respaldo es una consulta por post — que es lo que hace
        // significativa la aserción de arriba.
        const plain = await withUserQueryCount(async () => {
            const posts = await Post.findAll({ type: 'post', status: 'publish', limit: 50 });
            return await Promise.all(posts.map((p: any) => p.toJSON()));
        });
        assert.strictEqual(plain.userQueries, plain.result.length,
            'sin hidratar debe haber UNA consulta de usuario por entrada');
    });

    it('un post SIN términos emite arrays vacíos, no claves ausentes', async () => {
        const json = await (await Post.findById(barePostId)).toJSON();
        assert.ok('categories' in json && 'tags' in json, 'las dos claves deben existir siempre');
        assert.deepStrictEqual(json.categories, []);
        assert.deepStrictEqual(json.tags, []);
    });

    it('GET /posts/:id devuelve la taxonomía por HTTP (que es donde el editor la lee)', async () => {
        const res = await request(app).get(`/api/v1/posts/${taggedPostId}`);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(
            res.body.categories.map((c: any) => c.slug).sort(),
            ['guias', 'noticias']
        );
        assert.deepStrictEqual(res.body.tags.map((t: any) => t.slug).sort(), ['astro', 'react']);
    });

    /* ---------------------------------------------------------------- */
    /* 2. El listado no puede volverse N+1.                             */
    /* ---------------------------------------------------------------- */

    it('el listado resuelve la taxonomía de TODA la página en UNA consulta (y findAll sin hidratar prueba que el contador mide)', async () => {
        // Varios posts CON términos: si la serialización cayera al respaldo por post, el contador
        // subiría con el número de entradas.
        const extra: number[] = [];
        for (let i = 0; i < 4; i++) {
            const p = await Post.create({ authorId: adminId, title: `Lote ${i}`, content: 'x', status: 'publish', type: 'post' });
            await Post.setTerms(p.id, [newsId], 'category');
            extra.push(p.id);
        }

        const hydrated = await withTermQueryCount(async () => {
            const posts = await Post.findAllWithRelations({ type: 'post', status: 'publish', limit: 50 });
            for (const post of posts) {
                assert.ok(post._termsCache !== undefined, `el post ${post.id} debe salir de hydrateRelations con la caché DEFINIDA`);
                assert.ok(Array.isArray(post._termsCache.category) && Array.isArray(post._termsCache.post_tag));
            }
            return await Promise.all(posts.map((p: any) => p.toJSON()));
        });

        assert.ok(hydrated.result.length >= 6, 'el listado debe traer todos los posts sembrados');
        assert.strictEqual(
            hydrated.termQueries,
            1,
            `el listado hidratado debe hacer UNA sola consulta de taxonomía, hizo ${hydrated.termQueries}`
        );

        // CONTROL NEGATIVO: el mismo listado SIN hidratar cae al respaldo por post, así que el
        // contador sube con el número de entradas. Si esto también diese 1, la aserción de arriba no
        // estaría midiendo nada.
        const plain = await withTermQueryCount(async () => {
            const posts = await Post.findAll({ type: 'post', status: 'publish', limit: 50 });
            return await Promise.all(posts.map((p: any) => p.toJSON()));
        });
        assert.strictEqual(
            plain.termQueries,
            plain.result.length,
            'sin hidratar, el respaldo es UNA consulta por post — es lo que hace significativa la aserción anterior'
        );

        // Y GET /posts (que usa findAllWithRelations) tampoco degenera.
        const listed = await withTermQueryCount<any>(() => request(app).get('/api/v1/posts?per_page=50').then((r: any) => r));
        const listedRes: any = listed.result;
        assert.strictEqual(listedRes.status, 200);
        assert.strictEqual(listed.termQueries, 1, 'GET /posts debe seguir haciendo UNA consulta de taxonomía');
        const taggedInList = listedRes.body.find((p: any) => p.id === taggedPostId);
        assert.ok(taggedInList, 'el post con términos debe estar en el listado');
        assert.deepStrictEqual(taggedInList.categories.map((c: any) => c.slug).sort(), ['guias', 'noticias']);

        for (const id of extra) await Post.delete(id);
    });

    /* ---------------------------------------------------------------- */
    /* 3. El extracto se puede VACIAR.                                  */
    /* ---------------------------------------------------------------- */

    it('mandar excerpt: "" BORRA la columna; omitir la clave la deja intacta', async () => {
        const created = await request(app)
            .post('/api/v1/posts')
            .use(as(adminToken))
            .send({ title: 'Con extracto', content: 'Cuerpo largo del post', excerpt: 'Resumen propio', type: 'post', status: 'draft' });
        assert.strictEqual(created.status, 201, JSON.stringify(created.body));
        const id = created.body.id;

        const columnOf = async () =>
            (await dbAsync.get('SELECT post_excerpt FROM posts WHERE id = ?', [id])).post_excerpt;
        assert.strictEqual(await columnOf(), 'Resumen propio');

        // Guardar SIN la clave no toca el extracto (es lo que hace un autosave que no lo cambió).
        const untouched = await request(app).put(`/api/v1/posts/${id}`).use(as(adminToken)).send({ title: 'Con extracto (v2)' });
        assert.strictEqual(untouched.status, 200);
        assert.strictEqual(await columnOf(), 'Resumen propio', 'omitir la clave debe dejar el extracto como estaba');

        // Vaciarlo SÍ lo borra: antes '' era falsy y la columna se quedaba igual, así que el editor
        // parecía haber aceptado el borrado hasta que se reabría el registro.
        const cleared = await request(app).put(`/api/v1/posts/${id}`).use(as(adminToken)).send({ excerpt: '' });
        assert.strictEqual(cleared.status, 200);
        assert.strictEqual(await columnOf(), '', 'mandar "" debe vaciar la columna');

        // Y un valor nuevo sigue pasando por el saneado.
        const xss = await request(app)
            .put(`/api/v1/posts/${id}`)
            .use(as(adminToken))
            .send({ excerpt: 'Seguro<script>alert(1)</script>' });
        assert.strictEqual(xss.status, 200);
        const sanitized = await columnOf();
        assert.ok(!/script/i.test(sanitized), `el extracto debe seguir saneándose, quedó: ${sanitized}`);
        assert.ok(sanitized.includes('Seguro'), 'el texto legítimo se conserva');
    });

    /* ---------------------------------------------------------------- */
    /* 4. El filtro MIME de la biblioteca.                              */
    /* ---------------------------------------------------------------- */

    it('mime_type filtra la biblioteca Y el total del paginador va con el filtro', async () => {
        const attach = async (title: string, mime: string) => {
            await dbAsync.run(
                `INSERT INTO posts (post_title, post_content, post_excerpt, post_status, post_type, post_name, post_mime_type, author_id, guid, post_parent)
                 VALUES (?, '', '', 'inherit', 'attachment', ?, ?, ?, ?, 0)`,
                [title, title.toLowerCase().replace(/\W+/g, '-'), mime, adminId, `/uploads/${title}`]
            );
        };
        await attach('uno.png', 'image/png');
        await attach('dos.jpg', 'image/jpeg');
        await attach('tres.pdf', 'application/pdf');
        await attach('cuatro.mp4', 'video/mp4');

        const listOf = async (query: string) => {
            const res = await request(app).get(`/api/v1/media?per_page=2${query}`);
            assert.strictEqual(res.status, 200);
            return { body: res.body, total: Number(res.headers['x-wp-total']), pages: Number(res.headers['x-wp-totalpages']) };
        };

        const all = await listOf('');
        assert.strictEqual(all.total, 4, 'sin filtro se ven los cuatro adjuntos');

        // FAMILIA: 'image' → todo image/*.
        const images = await listOf('&mime_type=image');
        assert.strictEqual(images.total, 2, 'la familia image debe contar 2');
        assert.strictEqual(images.pages, 1, 'el total filtrado manda en el número de páginas');
        assert.ok(images.body.every((m: any) => String(m.mimeType).startsWith('image/')), 'sólo imágenes en las filas');

        // 'image/' (con barra) es la misma familia — es la forma que ya emitía el cliente.
        assert.strictEqual((await listOf('&mime_type=image%2F')).total, 2);

        // TIPO COMPLETO: exacto, no por prefijo.
        const png = await listOf('&mime_type=image%2Fpng');
        assert.strictEqual(png.total, 1);
        assert.deepStrictEqual(png.body.map((m: any) => m.mimeType), ['image/png']);

        const pdf = await listOf('&mime_type=application%2Fpdf');
        assert.strictEqual(pdf.total, 1);

        // Un filtro sin coincidencias devuelve 0 y lo DICE en el total (no la biblioteca entera).
        const none = await listOf('&mime_type=audio');
        assert.strictEqual(none.total, 0);
        assert.deepStrictEqual(none.body, []);

        // Un valor con comodines de LIKE no puede colarse como "todo": '%' no es un tipo válido, y el
        // filtro se cierra en 0 en vez de listar la biblioteca fingiendo haber filtrado.
        const wildcard = await listOf('&mime_type=%25');
        assert.strictEqual(wildcard.total, 0, 'un comodín de LIKE no puede convertirse en "sin filtro"');
        assert.deepStrictEqual(wildcard.body, []);
    });
});
