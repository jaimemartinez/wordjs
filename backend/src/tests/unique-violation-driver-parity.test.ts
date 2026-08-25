/**
 * A unique-index collision must read as a collision on every driver we ship — and there must be
 * exactly one place that decides so.
 *
 * The defect this locks down: there were two `isUniqueViolation()` helpers. `core/revisions.ts` knew
 * SQLite, PostgreSQL and MySQL; `models/User.ts` knew only SQLite and PostgreSQL, and its doc comment
 * enumerated exactly those two — so it read as complete. On MySQL that meant `User.create()` and
 * `User.update()` never recognised `ER_DUP_ENTRY`: registering a taken username, or moving an account
 * to an email already in use, fell past the catch that turns the collision into
 * "Username or email already exists" and surfaced as a raw driver 500.
 *
 * Nothing caught it because the suite runs on SQLite, where both copies agree.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const { isUniqueViolation } = require('../core/db-errors');

// The shapes each driver actually throws. mysql2 sets both `code` and `errno`; some wrappers forward
// only one, so both must stand alone.
const COLLISIONS: Array<[string, any]> = [
    ['sqlite: unique index', { code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'UNIQUE constraint failed: users.user_login' }],
    ['sqlite: primary key', { code: 'SQLITE_CONSTRAINT_PRIMARYKEY', message: 'UNIQUE constraint failed: users.id' }],
    ['postgres: 23505', { code: '23505', message: 'duplicate key value violates unique constraint "users_user_login_key"' }],
    ['mysql: ER_DUP_ENTRY', { code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000', message: "Duplicate entry 'admin' for key 'users.user_login'" }],
    ['mysql: errno only', { errno: 1062, message: "Duplicate entry 'admin' for key 'users.user_login'" }],
    ['mysql: code only', { code: 'ER_DUP_ENTRY' }],
    ['wrapper that kept only the words', { message: "Duplicate entry 'a@b.c' for key 'users.user_email'" }],
];

for (const [label, err] of COLLISIONS) {
    test(`recognised as a unique violation — ${label}`, () => {
        assert.strictEqual(isUniqueViolation(err), true, `${label} was not recognised`);
    });
}

test('does not swallow constraint failures a retry cannot fix', () => {
    // Callers use this to decide whether to retry with a fresh name, or to report "already exists".
    // A NOT NULL or CHECK failure answered true would be retried forever, or reported as a name
    // collision that no rename resolves — so the umbrella SQLITE_CONSTRAINT must NOT match.
    assert.strictEqual(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_NOTNULL', message: 'NOT NULL constraint failed: users.user_email' }), false);
    assert.strictEqual(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_CHECK', message: 'CHECK constraint failed: users' }), false);
    assert.strictEqual(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY', message: 'FOREIGN KEY constraint failed' }), false);
    assert.strictEqual(isUniqueViolation({ code: '23503', message: 'insert or update violates foreign key constraint' }), false);
    assert.strictEqual(isUniqueViolation({ code: 'ER_NO_SUCH_TABLE', errno: 1146 }), false);
});

test('absent and malformed errors do not throw', () => {
    for (const bad of [null, undefined, {}, 0, '', { code: null }, { message: null }]) {
        assert.strictEqual(isUniqueViolation(bad as any), false, `threw or matched on ${JSON.stringify(bad)}`);
    }
});

test('exactly one module defines the predicate', () => {
    // THE CLASS FIX. Two copies of a predicate is a divergence problem, not a duplication one: the
    // copy that gets a new driver added is whichever one someone happened to be reading. If this
    // fails, a second definition has reappeared — move it into core/db-errors.ts instead.
    const root = path.resolve(__dirname, '..');
    const found: string[] = [];

    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === 'tests') continue;
                walk(full);
            } else if (entry.name.endsWith('.ts')) {
                const src = fs.readFileSync(full, 'utf8');
                if (/\b(?:function|const|let)\s+isUniqueViolation\b/.test(src)) {
                    found.push(path.relative(root, full).replace(/\\/g, '/'));
                }
            }
        }
    };
    walk(root);

    assert.deepStrictEqual(found, ['core/db-errors.ts'],
        `isUniqueViolation must be defined once, in core/db-errors.ts. Found in: ${found.join(', ')}`);
});
