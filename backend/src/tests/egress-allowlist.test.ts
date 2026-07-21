/**
 * Per-plugin egress ALLOWLIST (opt-in DiD for network-granted plugins).
 *
 * Unit-tests the enforcement core in egress-guard: setAllowedHosts() normalization + isHostAllowed()
 * matching. The critical properties: (1) no allowlist ⇒ unchanged allow-all-public (no regression for
 * shipped network plugins); (2) matching is exact OR subdomain at a LABEL boundary — never a substring,
 * so 'evil-stripe.com' can't ride an allowlist for 'stripe.com'; (3) the allowlist is ADDITIVE — it never
 * loosens isBlockedIp (a listed host that is a private/loopback IP is still blocked).
 */
const { test } = require('node:test');
const assert = require('node:assert');

const eg = require('../core/egress-guard');

function withAllowlist(list: any, fn: () => void) {
    try { eg.setAllowedHosts(list); fn(); } finally { eg.setAllowedHosts(null); }
}

test('no allowlist ⇒ every host allowed (unchanged behavior)', () => {
    eg.setAllowedHosts(null);
    assert.strictEqual(eg.isHostAllowed('anything.example.com'), true);
    assert.strictEqual(eg.isHostAllowed('1.2.3.4'), true);
    // An empty array also means "no allowlist" (so clearing the list restores allow-all).
    withAllowlist([], () => assert.strictEqual(eg.isHostAllowed('anything.example.com'), true));
});

test('exact host match, others denied', () => {
    withAllowlist(['api.stripe.com'], () => {
        assert.strictEqual(eg.isHostAllowed('api.stripe.com'), true);
        assert.strictEqual(eg.isHostAllowed('other.com'), false);
        assert.strictEqual(eg.isHostAllowed('stripe.com'), false, 'a parent of the listed host is NOT implied');
    });
});

test('bare-domain entry matches the apex and subdomains at a label boundary — never a substring', () => {
    withAllowlist(['stripe.com'], () => {
        assert.strictEqual(eg.isHostAllowed('stripe.com'), true, 'apex');
        assert.strictEqual(eg.isHostAllowed('api.stripe.com'), true, 'subdomain');
        assert.strictEqual(eg.isHostAllowed('a.b.stripe.com'), true, 'deep subdomain');
        assert.strictEqual(eg.isHostAllowed('evil-stripe.com'), false, 'label-boundary: NOT a substring match');
        assert.strictEqual(eg.isHostAllowed('stripe.com.evil.com'), false, 'suffix attack: listed host as a left label');
        assert.strictEqual(eg.isHostAllowed('notstripe.com'), false);
    });
});

test("'*.' / leading-dot entries normalize to the bare domain", () => {
    for (const entry of ['*.stripe.com', '.stripe.com', 'STRIPE.COM']) {
        withAllowlist([entry], () => {
            assert.strictEqual(eg.isHostAllowed('api.stripe.com'), true, `${entry} → subdomain`);
            assert.strictEqual(eg.isHostAllowed('stripe.com'), true, `${entry} → apex`);
            assert.strictEqual(eg.isHostAllowed('evil.com'), false, `${entry} → unrelated denied`);
        });
    }
});

test('case-insensitive + trailing-dot (FQDN) tolerant', () => {
    withAllowlist(['Api.Stripe.COM'], () => {
        assert.strictEqual(eg.isHostAllowed('api.stripe.com'), true);
        assert.strictEqual(eg.isHostAllowed('API.STRIPE.COM'), true);
        assert.strictEqual(eg.isHostAllowed('api.stripe.com.'), true, 'trailing dot stripped');
    });
});

test('IP-literal entries match EXACTLY, never as a suffix', () => {
    withAllowlist(['203.0.113.4'], () => {
        assert.strictEqual(eg.isHostAllowed('203.0.113.4'), true);
        assert.strictEqual(eg.isHostAllowed('203.0.113.40'), false, 'not a numeric suffix match');
        assert.strictEqual(eg.isHostAllowed('4.203.0.113'), false);
        assert.strictEqual(eg.isHostAllowed('sub.203.0.113.4'), false, 'IP is not a domain suffix');
    });
});

test('IPv6 literals: bracketed (URL-derived) and spelling variants match a bare entry', () => {
    withAllowlist(['2606:4700:4700::1111'], () => {
        // URL.hostname keeps the [] brackets for IPv6 — fetch/WS/http paths pass a bracketed host.
        assert.strictEqual(eg.isHostAllowed('[2606:4700:4700::1111]'), true, 'bracketed form (URL path)');
        assert.strictEqual(eg.isHostAllowed('2606:4700:4700::1111'), true, 'bare form (socket path)');
        assert.strictEqual(eg.isHostAllowed('2606:4700:4700:0:0:0:0:1111'), true, 'expanded spelling canonicalizes');
        assert.strictEqual(eg.isHostAllowed('2606:4700:4700::2222'), false, 'a different v6 address is denied');
        assert.strictEqual(eg.isHostAllowed('example.com'), false, 'a hostname never matches an IP entry');
    });
});

test('no-host / undefined target is denied under an allowlist (default-localhost connect)', () => {
    withAllowlist(['api.stripe.com'], () => {
        assert.strictEqual(eg.isHostAllowed(undefined), false);
        assert.strictEqual(eg.isHostAllowed(''), false);
    });
});

test('allowlist is ADDITIVE: it never loosens isBlockedIp (a listed private IP is still blocked)', () => {
    // Even if an admin lists a private/loopback/metadata IP, isBlockedIp (the separate, first-applied gate)
    // still denies it — isHostAllowed only narrows which PUBLIC hosts are reachable.
    withAllowlist(['127.0.0.1', '169.254.169.254', '10.0.0.5'], () => {
        assert.strictEqual(eg.isHostAllowed('127.0.0.1'), true, 'isHostAllowed alone would permit it...');
        assert.strictEqual(eg.isBlockedIp('127.0.0.1'), true, '...but isBlockedIp still blocks loopback');
        assert.strictEqual(eg.isBlockedIp('169.254.169.254'), true, 'metadata still blocked');
        assert.strictEqual(eg.isBlockedIp('10.0.0.5'), true, 'RFC1918 still blocked');
    });
});
