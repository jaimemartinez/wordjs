/**
 * The Bayesian spam verdict must have EVIDENCE before it files mail as spam.
 *
 * Found in the production lab: after one message was marked spam and one not-spam, the library's
 * categorize() tied on every text made of unseen words and broke the tie towards 'spam' — a normal,
 * SPF-authenticated message went to Spam and lost its vacation reply and forward. The plugin's
 * isLikelySpam() now needs a minimum of training per class, counts only seen words and wants a clear
 * margin. This suite runs the SHIPPED function (sliced out of index.js) over the REAL `bayes` library.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const SRC = fs.readFileSync(path.resolve(__dirname, '../../../marketplace/plugins/mail-server/index.js'), 'utf8');
const start = SRC.indexOf('const BAYES_MIN_DOCS');
const end = SRC.indexOf('\n}\n', SRC.indexOf('async function isLikelySpam')) + 3;
assert.ok(start > 0 && end > start, 'isLikelySpam and its constants were not found in the plugin source');
const isLikelySpam: (c: any, text: string) => Promise<boolean> =
    vm.runInThisContext(`(function(){ ${SRC.slice(start, end)}; return isLikelySpam; })()`);
const bayes = require('bayes');

const NORMAL = 'Consulta de Carlos. Hola, ¿tienes un minuto mañana para revisar el presupuesto?';

test('one example of each class is not evidence: nothing is filed as spam', async () => {
    const c = bayes();
    await c.learn('Boletín semanal número 55 contenido del boletín', 'spam');
    await c.learn('Boletín semanal número 55 contenido del boletín', 'ham');
    assert.equal(await c.categorize(NORMAL), 'spam', 'precondition: the raw library ties and picks spam');
    assert.equal(await isLikelySpam(c, NORMAL), false);
});

test('with enough training, obvious spam is caught and normal mail is not', async () => {
    const c = bayes();
    const spam = ['GANA DINERO RAPIDO gratis casino', 'oferta exclusiva viagra gratis', 'premio loteria gratis haz clic',
        'casino bonus gratis dinero rapido', 'gana premio gratis clic aqui', 'dinero facil casino gratis ya'];
    const ham = ['reunion del jueves a las once', 'adjunto el presupuesto revisado', 'factura del mes disponible',
        'nos vemos en la oficina mañana', 'revisa el documento del proyecto', 'gracias por la reunion de hoy'];
    for (const t of spam) await c.learn(t, 'spam');
    for (const t of ham) await c.learn(t, 'ham');
    assert.equal(await isLikelySpam(c, 'GANA DINERO gratis en el casino, haz clic'), true);
    assert.equal(await isLikelySpam(c, 'Te paso el presupuesto para la reunion del jueves'), false);
    assert.equal(await isLikelySpam(c, 'zxqw plorf blenk'), false, 'only unseen words: no evidence, no verdict');
});

test('a broken classifier never files mail away', async () => {
    assert.equal(await isLikelySpam(null, NORMAL), false);
    assert.equal(await isLikelySpam({ docCount: { spam: 9, ham: 9 }, tokenizer: () => { throw new Error('x'); } }, NORMAL), false);
});
