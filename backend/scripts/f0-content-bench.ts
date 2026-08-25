/** Reproducible F0 content-operation microbenchmark with committed p95 regression ceilings. */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { performance } from 'perf_hooks';

const ROOT = path.resolve(__dirname, '..');
const budgets = JSON.parse(fs.readFileSync(path.join(ROOT, 'f0-performance-budgets.json'), 'utf8'));
const warmups = Number(budgets.measurement.warmupIterations);
const samples = Number(budgets.measurement.sampleIterations);
const enforce = process.argv.includes('--enforce');
const jsonOnly = process.argv.includes('--json');
const dbFile = path.join(os.tmpdir(), `wjs-f0-bench-${process.pid}-${Date.now()}.db`);

const config = require('../src/config/app');
config.dbPath = dbFile;
config.dbDriver = 'sqlite-native';
const database = require('../src/config/database');
const postTypes = require('../src/core/post-types');
const Post = require('../src/models/Post');
const { saveRevision } = require('../src/core/revisions');

function percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[index];
}

async function measure(iterations: number, fn: (index: number) => Promise<void>): Promise<number[]> {
    const values: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await fn(i);
        values.push(Number((performance.now() - start).toFixed(3)));
    }
    return values;
}

async function main(): Promise<void> {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await postTypes.initPostTypes();

    let sequence = 0;
    const makePost = async (prefix: string) => await Post.create({
        authorId: 0,
        title: `${prefix} ${process.pid} ${++sequence}`,
        content: '<p>F0 benchmark content</p>',
        status: 'draft',
    });

    for (let i = 0; i < warmups; i++) {
        const post = await makePost('warmup');
        await Post.updateMeta(post.id, 'f0_bench', i);
        await Post.update(post.id, { excerpt: `warm ${i}` });
        await saveRevision(post.id);
        await Post.findAllWithRelations({ limit: 10, status: 'draft' });
    }

    const created: any[] = [];
    const postCreate = await measure(samples, async () => { created.push(await makePost('create')); });
    const postUpdate = await measure(samples, async (i) => { await Post.update(created[i].id, { excerpt: `update ${i}` }); });
    const metaWrite = await measure(samples, async (i) => { await Post.updateMeta(created[i].id, 'f0_bench', { i, ok: true }); });
    const revisionSave = await measure(samples, async (i) => { await saveRevision(created[i].id); });
    const postList = await measure(samples, async () => { await Post.findAllWithRelations({ limit: 10, status: 'draft' }); });

    const raw: Record<string, number[]> = { postCreate, postUpdate, metaWrite, revisionSave, postList };
    const measured: Record<string, number> = {};
    for (const [name, values] of Object.entries(raw)) measured[`${name}P95`] = Number(percentile(values, 95).toFixed(3));
    const report = {
        schemaVersion: 1,
        environment: { node: process.version, platform: process.platform, arch: process.arch },
        iterations: { warmups, samples },
        p95Milliseconds: measured,
        budgets: budgets.contentMilliseconds,
        rawMilliseconds: raw,
    };
    process.stdout.write(`${JSON.stringify(report, null, jsonOnly ? 0 : 2)}\n`);

    if (enforce) {
        const failures: string[] = [];

        // Walk the BUDGET table: every declared ceiling must be measured and respected.
        for (const [name, ceiling] of Object.entries(budgets.contentMilliseconds)) {
            const actual = measured[name];
            if (!Number.isFinite(actual)) failures.push(`${name} was not measured`);
            else if (actual > Number(ceiling)) failures.push(`${name}: ${actual}ms > ${ceiling}ms`);
        }

        // Walk the MEASUREMENTS: every operation this harness times must have a ceiling.
        //
        // Without this second direction the loop above is a one-way gate. It catches a REMOVED
        // measurement — a ceiling with nothing behind it — and is blind to an ADDED one: a new content
        // operation nobody wrote a budget for gets measured, printed in the report as though it were
        // covered, and silently unenforced for ever. Rendering is the case that proves this is not
        // hypothetical: the F6 plan names it as one of the four operations to certify, this file has
        // never budgeted it, and no run of `--enforce` ever said a word.
        //
        // Adding an operation is now deliberately a two-file change. Measuring something and deciding
        // what counts as too slow are the same decision; splitting them is how the blind spot appeared.
        for (const name of Object.keys(measured)) {
            if (!(name in budgets.contentMilliseconds)) {
                failures.push(`${name} is measured but has no ceiling in f0-performance-budgets.json — add one, because an unbudgeted measurement is never enforced`);
            }
        }

        if (failures.length) throw new Error(`F0 performance budget exceeded:\n${failures.join('\n')}`);
    }
}

main()
    .catch((error: any) => { console.error(error && error.stack || error); process.exitCode = 1; })
    .finally(async () => {
        try { await database.closeDatabase(); } catch { /* best effort */ }
        for (const file of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
            try { if (fs.existsSync(file)) fs.rmSync(file, { force: true }); } catch { /* best effort */ }
        }
    });
