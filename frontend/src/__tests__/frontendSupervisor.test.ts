/**
 * scripts/start-frontend.js supervises the Next server (QA S2-03): a crash — including a kill by signal,
 * which closes with code null and used to make the script exit 0 and take the whole split service down
 * with it — is restarted with a back-off; 75 restarts at once; only a clean exit or a stop request ends it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { backoffMs, nextAction, MAX_BACKOFF_MS } = require("../../scripts/frontend-supervisor.js");
const START_SCRIPT = path.resolve(__dirname, "../../scripts/start-frontend.js");

describe("what the frontend supervisor does when server.js stops", () => {
    it("a kill by signal is a crash, not a clean stop", () => {
        expect(nextAction(null, "SIGKILL", false)).toEqual({ action: "crash" });
        expect(nextAction(1, null, false)).toEqual({ action: "crash" });
        expect(nextAction(0, null, false)).toEqual({ action: "exit", code: 0 });
        expect(nextAction(75, null, false)).toEqual({ action: "restart" });
    });
    it("once told to stop it exits whatever server.js answered", () => {
        expect(nextAction(null, "SIGTERM", true)).toEqual({ action: "exit", code: 0 });
        expect(nextAction(75, null, true)).toEqual({ action: "exit", code: 75 });
    });
    it("the delay doubles per crash in a row, capped", () => {
        expect([1, 2, 3, 4].map(backoffMs)).toEqual([1000, 2000, 4000, 8000]);
        expect(backoffMs(50)).toBe(MAX_BACKOFF_MS);
    });
});

describe("start-frontend.js starts a crashed server.js again", () => {
    let proc: ChildProcess | null = null;
    let dir = "";
    afterEach(() => {
        try { proc?.kill(); } catch { /* gone */ }
        // On Windows a killed parent leaves its child: stop the fake server by the pid it wrote.
        try { process.kill(Number(fs.readFileSync(path.join(dir, "server.pid"), "utf8")), "SIGKILL"); } catch { /* gone */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    it("a server that kills itself on its first run is running again a moment later", async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "wjs-fe-supervisor-"));
        fs.writeFileSync(path.join(dir, "wordjs-config.json"), JSON.stringify({ frontendPort: 39123 }));
        // First run: record it and die as an out-of-memory kill would. Second run: record it and stay up.
        fs.writeFileSync(path.join(dir, "server.js"), [
            "const fs = require('fs');",
            "const runs = (fs.existsSync('runs') ? Number(fs.readFileSync('runs', 'utf8')) : 0) + 1;",
            "fs.writeFileSync('runs', String(runs));",
            "fs.writeFileSync('server.pid', String(process.pid));",
            "if (runs === 1) process.kill(process.pid, 'SIGKILL');",
            "setInterval(() => {}, 1000);",
        ].join("\n"));
        proc = spawn(process.execPath, [START_SCRIPT, "prod"], {
            cwd: dir,
            env: { ...process.env, NODE_EXTRA_CA_CERTS: "", WORDJS_LOCAL_GATEWAY_ORIGIN: "none" },
            stdio: "ignore",
        });
        let exited: number | null | undefined;
        proc.on("exit", (code) => { exited = code; });
        const runs = () => (fs.existsSync(path.join(dir, "runs")) ? Number(fs.readFileSync(path.join(dir, "runs"), "utf8")) : 0);
        for (let i = 0; i < 80 && runs() < 2; i++) await new Promise((r) => setTimeout(r, 100));
        expect(runs()).toBe(2);
        expect(exited).toBeUndefined();
    }, 15000);
});
