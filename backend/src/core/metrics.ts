/**
 * WordJS — Prometheus metrics.
 *
 * Exposes default Node/process metrics (CPU, RSS/heap, event-loop lag, GC, handles) plus a few
 * app-level gauges, in Prometheus text format. Served at GET /metrics, which is DISABLED unless a
 * scrape token is configured (config.metrics.token) — so metrics are never leaked publicly by default.
 */

const client = require('prom-client');

const register = new client.Registry();
register.setDefaultLabels({ app: 'wordjs' });
client.collectDefaultMetrics({ register, prefix: 'wordjs_' });

// App-level gauges, refreshed at scrape time.
const sseClients = new client.Gauge({ name: 'wordjs_sse_clients', help: 'Active SSE clients connected to this node', registers: [register] });
const ready = new client.Gauge({ name: 'wordjs_ready', help: '1 when the app is installed, booted and serving; else 0', registers: [register] });

/** Render the current metrics as Prometheus text (refreshing app gauges first). */
async function metricsText(): Promise<string> {
    try {
        const notifications = require('./notifications');
        sseClients.set(notifications && notifications.clients ? notifications.clients.size : 0);
    } catch { /* notifications not loaded — leave gauge as-is */ }
    return register.metrics();
}

module.exports = { register, metricsText, contentType: register.contentType, readyGauge: ready };
