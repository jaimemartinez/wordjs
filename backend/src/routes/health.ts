import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const SystemHealth = require('../core/system-health');
const database = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
// See middleware/errorHandler: an unrecognised failure's own text never crosses the wire.
const { publicErrorText } = require('../middleware/errorHandler');

/**
 * Public high-level health check (Gateway use)
 */
/**
 * @swagger
 * /health:
 *   get:
 *     summary: Check gateway and basic database health
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: System is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 timestamp:
 *                   type: string
 */
router.get('/', async (req: Request, res: Response) => {
    const status = await SystemHealth.checkDatabase();
    res.json({
        status: status.status === 'OK' ? 'ok' : 'error',
        timestamp: new Date().toISOString()
    });
});

/**
 * @swagger
 * /health/details:
 *   get:
 *     summary: Get detailed system status
 *     description: >
 *       Returns status of database, mTLS security, filesystem, plugin sandbox and on-demand cache
 *       purging. Requires Admin privileges. `purge.broken` lists the PERMANENT failures that have
 *       killed on-demand cache invalidation in this process (e.g. a refused cluster TLS handshake);
 *       when it is non-empty, published changes only become visible when the ISR window expires and
 *       nothing will recover without a configuration fix.
 *
 *
 *       `sandbox.kernel` reports the native confinement layer (`landlock`, `appcontainer`, `seatbelt`,
 *       or `none`) and the probe result on this host:
 *
 *
 *       * `mechanism: none` + `state: unsupported` — this platform has no such layer; there is nothing
 *         to install or enable.
 *       * `state: disabled` — an operator explicitly opted out of the native layer.
 *       * `mechanism: <any>` + `state: degraded` — it WAS turned on and its probe could not demonstrate
 *         confinement here, so plugins run without it. This is the one state that needs a human; it is
 *         also surfaced as the boolean `sandbox.kernelDegraded`.
 *       * `state: active` — real children proved filesystem/process confinement and both network-policy
 *         shapes. No layer reports `active` on weaker evidence.
 *
 *
 *       `kernel.appliesTo` is every isolated production plugin on every supported OS. A network grant
 *       changes only egress; that platform's filesystem/process boundary stays active.
 *
 *
 *       `sandbox.kernel.floor` is Linux-only. `landlock+seccomp` needs no user namespace, sysctl or
 *       separately installed sandbox executable. Landlock scopes reads/writes and cross-process access;
 *       seccomp removes process-creation/anonymous-executable/dangerous syscalls, denies every new socket
 *       without a network grant, and admits only AF_INET/AF_INET6 client sockets with one.
 *
 *
 *       * `floor.inForce: landlock+seccomp` — the zero-configuration Linux layer was certified.
 *       * `floor.inForce: none` — there is genuinely no kernel floor. This is the state that used to be
 *         reported identically to the one above it, and it is the only one that is a call to action.
 *
 *
 *       `sandbox.useKernelHardening: false` explicitly turns the Linux layer off.
 *
 *
 *       `sandbox.cpu` is the CPU bound isolated plugins actually have on this host: `preventive`
 *       (a kernel ceiling — cgroup `CPUQuota` or the Windows Job Object rate cap), `reactive` (no
 *       ceiling, but the host-side poll SIGKILLs a sustained burn) or `unbounded` (neither: a plugin
 *       can peg a core indefinitely). `unbounded` is the only call to action, and it also raises the
 *       persistent admin notice `sandbox.cgroup-no-cpu-quota`; the fix is `sandbox.cpuQuotaPercent`.
 *
 *
 *       `database.degraded` is true when the manager fell back to the pure-JS `sqlite-legacy` driver
 *       because the requested SQLite driver would not load. That driver has NO full-text index, so
 *       ranked search is unavailable and site search matches with LIKE; `database.reason` names the
 *       load failure. `database.driver` is the driver that is ACTUALLY running, which is not
 *       necessarily the configured `dbDriver`. The same condition raises the persistent admin notice
 *       `db.sqlite-legacy-fallback`, and both retire on a boot that loads the requested driver.
 *     tags: [Health]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Detailed status object
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 database:
 *                   type: object
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [OK, ERROR]
 *                     driver:
 *                       type: string
 *                       description: The driver ACTUALLY in use, which may differ from the configured dbDriver.
 *                       example: sqlite-native
 *                     degraded:
 *                       type: boolean
 *                       description: True when the manager fell back to the pure-JS sqlite-legacy driver (no full-text index).
 *                     reason:
 *                       type: string
 *                       description: Present only when degraded — the load failure that forced the fallback, and what it costs.
 *                 mtls:
 *                   type: object
 *                 filesystem:
 *                   type: object
 *                 sandbox:
 *                   type: object
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [OK, DEGRADED, REFUSING, NOT_HARDENED, UNKNOWN]
 *                     platform:
 *                       type: string
 *                       example: linux
 *                     cpu:
 *                       type: string
 *                       description: >
 *                         The CPU bound isolated plugins actually have. `preventive` = kernel ceiling
 *                         (cgroup CPUQuota / Windows Job Object rate cap); `reactive` = the host-side
 *                         poll kills a sustained burn; `unbounded` = no bound at all.
 *                       enum: [unbounded, preventive, reactive]
 *                     hardening:
 *                       type: string
 *                       description: Native sandbox state for this operating system.
 *                       enum: [unknown, unsupported, disabled, active, degraded]
 *                     network:
 *                       type: string
 *                       description: Native network-policy probe state.
 *                       enum: [unknown, unsupported, disabled, active, degraded]
 *                     permission:
 *                       type: string
 *                       description: Node's own C++-enforced permission model — the one layer that is not platform-specific.
 *                       enum: [unknown, unsupported, disabled, active, degraded]
 *                     kernelDegraded:
 *                       type: boolean
 *                       description: True ONLY when this platform's kernel layer was enabled and its probe could not demonstrate confinement.
 *                     kernel:
 *                       type: object
 *                       properties:
 *                         mechanism:
 *                           type: string
 *                           enum: [landlock, appcontainer, seatbelt, none]
 *                         state:
 *                           type: string
 *                           enum: [unknown, unsupported, disabled, active, degraded]
 *                         appliesTo:
 *                           type: string
 *                         note:
 *                           type: string
 *                         network:
 *                           type: object
 *                           properties:
 *                             mechanism:
 *                               type: string
 *                             state:
 *                               type: string
 *                               enum: [unknown, unsupported, disabled, active, degraded]
 *                         floor:
 *                           type: object
 *                           description: LINUX ONLY. Landlock/seccomp floor state.
 *                           properties:
 *                             inForce:
 *                               type: string
 *                               enum: [landlock+seccomp, none]
 *                             layers:
 *                               type: object
 *                               properties:
 *                                 landlock:
 *                                   type: object
 *                                   properties:
 *                                     state:
 *                                       type: string
 *                                       enum: [unknown, unsupported, disabled, active, degraded]
 *                                     note:
 *                                       type: string
 *                 purge:
 *                   type: object
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [OK, BROKEN, UNKNOWN]
 *                     broken:
 *                       type: array
 *                       items:
 *                         type: string
 *                     transport:
 *                       type: string
 *                     target:
 *                       type: string
 *                 contentOutbox:
 *                   type: object
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [OK, DEGRADED, ERROR, UNKNOWN]
 *                     pending:
 *                       type: integer
 *                     processing:
 *                       type: integer
 *                     dead:
 *                       type: integer
 *                     delayedSeconds:
 *                       type: integer
 *                 audit:
 *                   type: object
 *                   description: What the daily audit-log retention prune last did.
 *                   properties:
 *                     retentionDays:
 *                       type: integer
 *                       nullable: true
 *                       description: >-
 *                         The window the last prune used (0 = pruning is switched off), or null when no
 *                         prune has run in this process yet.
 *                     behind:
 *                       type: boolean
 *                       description: >-
 *                         True when the last run stopped at a cap with rows still outside the window —
 *                         retention is losing the race against the write side, exactly as
 *                         `database.degraded` reports a driver that is not the one that was asked for.
 *                     lastRunAt:
 *                       type: integer
 *                       nullable: true
 *                       description: Epoch milliseconds of the last prune, or null if it has not run.
 *                     lastRemoved:
 *                       type: integer
 *                     lastError:
 *                       type: string
 *                       nullable: true
 *       403:
 *         description: Forbidden (Non-admin)
 */
/**
 * TWO SILENT DEGRADATIONS, ADDED TO THE REPORT.
 *
 * Both were real, permanent and announced exactly once — as a console line on a boot nobody watches,
 * the same shape as the dead purge channel this endpoint already reports:
 *
 *   · `database.degraded` — the manager falls back from 'sqlite-native' to the pure-JS
 *     'sqlite-legacy' driver whenever the native binary is missing. That driver has no FTS5, so
 *     ranked full-text search is gone and site search quietly becomes LIKE matching.
 *     `database.driver` is deliberately the ACTIVE driver: SystemHealth.checkDatabase() answers from
 *     `config.dbDriver`, which is what the operator ASKED for, so on the one host where the fallback
 *     had fired the panel confidently named the driver that was NOT running.
 *   · `sandbox.cpu` — whether isolated plugins have a CPU bound at all, and of which kind. The one
 *     value that is a call to action is 'unbounded'.
 *
 * Merged here rather than inside SystemHealth so the two facts are read from the modules that OWN
 * them (the database manager and the isolate) instead of being re-derived from configuration — which
 * is precisely how `database.driver` came to be wrong. Never throws: this is the page an operator
 * opens when things are already broken.
 */
function withDegradationFields(status: any): any {
    const report = status && typeof status === 'object' ? status : {};

    const databaseSection: any = report.database || {};
    let degradation: any = null;
    let activeDriver: string | undefined;
    try {
        if (typeof database.getDriverDegradation === 'function') degradation = database.getDriverDegradation();
        activeDriver = database.getDbType().driver;
    } catch { /* the manager is the subject of this report — it must not be able to break it */ }
    report.database = {
        ...databaseSection,
        driver: activeDriver || databaseSection.driver,
        degraded: !!degradation,
        ...(degradation ? { reason: degradation.reason } : {}),
    };

    // Fail LOUD: an isolate module we cannot ask is not evidence of a cap, so the unknown answer is
    // the alarming one, never the reassuring one.
    let cpu = 'unbounded';
    try {
        const iso = require('../core/plugin-isolate');
        if (typeof iso.getSandboxCpuBound === 'function') cpu = iso.getSandboxCpuBound();
    } catch { /* isolate module unavailable */ }
    report.sandbox = { ...(report.sandbox || {}), cpu };

    // A THIRD DEGRADATION OF THE SAME CLASS. core/audit.ts prunes the audit log once a day and latches
    // what the run did — including `behind`, which means it stopped at a cap with rows still outside
    // the window, i.e. retention is losing the race against the write side (and this is the table every
    // failed login writes to, from an unauthenticated surface). That state was exported for a health
    // surface and read by nobody, so the ONLY trace was a console.warn on a tick nobody watches: the
    // exact shape of the dead purge channel this endpoint already reports.
    try {
        const { auditRetentionState } = require('../core/audit');
        const retention = auditRetentionState();
        report.audit = {
            ...(report.audit || {}),
            retentionDays: retention.retentionDays,
            behind: !!retention.behind,
            lastRunAt: retention.lastRunAt,
            lastRemoved: retention.lastRemoved,
            lastError: retention.lastError,
        };
    } catch { /* the audit module is not reportable — never break the page an operator opens when things are broken */ }

    return report;
}

router.get('/details', authenticate, isAdmin, async (req: Request, res: Response) => {
    try {
        const fullStatus = await SystemHealth.getFullStatus();
        res.json(withDegradationFields(fullStatus));
    } catch (err) {
        console.error('[health] /details failed:', err);
        res.status(500).json({ error: publicErrorText(err, 'The system health report could not be produced.') });
    }
});

module.exports = router;
