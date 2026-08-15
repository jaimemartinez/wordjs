/**
 * S3 SigV4 signing-key derivation — pinned against the AWS-documented ALGORITHM and an external hash
 * known-answer, not merely the signature's shape.
 *
 * The existing s3-offload tests assert the authorization's shape (an AWS4-HMAC-SHA256 header with a
 * 64-hex signature). This pins the cryptographic CORE — the HMAC chain where a subtle structural bug
 * (a dropped "AWS4" prefix, a swapped region/service step, a wrong "aws4_request" literal) would pass a
 * shape check yet make real S3 reject every upload.
 *
 * The oracle is an INDEPENDENT re-implementation of the exact steps AWS documents at
 * docs.aws.amazon.com/general/latest/gr/signature-v4-examples.html ("Derive a signing key for SigV4"):
 *   DateKey            = HMAC-SHA256("AWS4"+SecretAccessKey, YYYYMMDD)
 *   DateRegionKey      = HMAC-SHA256(DateKey, region)
 *   DateRegionServiceKey = HMAC-SHA256(DateRegionKey, service)
 *   SigningKey         = HMAC-SHA256(DateRegionServiceKey, "aws4_request")
 * Written from the spec, not by calling the code under test, so a structural regression in the impl
 * diverges from this reference and fails. Anchored to a true EXTERNAL constant: SHA-256("") =
 * e3b0c442… (AWS's own docs use it as the empty-payload x-amz-content-sha256), proving the primitive.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { deriveSigningKey } = require('../core/s3-offload');

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// Independent, spec-faithful reference — deliberately NOT importing the impl's helper.
function specSigningKey(secret: string, date: string, region: string, service: string): Buffer {
    const H = (k: any, d: string) => crypto.createHmac('sha256', k).update(d, 'utf8').digest();
    return H(H(H(H('AWS4' + secret, date), region), service), 'aws4_request');
}

test('the SHA-256 primitive matches AWS\'s documented empty-payload constant', () => {
    // If this drifts, the whole SigV4 assumption is off — anchor first.
    assert.strictEqual(crypto.createHash('sha256').update('').digest('hex'), EMPTY_SHA256);
});

test('deriveSigningKey reproduces the AWS-documented derivation, byte for byte', () => {
    for (const [secret, date, region, service] of [
        ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam'],
        ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', '20130524', 'us-east-1', 's3'],
        ['a-different-secret', '20260101', 'eu-west-1', 's3'],
    ] as const) {
        assert.strictEqual(
            Buffer.from(deriveSigningKey(secret, date, region, service)).toString('hex'),
            specSigningKey(secret, date, region, service).toString('hex'),
            `derivation diverged from the AWS spec for ${date}/${region}/${service}`,
        );
    }
});

test('the derivation is sensitive to every input (not a constant or a mixed-up step)', () => {
    const base = Buffer.from(deriveSigningKey('secret', '20120215', 'us-east-1', 's3')).toString('hex');
    assert.notStrictEqual(base, Buffer.from(deriveSigningKey('secret2', '20120215', 'us-east-1', 's3')).toString('hex'));
    assert.notStrictEqual(base, Buffer.from(deriveSigningKey('secret', '20120216', 'us-east-1', 's3')).toString('hex'));
    assert.notStrictEqual(base, Buffer.from(deriveSigningKey('secret', '20120215', 'eu-west-1', 's3')).toString('hex'));
    assert.notStrictEqual(base, Buffer.from(deriveSigningKey('secret', '20120215', 'us-east-1', 'iam')).toString('hex'));
    // region and service are NOT interchangeable (a swapped-step bug):
    assert.notStrictEqual(
        Buffer.from(deriveSigningKey('secret', '20120215', 'us-east-1', 's3')).toString('hex'),
        Buffer.from(deriveSigningKey('secret', '20120215', 's3', 'us-east-1')).toString('hex'),
    );
});
