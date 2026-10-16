/**
 * DNSBL verdicts through the host's TXT lookup.
 *
 * Found in the production lab: the plugin called require('dnsbl'), which resolves A records with the
 * raw resolver the sandbox denies — and the host DNS bridge strips loopback answers anyway, so a
 * 127.0.0.x listing could never be seen. Every connection logged a lookup error and DNSBL protected
 * nothing. dnsblListed() now asks for the listing's TXT record through the bridge. This suite runs the
 * SHIPPED function (sliced out of index.js) over a stubbed bridge resolver.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const SRC = fs.readFileSync(path.resolve(__dirname, '../../../marketplace/plugins/mail-server/index.js'), 'utf8');
const start = SRC.indexOf('const DNSBL_ZONE');
const end = SRC.indexOf('\n}\n', SRC.indexOf('async function dnsblListed')) + 3;
assert.ok(start > 0 && end > start, 'dnsblListed was not found in the plugin source');

function load(resolveTxt: (name: string) => Promise<any>) {
    const asked: string[] = [];
    const dns = { resolveTxt: (n: string) => { asked.push(n); return resolveTxt(n); } };
    const fn = vm.runInNewContext(`(function(){ ${SRC.slice(start, end)}; return dnsblListed; })()`, { dns });
    return { dnsblListed: fn as (ip: string) => Promise<boolean | null>, asked };
}
const nx = () => Promise.reject(Object.assign(new Error('queryTxt ENOTFOUND x'), { code: 'ENOTFOUND' }));

test('a listed IP is found by its TXT record on the reversed name', async () => {
    const { dnsblListed, asked } = load(async () => [['Listed by XBL, see https://check.spamhaus.org/query/ip/203.0.113.9']]);
    assert.equal(await dnsblListed('203.0.113.9'), true);
    assert.deepEqual(asked, ['9.113.0.203.zen.spamhaus.org']);
});

test('NXDOMAIN means not listed', async () => {
    assert.equal(await load(nx).dnsblListed('198.51.100.7'), false);
});

test('no verdict (fail open) for a refused query, a resolver error, IPv6 or garbage', async () => {
    const refused = load(async () => [['Error: open resolver; https://check.spamhaus.org/returnc/pub/203.0.113.9']]);
    assert.equal(await refused.dnsblListed('203.0.113.9'), null);
    const broken = load(() => Promise.reject(Object.assign(new Error('queryTxt ETIMEOUT'), { code: 'ETIMEOUT' })));
    assert.equal(await broken.dnsblListed('203.0.113.9'), null);
    const never = load(async () => { throw new Error('must not be asked'); });
    assert.equal(await never.dnsblListed('2001:db8::1'), null);
    assert.equal(await never.dnsblListed('999.1.1.1'), null);
    assert.equal(never.asked.length, 0);
});
