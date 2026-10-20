/**
 * GRAPHQL MUTATIONS — on the REAL app (../index): every mutation IS its REST write, for the same caller.
 *
 * The promise under test is an AUTHORIZATION PARITY TABLE: each row sends the REST write and the GraphQL
 * mutation that names it, as the same caller, and asserts the same outcome — the same refusal code and HTTP
 * status when REST refuses, the same stored state when it accepts. The rows are the rules that matter:
 * a contributor cannot publish, an author cannot edit (or trash, or delete) someone else's entry, a token's
 * scope decides per resource, the MFA compliance gate and the sudo re-authentication of a profile change
 * apply, protected meta is refused, terms/menus/settings/moderation take their REST capability.
 *
 * Then the endpoint's own rules, which only the real app's middleware chain can show: no mutation over GET
 * (a cross-site GET carrying the session cookie writes nothing), a cross-site or token-less cookie POST is
 * refused by CSRF before any resolver, mutations count in the cost limit and are capped per document — all
 * asserted on the database, not only on the response.
 *
 * MUTATION PROOF: on the read-only schema every row here fails (there is no Mutation root); removing the
 * method check, the mutation cap or the multipart re-stream makes its block fail.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_DB = path.join(os.tmpdir(), `wjs-gql-mut-${STAMP}.db`);
const TMP_UPLOADS = path.join(os.tmpdir(), `wjs-gql-mut-up-${STAMP}`);
const TMP_PRIVATE = path.join(os.tmpdir(), `wjs-gql-mut-priv-${STAMP}`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
config.uploads.dir = TMP_UPLOADS;
config.uploads.privateDir = TMP_PRIVATE;
// Read once when index.ts builds its limiters: this suite sends many requests from one address.
config.api.rateLimit.max = 100_000;

const request = require('supertest');
const database = require('../config/database');
const app = require('../index');

const configManager = require('../core/configManager');
const realIsInstalled = configManager.isInstalled;
const realGetConfig = configManager.getConfig;
configManager.isInstalled = () => true;
configManager.getConfig = () => ({ installedAt: '2020-01-01T00:00:00.000Z', dbDriver: config.dbDriver });

const { generateToken } = require('../middleware/auth');
const User = require('../models/User');
const ApiToken = require('../models/ApiToken');

const API = config.api.prefix;
const PASSWORD = 'Correct-Horse-9-Battery';
const U: Record<string, any> = {};
const TOKENS: Record<string, string> = {};
let server: any;
let origin = '';
let db: any;

// A caller is a set of headers: a session JWT as Bearer (the interactive identity) or a `wjt_` API token.
type Who = string;
function headersFor(who: Who): Record<string, string> {
    // An anonymous browser POST carries its page's Origin; without one CSRF refuses any write (REST and GraphQL).
    if (who === 'anonymous') return { Origin: origin };
    if (TOKENS[who]) return { Authorization: `Bearer ${TOKENS[who]}` };
    return { Authorization: `Bearer ${generateToken(U[who])}` };
}

function restAs(who: Who, method: 'get' | 'post' | 'put' | 'delete', p: string, body?: any) {
    let r = (request(server) as any)[method](`${API}${p}`).set(headersFor(who));
    if (body !== undefined) r = r.send(body);
    return r;
}

function gqlAs(who: Who, query: string, variables?: any) {
    return (request(server) as any).post(`${API}/graphql`)
        .set({ ...headersFor(who), Accept: 'application/graphql-response+json, application/json' })
        .send({ query, variables });
}

/** The REST refusal and the GraphQL refusal are the same refusal. */
function assertSameRefusal(rest: any, gql: any, field: string, what: string) {
    assert.ok(rest.status >= 400, `${what}: REST was expected to refuse (got ${rest.status} ${JSON.stringify(rest.body)})`);
    const err = (gql.body.errors || [])[0];
    assert.ok(err, `${what}: GraphQL accepted what REST refused: ${JSON.stringify(gql.body)}`);
    assert.strictEqual(err.extensions.code, rest.body.code, `${what}: code`);
    assert.strictEqual(err.extensions.status, rest.status, `${what}: status`);
    assert.strictEqual(gql.body.data ? gql.body.data[field] : null, null, `${what}: no payload`);
}

/**
 * The same OUTCOME: the same refusal when REST refuses, otherwise a GraphQL payload that agrees with the
 * REST body on what `pick` extracts (REST may accept and adjust — a contributor's "publish" becomes pending).
 */
function assertSameOutcome(rest: any, gql: any, field: string, what: string, pick: (v: any) => any, payloadOf: (d: any) => any = (d) => d.node) {
    if (rest.status >= 400) return assertSameRefusal(rest, gql, field, what);
    assert.ok(!gql.body.errors, `${what}: GraphQL refused what REST accepted: ${JSON.stringify(gql.body.errors)}`);
    assert.deepStrictEqual(pick(payloadOf(gql.body.data[field])), pick(rest.body), what);
}

async function postRow(id: number) {
    return db.get('SELECT id, post_status, post_title, author_id FROM posts WHERE id = ?', [id]);
}
async function count(sql: string, params: any[] = []): Promise<number> {
    const row = await db.get(sql, params);
    return Number(Object.values(row || { n: 0 })[0]);
}

async function seedPost(author: string, status: string, title: string, type = 'post'): Promise<number> {
    const r = await restAs('admin', 'post', '/posts', { title, status: 'draft', type });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    await db.run('UPDATE posts SET author_id = ?, post_status = ? WHERE id = ?', [U[author].id, status, r.body.id]);
    return r.body.id;
}

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

before(async () => {
    config.nodeEnv = 'test';
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    db = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await require('../core/roles').loadRoles();
    for (const [login, role] of [['admin', 'administrator'], ['editor', 'editor'], ['alice', 'author'], ['bob', 'author'], ['carl', 'contributor'], ['sub', 'subscriber']]) {
        U[login] = await User.create({ username: login, email: `${login}@example.com`, password: PASSWORD, role, displayName: `${login} display` });
    }
    TOKENS.readToken = (await ApiToken.generate({ userId: U.alice.id, name: 'ro', scopes: ['posts:read'] })).token;
    TOKENS.postsWrite = (await ApiToken.generate({ userId: U.alice.id, name: 'posts-rw', scopes: ['posts:write'] })).token;
    // initialize() mounts these in production; the suite does not boot the runtime, so mount them the same way.
    const { notFound, errorHandler } = require('../middleware/errorHandler');
    app.use(notFound);
    app.use(errorHandler);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    configManager.isInstalled = realIsInstalled;
    configManager.getConfig = realGetConfig;
    try { await new Promise((r) => server.close(r)); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
    for (const d of [TMP_UPLOADS, TMP_PRIVATE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
});

const CREATE_POST = `mutation($input: ContentInput!) { createPost(input: $input) { node { id title status authorId } } }`;
const UPDATE = `mutation($id: Int!, $input: ContentInput!) { updateContent(id: $id, input: $input) { node { id title status } } }`;

describe('authorization parity: each mutation is refused exactly where its REST twin is', () => {
    test('a contributor can create a draft but cannot publish — on create, on update, or with publishContent', async () => {
        const restDraft = await restAs('carl', 'post', '/posts', { title: 'carl rest draft' });
        const gqlDraft = await gqlAs('carl', CREATE_POST, { input: { title: 'carl gql draft' } });
        assert.strictEqual(restDraft.status, 201);
        assert.ok(!gqlDraft.body.errors, JSON.stringify(gqlDraft.body.errors));
        const node = gqlDraft.body.data.createPost.node;
        assert.deepStrictEqual({ status: node.status, authorId: node.authorId }, { status: restDraft.body.status, authorId: restDraft.body.authorId });
        assert.strictEqual((await postRow(node.id)).post_status, 'draft');

        // REST answers a contributor's "publish" by holding the entry for review; GraphQL is that same write.
        const restPub = await restAs('carl', 'post', '/posts', { title: 'carl publish', status: 'publish' });
        const gqlPub = await gqlAs('carl', CREATE_POST, { input: { title: 'carl publish', status: 'PUBLISH' } });
        assertSameOutcome(restPub, gqlPub, 'createPost', 'contributor create+publish', (n) => n.status);

        const restUp = await restAs('carl', 'put', `/posts/${restDraft.body.id}`, { status: 'publish' });
        const gqlUp = await gqlAs('carl', `mutation { publishContent(id: ${node.id}) { node { id status } } }`);
        assertSameOutcome(restUp, gqlUp, 'publishContent', 'contributor publish', (n) => n.status);
        assert.strictEqual(await count("SELECT COUNT(*) FROM posts WHERE post_type != 'revision' AND author_id = ? AND post_status = 'publish'", [U.carl.id]), 0, 'nothing of the contributor is live');
    });

    test('an author cannot edit, trash or delete another author\'s entry; the owner can', async () => {
        const bobs = await seedPost('bob', 'publish', 'bob published');
        const rows: Array<[string, () => any, string, string]> = [
            ['update', () => restAs('alice', 'put', `/posts/${bobs}`, { title: 'hijacked' }), `mutation { updateContent(id: ${bobs}, input: { title: "hijacked" }) { node { id } } }`, 'updateContent'],
            ['trash', () => restAs('alice', 'delete', `/posts/${bobs}`), `mutation { trashContent(id: ${bobs}) { node { id } } }`, 'trashContent'],
            ['delete', () => restAs('alice', 'delete', `/posts/${bobs}?force=true`), `mutation { deleteContent(id: ${bobs}) { id deleted } }`, 'deleteContent'],
            ['meta', () => restAs('alice', 'post', `/posts/${bobs}/meta`, { key: 'note', value: 'x' }), `mutation { setContentMeta(id: ${bobs}, key: "note", value: "x") }`, 'setContentMeta'],
        ];
        for (const [what, rest, gql, field] of rows) {
            assertSameRefusal(await rest(), await gqlAs('alice', gql), field, `author ${what} of another's`);
        }
        const row = await postRow(bobs);
        assert.deepStrictEqual({ title: row.post_title, status: row.post_status }, { title: 'bob published', status: 'publish' });

        // The owner (and an editor) pass the same gates.
        const own = await gqlAs('bob', UPDATE, { id: bobs, input: { title: 'bob renamed' } });
        assert.ok(!own.body.errors, JSON.stringify(own.body.errors));
        assert.strictEqual((await postRow(bobs)).post_title, 'bob renamed');
        const ed = await gqlAs('editor', UPDATE, { id: bobs, input: { title: 'edited by editor' } });
        assert.ok(!ed.body.errors, JSON.stringify(ed.body.errors));
        assert.strictEqual((await postRow(bobs)).post_title, 'edited by editor');
    });

    test('a subscriber cannot create content at all', async () => {
        assertSameRefusal(await restAs('sub', 'post', '/posts', { title: 'x' }), await gqlAs('sub', CREATE_POST, { input: { title: 'x' } }), 'createPost', 'subscriber create');
    });

    test('anonymous callers are refused like REST (401), and nothing is written', async () => {
        const before = await count("SELECT COUNT(*) FROM posts WHERE post_type != 'revision'");
        assertSameRefusal(await restAs('anonymous', 'post', '/posts', { title: 'anon' }), await gqlAs('anonymous', CREATE_POST, { input: { title: 'anon' } }), 'createPost', 'anonymous create');
        assert.strictEqual(await count("SELECT COUNT(*) FROM posts WHERE post_type != 'revision'"), before);
    });

    test('an API token\'s scope decides per resource, on every sub-request', async () => {
        const read = await gqlAs('readToken', '{ posts(status: "any", first: 5) { totalCount } }');
        assert.ok(!read.body.errors, 'a posts:read token reads through GraphQL');
        assertSameRefusal(await restAs('readToken', 'post', '/posts', { title: 'ro' }), await gqlAs('readToken', CREATE_POST, { input: { title: 'ro' } }), 'createPost', 'posts:read token write');

        const ok = await gqlAs('postsWrite', CREATE_POST, { input: { title: 'token write' } });
        assert.ok(!ok.body.errors, JSON.stringify(ok.body.errors));
        assert.strictEqual(ok.body.data.createPost.node.authorId, U.alice.id, 'the token acts as its owner');
        // posts:write is not categories:write — the term route refuses it, through GraphQL too.
        assertSameRefusal(
            await restAs('postsWrite', 'post', '/categories', { name: 'Nope' }),
            await gqlAs('postsWrite', 'mutation { createTerm(taxonomy: CATEGORY, input: { name: "Nope" }) { term { id } } }'),
            'createTerm', 'posts:write token on categories');
        // ...and the token is refused where REST refuses ANY token (a profile change is an interactive act).
        assertSameRefusal(
            await restAs('postsWrite', 'put', '/users/me', { displayName: 'tok' }),
            await gqlAs('postsWrite', 'mutation { updateViewer(input: { displayName: "tok" }) { viewer { id } } }'),
            'updateViewer', 'token profile write');
    });

    test('protected meta is refused on create, on update and through setContentMeta', async () => {
        const mine = await seedPost('alice', 'draft', 'alice meta');
        // In the body of a create/update REST drops (or refuses) a protected key; GraphQL does the same.
        const restCreate = await restAs('alice', 'post', '/posts', { title: 'pm rest', meta: { _wp_attached_file: '../../etc/passwd' } });
        const gqlCreate = await gqlAs('alice', CREATE_POST, { input: { title: 'pm gql', meta: { _wp_attached_file: '../../etc/passwd' } } });
        assertSameOutcome(restCreate, gqlCreate, 'createPost', 'protected meta on create', (n) => ({ status: n.status }));
        assertSameOutcome(
            await restAs('alice', 'put', `/posts/${mine}`, { meta: { _wp_attached_file: 'x' } }),
            await gqlAs('alice', UPDATE, { id: mine, input: { meta: { _wp_attached_file: 'x' } } }),
            'updateContent', 'protected meta on update', (n) => ({ status: n.status }));
        assert.strictEqual(await count("SELECT COUNT(*) FROM post_meta WHERE meta_key = '_wp_attached_file' AND meta_value LIKE '%passwd%'"), 0, 'never stored');
        assertSameRefusal(
            await restAs('alice', 'post', `/posts/${mine}/meta`, { key: '_wp_attached_file', value: 'x' }),
            await gqlAs('alice', `mutation { setContentMeta(id: ${mine}, key: "_wp_attached_file", value: "x") }`),
            'setContentMeta', 'protected meta key');
        assert.strictEqual(await count("SELECT COUNT(*) FROM post_meta WHERE meta_key = '_wp_attached_file' AND post_id = ?", [mine]), 0);
        // An ordinary key passes, through the same sanitizer.
        const okMeta = await gqlAs('alice', `mutation { setContentMeta(id: ${mine}, key: "subtitle", value: "<b>hi</b><script>x</script>") }`);
        assert.ok(!okMeta.body.errors, JSON.stringify(okMeta.body.errors));
    });

    test('the MFA compliance gate refuses the whole GraphQL write for a role that must enroll, like a REST write', async () => {
        const mfa = require('../core/mfa');
        await mfa.setPolicy({ requiredRoles: ['editor'], graceDays: 0 });
        try {
            const rest = await restAs('editor', 'post', '/posts', { title: 'mfa' });
            const gql = await gqlAs('editor', CREATE_POST, { input: { title: 'mfa' } });
            assert.strictEqual(rest.status, 403);
            assert.strictEqual(rest.body.code, 'mfa_enrollment_required');
            assert.strictEqual(gql.status, 403, 'refused before any resolver runs');
            assert.strictEqual(gql.body.code, 'mfa_enrollment_required');
            assert.strictEqual(await count("SELECT COUNT(*) FROM posts WHERE post_type != 'revision' AND post_title = 'mfa'"), 0);
        } finally {
            await mfa.setPolicy({ requiredRoles: [], graceDays: 0 });
        }
    });

    test('a password change through updateViewer re-authenticates (sudo) exactly like PUT /users/me', async () => {
        const restNo = await restAs('bob', 'put', '/users/me', { password: 'New-Password-123-xyz' });
        const gqlNo = await gqlAs('bob', 'mutation { updateViewer(input: { password: "New-Password-123-xyz" }) { viewer { id } } }');
        assertSameRefusal(restNo, gqlNo, 'updateViewer', 'password change without currentPassword');
        const gqlBad = await gqlAs('bob', 'mutation { updateViewer(input: { password: "New-Password-123-xyz", currentPassword: "wrong" }) { viewer { id } } }');
        assert.strictEqual(gqlBad.body.errors[0].extensions.code, 'rest_bad_current_password');
        // A display-name change needs no sudo, and lands.
        const gqlName = await gqlAs('bob', 'mutation { updateViewer(input: { displayName: "Bobby" }) { viewer { id name } } }');
        assert.ok(!gqlName.body.errors, JSON.stringify(gqlName.body.errors));
        assert.strictEqual(gqlName.body.data.updateViewer.viewer.name, 'Bobby');
        assert.strictEqual((await restAs('bob', 'get', '/users/me')).body.displayName, 'Bobby');
    });

    test('terms need manage_categories: an author is refused, an editor creates, renames and deletes', async () => {
        assertSameRefusal(
            await restAs('alice', 'post', '/tags', { name: 'Alice tag' }),
            await gqlAs('alice', 'mutation { createTerm(taxonomy: TAG, input: { name: "Alice tag" }) { term { id } } }'),
            'createTerm', 'author term create');
        const made = await gqlAs('editor', 'mutation { createTerm(taxonomy: CATEGORY, input: { name: "GQL News", description: "d" }) { term { id name slug taxonomy } } }');
        assert.ok(!made.body.errors, JSON.stringify(made.body.errors));
        const term = made.body.data.createTerm.term;
        assert.strictEqual(term.taxonomy, 'category');
        assert.deepStrictEqual((await restAs('anonymous', 'get', `/categories/${term.id}`)).body.name, 'GQL News');
        const renamed = await gqlAs('editor', `mutation { updateTerm(taxonomy: CATEGORY, id: ${term.id}, input: { name: "GQL World" }) { term { name } } }`);
        assert.strictEqual(renamed.body.data.updateTerm.term.name, 'GQL World');
        const gone = await gqlAs('editor', `mutation { deleteTerm(taxonomy: CATEGORY, id: ${term.id}) { id deleted } }`);
        assert.deepStrictEqual(gone.body.data.deleteTerm, { id: term.id, deleted: true });
        assert.strictEqual((await restAs('anonymous', 'get', `/categories/${term.id}`)).status, 404);
    });

    test('menus are administrators\' (an editor is refused like REST); an administrator builds one', async () => {
        assertSameRefusal(
            await restAs('editor', 'post', '/menus', { name: 'Ed menu' }),
            await gqlAs('editor', 'mutation { createMenu(input: { name: "Ed menu" }) { menu { id } } }'),
            'createMenu', 'editor menu create');
        const m = await gqlAs('admin', 'mutation { createMenu(input: { name: "Main GQL" }) { menu { id name } } }');
        assert.ok(!m.body.errors, JSON.stringify(m.body.errors));
        const menuId = m.body.data.createMenu.menu.id;
        const item = await gqlAs('admin', `mutation { addMenuItem(menuId: ${menuId}, input: { title: "Home", url: "javascript:alert(1)" }) { menuItem { id title url } } }`);
        assert.ok(!item.body.errors, JSON.stringify(item.body.errors));
        assert.notStrictEqual(item.body.data.addMenuItem.menuItem.url, 'javascript:alert(1)', 'the REST url sanitizer ran');
        const itemId = item.body.data.addMenuItem.menuItem.id;
        const upd = await gqlAs('admin', `mutation { updateMenuItem(id: ${itemId}, input: { title: "Start" }) { menuItem { title } } }`);
        assert.strictEqual(upd.body.data.updateMenuItem.menuItem.title, 'Start');
        const read = await gqlAs('anonymous', `{ menu(id: ${menuId}) { name items { title } } }`);
        assert.deepStrictEqual(read.body.data.menu, { name: 'Main GQL', items: [{ title: 'Start' }] });
        assert.strictEqual((await gqlAs('admin', `mutation { deleteMenuItem(id: ${itemId}) { deleted } }`)).body.data.deleteMenuItem.deleted, true);
        assert.strictEqual((await gqlAs('admin', `mutation { deleteMenu(id: ${menuId}) { deleted } }`)).body.data.deleteMenu.deleted, true);
    });

    test('settings: only an administrator writes, with the REST allow-list and validators', async () => {
        assertSameRefusal(
            await restAs('editor', 'put', '/settings', { blogname: 'Ed site' }),
            await gqlAs('editor', 'mutation { updateSettings(values: { blogname: "Ed site" }) { settings } }'),
            'updateSettings', 'editor settings');
        const ok = await gqlAs('admin', 'mutation { updateSettings(values: { blogname: "GQL Site", not_a_setting: "x" }) { settings } }');
        assert.ok(!ok.body.errors, JSON.stringify(ok.body.errors));
        assert.deepStrictEqual(ok.body.data.updateSettings.settings, { blogname: 'GQL Site' }, 'an unknown key is ignored exactly as on REST');
        assert.strictEqual((await gqlAs('anonymous', '{ settings { title } }')).body.data.settings.title, 'GQL Site');
        assertSameRefusal(
            await restAs('admin', 'put', '/settings/not_a_setting', { value: 1 }),
            await gqlAs('admin', 'mutation { updateSetting(key: "not_a_setting", value: 1) { settings } }'),
            'updateSetting', 'unknown setting key');
    });

    test('comments: anyone may comment (REST moderation applies), only a moderator moderates', async () => {
        const post = await seedPost('alice', 'publish', 'commentable');
        const c = await gqlAs('anonymous', `mutation { createComment(input: { postId: ${post}, content: "Nice post, thanks", authorName: "Guest", authorEmail: "guest@example.com" }) { comment { id status } } }`);
        assert.ok(!c.body.errors, JSON.stringify(c.body.errors));
        const id = c.body.data.createComment.comment.id;
        const restSame = await restAs('anonymous', 'post', '/comments', { post, content: 'Nice post, again', author_name: 'Guest', author_email: 'guest@example.com' });
        assert.strictEqual(c.body.data.createComment.comment.status, restSame.body.status, 'the same moderation decision');
        assertSameRefusal(
            await restAs('alice', 'post', `/comments/${restSame.body.id}/approve`, {}),
            await gqlAs('alice', `mutation { moderateComment(id: ${id}, action: APPROVE) { comment { id } } }`),
            'moderateComment', 'author moderation');
        const ok = await gqlAs('editor', `mutation { moderateComment(id: ${id}, action: APPROVE) { comment { id status authorEmail } } }`);
        assert.ok(!ok.body.errors, JSON.stringify(ok.body.errors));
        assert.strictEqual(ok.body.data.moderateComment.comment.status, 'approved');
        assert.strictEqual(ok.body.data.moderateComment.comment.authorEmail, 'guest@example.com', 'a moderator sees what REST shows a moderator');
        const anonView = await gqlAs('anonymous', `{ comment(id: ${id}) { content authorEmail } }`);
        assert.deepStrictEqual(anonView.body.data.comment, { content: 'Nice post, thanks', authorEmail: null });
        const trashed = await gqlAs('editor', `mutation { deleteComment(id: ${id}) { id deleted } }`);
        assert.deepStrictEqual(trashed.body.data.deleteComment, { id, deleted: false });
    });
});

describe('content lifecycle through GraphQL lands exactly as through REST', () => {
    test('create → schedule → publish → unpublish → trash → restore → delete, each visible on REST', async () => {
        const made = await gqlAs('editor', 'mutation { createPage(input: { title: "GQL page", content: "<p>ok</p><script>bad()</script>" }) { node { id type status content } } }');
        assert.ok(!made.body.errors, JSON.stringify(made.body.errors));
        const node = made.body.data.createPage.node;
        assert.strictEqual(node.type, 'page');
        assert.ok(!/script/.test(node.content), 'REST sanitized the body');
        const id = node.id;
        const pub = await gqlAs('editor', `mutation { publishContent(id: ${id}) { node { status } } }`);
        assert.strictEqual(pub.body.data.publishContent.node.status, 'publish');
        assert.strictEqual((await restAs('anonymous', 'get', `/posts/${id}`)).status, 200, 'public now');
        const unpub = await gqlAs('editor', `mutation { unpublishContent(id: ${id}) { node { status } } }`);
        assert.strictEqual(unpub.body.data.unpublishContent.node.status, 'draft');
        assert.strictEqual((await restAs('anonymous', 'get', `/posts/${id}`)).status, 404, 'hidden again');
        const future = new Date(Date.now() + 7 * 864e5).toISOString();
        const sched = await gqlAs('editor', `mutation($d: String!) { scheduleContent(id: ${id}, date: $d) { node { status } } }`, { d: future });
        assert.strictEqual(sched.body.data.scheduleContent.node.status, 'future');
        const trash = await gqlAs('editor', `mutation { trashContent(id: ${id}) { node { id status } } }`);
        assert.strictEqual(trash.body.data.trashContent.node.status, 'trash');
        const restored = await gqlAs('editor', `mutation { restoreContent(id: ${id}) { node { status } } }`);
        assert.strictEqual(restored.body.data.restoreContent.node.status, 'draft');
        const audit = await count("SELECT COUNT(*) FROM audit_log WHERE object_id = ? AND action IN ('post.trash', 'post.restore')", [String(id)]).catch(() => -1);
        if (audit !== -1) assert.ok(audit >= 2, 'the REST audit rows were written');
        const del = await gqlAs('editor', `mutation { deleteContent(id: ${id}) { id deleted previous } }`);
        assert.strictEqual(del.body.data.deleteContent.deleted, true);
        assert.strictEqual(await postRow(id), undefined);
    });

    test('mutation root fields run in order and a later one sees what an earlier one wrote', async () => {
        const r = await gqlAs('alice', `mutation {
            a: createPost(input: { title: "first" }) { node { id title } }
            b: createPost(input: { title: "second" }) { node { id title } }
        }`);
        assert.ok(!r.body.errors, JSON.stringify(r.body.errors));
        assert.ok(r.body.data.b.node.id > r.body.data.a.node.id);
        const q = await gqlAs('alice', `mutation($id: Int!) { updateContent(id: $id, input: { title: "first, renamed" }) { node { title } } }`, { id: r.body.data.a.node.id });
        assert.strictEqual(q.body.data.updateContent.node.title, 'first, renamed');
    });

    test('revisions: a restore and a delete go through the revisions routes\' gates', async () => {
        const id = await seedPost('alice', 'draft', 'rev v1');
        await restAs('alice', 'put', `/posts/${id}`, { title: 'rev v2', content: 'two' });
        await restAs('alice', 'put', `/posts/${id}`, { title: 'rev v3', content: 'three' });
        const list = await gqlAs('alice', `{ revisions(postId: ${id}, first: 10) { totalCount nodes { id title } } }`);
        assert.ok(!list.body.errors, JSON.stringify(list.body.errors));
        const rest = await restAs('alice', 'get', `/revisions/post/${id}?limit=10`);
        assert.deepStrictEqual(list.body.data.revisions.nodes.map((n: any) => n.id), rest.body.revisions.map((n: any) => n.id));
        assert.strictEqual(list.body.data.revisions.totalCount, rest.body.total);
        const target = rest.body.revisions[rest.body.revisions.length - 1];
        assertSameRefusal(
            await restAs('bob', 'post', `/revisions/${target.id}/restore`, {}),
            await gqlAs('bob', `mutation { restoreRevision(id: ${target.id}, postId: ${id}) { node { id } } }`),
            'restoreRevision', 'another author restores');
        const ok = await gqlAs('alice', `mutation { restoreRevision(id: ${target.id}, postId: ${id}) { node { id title } } }`);
        assert.ok(!ok.body.errors, JSON.stringify(ok.body.errors));
        assert.strictEqual(ok.body.data.restoreRevision.node.title, target.title);
    });
});

describe('the GraphQL endpoint\'s own write rules (real middleware chain)', () => {
    test('no mutation over GET — not with a Bearer token, not with the session cookie', async () => {
        const before = await count("SELECT COUNT(*) FROM posts WHERE post_type != 'revision'");
        const q = encodeURIComponent(`mutation { createPost(input: { title: "via GET" }) { node { id } } }`);
        const bearer = await (request(server) as any).get(`${API}/graphql?query=${q}`).set(headersFor('admin')).set('Accept', 'application/json');
        assert.strictEqual(bearer.status, 405);
        const session = generateToken(U.admin);
        const cookie = await (request(server) as any).get(`${API}/graphql?query=${q}`)
            .set('Cookie', `wordjs_token=${session}; wjs_csrf=t0k3n`)
            .set('Origin', 'https://evil.example')
            .set('Accept', 'application/json');
        assert.strictEqual(cookie.status, 405, 'a cross-site GET carrying the session cookie writes nothing');
        assert.strictEqual(await count("SELECT COUNT(*) FROM posts WHERE post_type != 'revision'"), before);
        assert.strictEqual(await count("SELECT COUNT(*) FROM posts WHERE post_type != 'revision' AND post_title = 'via GET'"), 0);
    });

    test('a cookie-authenticated POST needs a same-origin Origin AND the X-CSRF-Token header', async () => {
        const session = generateToken(U.admin);
        const body = { query: 'mutation { createPost(input: { title: "csrf probe" }) { node { id } } }' };
        const crossSite = await (request(server) as any).post(`${API}/graphql`)
            .set('Cookie', `wordjs_token=${session}; wjs_csrf=t0k3n`).set('X-CSRF-Token', 't0k3n')
            .set('Origin', 'https://evil.example').send(body);
        assert.strictEqual(crossSite.status, 403);
        assert.strictEqual(crossSite.body.code, 'rest_csrf_invalid');
        const noToken = await (request(server) as any).post(`${API}/graphql`)
            .set('Cookie', `wordjs_token=${session}; wjs_csrf=t0k3n`)
            .set('Origin', origin).send(body);
        assert.strictEqual(noToken.status, 403);
        assert.strictEqual(noToken.body.code, 'rest_csrf_token');
        assert.strictEqual(await count("SELECT COUNT(*) FROM posts WHERE post_type != 'revision' AND post_title = 'csrf probe'"), 0);
        // The same-origin POST with the double-submit token is the one that writes.
        const ok = await (request(server) as any).post(`${API}/graphql`)
            .set('Cookie', `wordjs_token=${session}; wjs_csrf=t0k3n`).set('X-CSRF-Token', 't0k3n')
            .set('Origin', origin).set('Accept', 'application/json').send(body);
        assert.ok(!ok.body.errors, JSON.stringify(ok.body));
        assert.strictEqual(await count("SELECT COUNT(*) FROM posts WHERE post_type != 'revision' AND post_title = 'csrf probe'"), 1);
    });

    test('mutations are refused on the subscription stream', async () => {
        const r = await (request(server) as any).post(`${API}/graphql/stream`).set(headersFor('admin'))
            .send({ query: 'mutation { createPost(input: { title: "via stream" }) { node { id } } }' });
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.body.errors[0].extensions.code, 'GRAPHQL_NOT_A_SUBSCRIPTION');
        assert.strictEqual(await count("SELECT COUNT(*) FROM posts WHERE post_type != 'revision' AND post_title = 'via stream'"), 0);
    });

    test('more than maxMutations mutation fields in one document is refused at validation — nothing runs', async () => {
        const max = require('../core/graphql').limitOptions().maxMutations;
        const fields = Array.from({ length: max + 1 }, (_, i) => `m${i}: createPost(input: { title: "batch ${i}" }) { node { id } }`).join('\n');
        const before = await count("SELECT COUNT(*) FROM posts WHERE post_type != 'revision'");
        const r = await gqlAs('admin', `mutation { ${fields} }`);
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.body.errors[0].extensions.code, 'GRAPHQL_MUTATION_LIMIT');
        assert.strictEqual(r.body.errors[0].extensions.mutations, max + 1);
        assert.strictEqual(await count("SELECT COUNT(*) FROM posts WHERE post_type != 'revision'"), before);
        // Fragments do not hide mutations from the count.
        const viaFragment = await gqlAs('admin', `mutation { ...M ...M2 } fragment M on Mutation { ${fields} } fragment M2 on Mutation { x: createPost(input: { title: "y" }) { node { id } } }`);
        assert.strictEqual(viaFragment.body.errors[0].extensions.code, 'GRAPHQL_MUTATION_LIMIT');
        // Exactly maxMutations passes.
        const okFields = Array.from({ length: max }, (_, i) => `m${i}: createPost(input: { title: "ok batch ${i}" }) { node { id } }`).join('\n');
        const ok = await gqlAs('admin', `mutation { ${okFields} }`);
        assert.ok(!ok.body.errors, JSON.stringify(ok.body.errors));
        assert.strictEqual(await count("SELECT COUNT(*) FROM posts WHERE post_type != 'revision' AND post_title LIKE 'ok batch %'"), max);
    });

    test('mutations count in the cost limit: a write costs more than the same selection read, and an over-budget document writes nothing', async () => {
        const { parse, validate } = require('graphql');
        const graphql = require('../core/graphql');
        const costOf = (doc: string) => {
            const errs = validate(graphql.getSchema(), parse(doc), [require('../core/graphql/limits').createLimitRule({ maxDepth: 50, maxCost: 0, maxPageSize: 100, maxMutations: 100 })]);
            const e = errs.find((x: any) => x.extensions && x.extensions.code === 'GRAPHQL_COST_LIMIT');
            return e ? e.extensions.cost : 0;
        };
        const read = costOf('{ post(id: 1) { id title } }');
        const write = costOf('mutation { publishContent(id: 1) { node { id title } } }');
        assert.ok(write >= read + require('../core/graphql/limits').MUTATION_COST, `write ${write} vs read ${read}`);

        const saved = config.api.graphql.maxCost;
        config.api.graphql.maxCost = 50;
        try {
            const before = await count("SELECT COUNT(*) FROM posts WHERE post_type != 'revision'");
            const r = await gqlAs('admin', `mutation { a: createPost(input: { title: "c1" }) { node { id } } b: createPost(input: { title: "c2" }) { node { id } } }`);
            assert.strictEqual(r.status, 400);
            assert.strictEqual(r.body.errors[0].extensions.code, 'GRAPHQL_COST_LIMIT');
            assert.strictEqual(await count("SELECT COUNT(*) FROM posts WHERE post_type != 'revision'"), before);
        } finally {
            config.api.graphql.maxCost = saved;
        }
    });
});

describe('uploadMedia: the GraphQL multipart request spec, re-streamed to POST /media', () => {
    const UPLOAD = 'mutation($file: Upload!, $input: MediaInput) { uploadMedia(file: $file, input: $input) { mediaItem { id mimeType title alt url } } }';
    function multipartAs(who: Who, file: Buffer, filename: string, contentType: string, input: any = null) {
        return (request(server) as any).post(`${API}/graphql`).set({ ...headersFor(who), Accept: 'application/json' })
            .field('operations', JSON.stringify({ query: UPLOAD, variables: { file: null, input } }))
            .field('map', JSON.stringify({ 0: ['variables.file'] }))
            .attach('0', file, { filename, contentType });
    }

    test('an author uploads an image; it is the same media item REST returns', async () => {
        const r = await multipartAs('alice', PNG_1PX, 'pixel.png', 'image/png', { title: 'Pixel', alt: 'one pixel' });
        assert.ok(!r.body.errors, JSON.stringify(r.body));
        const item = r.body.data.uploadMedia.mediaItem;
        assert.deepStrictEqual({ mimeType: item.mimeType, title: item.title, alt: item.alt }, { mimeType: 'image/png', title: 'Pixel', alt: 'one pixel' });
        const rest = await restAs('alice', 'get', `/media/${item.id}`);
        assert.strictEqual(rest.status, 200);
        assert.strictEqual(rest.body.guid, item.url);
        const upd = await gqlAs('alice', `mutation { updateMedia(id: ${item.id}, input: { alt: "new alt" }) { mediaItem { alt } } }`);
        assert.strictEqual(upd.body.data.updateMedia.mediaItem.alt, 'new alt');
        assertSameRefusal(
            await restAs('bob', 'delete', `/media/${item.id}`),
            await gqlAs('bob', `mutation { deleteMedia(id: ${item.id}) { deleted } }`),
            'deleteMedia', 'another author deletes media');
        assert.strictEqual((await gqlAs('alice', `mutation { deleteMedia(id: ${item.id}) { deleted } }`)).body.data.deleteMedia.deleted, true);
    });

    test('the REST file filter and capability apply: a forbidden type, a subscriber, a token without media:write', async () => {
        const restHtml = await restAs('alice', 'post', '/media').attach('file', Buffer.from('<script>x</script>'), { filename: 'x.html', contentType: 'text/html' });
        const gqlHtml = await multipartAs('alice', Buffer.from('<script>x</script>'), 'x.html', 'text/html');
        assertSameRefusal(restHtml, gqlHtml, 'uploadMedia', 'html upload');
        const forged = await multipartAs('alice', Buffer.from('not really a png'), 'fake.png', 'image/png');
        const restForged = await restAs('alice', 'post', '/media').attach('file', Buffer.from('not really a png'), { filename: 'fake.png', contentType: 'image/png' });
        assertSameRefusal(restForged, forged, 'uploadMedia', 'magic-byte mismatch');
        const restSub = await restAs('sub', 'post', '/media').attach('file', PNG_1PX, { filename: 'p.png', contentType: 'image/png' });
        assertSameRefusal(restSub, await multipartAs('sub', PNG_1PX, 'p.png', 'image/png'), 'uploadMedia', 'subscriber upload');
        const restTok = await restAs('postsWrite', 'post', '/media').attach('file', PNG_1PX, { filename: 'p.png', contentType: 'image/png' });
        assertSameRefusal(restTok, await multipartAs('postsWrite', PNG_1PX, 'p.png', 'image/png'), 'uploadMedia', 'posts:write token upload');
    });

    test('a malformed multipart request is refused before any resolver, and an Upload cannot be inlined', async () => {
        const noMap = await (request(server) as any).post(`${API}/graphql`).set(headersFor('alice'))
            .field('operations', JSON.stringify({ query: UPLOAD, variables: { file: null } }))
            .attach('0', PNG_1PX, { filename: 'p.png', contentType: 'image/png' });
        assert.strictEqual(noMap.status, 400);
        const proto = await (request(server) as any).post(`${API}/graphql`).set(headersFor('alice'))
            .field('operations', JSON.stringify({ query: UPLOAD, variables: { file: null } }))
            .field('map', JSON.stringify({ 0: ['__proto__.polluted'] }))
            .attach('0', PNG_1PX, { filename: 'p.png', contentType: 'image/png' });
        assert.strictEqual(proto.status, 400);
        assert.strictEqual(({} as any).polluted, undefined);
        const inline = await gqlAs('alice', 'mutation { uploadMedia(file: "x") { mediaItem { id } } }');
        assert.ok(inline.body.errors && inline.body.errors.length);
        const asJson = await gqlAs('alice', UPLOAD, { file: { filename: 'x.png', mimetype: 'image/png', data: 'AAAA' } });
        assert.ok(asJson.body.errors && asJson.body.errors.length, 'a JSON object is not an Upload');
    });
});
