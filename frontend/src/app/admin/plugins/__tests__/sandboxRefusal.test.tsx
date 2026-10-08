import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SandboxRefusalPanel, sandboxRefusalFrom, runtimeSandboxRefusal } from "../page";

/**
 * THE SANDBOX REFUSAL ON THE PLUGINS SCREEN.
 *
 * POST /plugins/:slug/activate answers 409 `sandbox_unavailable` when the server's plugin sandbox cannot
 * confine plugins. This screen used to render that as "Activation failed: The server encountered an
 * internal error" — on the host where a non-root service holding CAP_NET_BIND_SERVICE broke the Linux
 * sandbox, every activation said exactly that and nothing else. What is pinned here: the refusal is
 * recognised by its STABLE CODE (never by wording), and the panel shows which sandbox, what it reported,
 * what the operator can do, and where the server's diagnosis lives.
 *
 * The error objects are shaped exactly as lib/api.ts throws them: an Error carrying `code`, `details`
 * and `status` copied from the response body.
 */

const INCIDENT_LINE = "SHIM-FAIL: setgroups(clear): Operation not permitted";

function apiError(body: Record<string, unknown>, status: number) {
    return Object.assign(new Error(String(body.message ?? "failed")), {
        status,
        ...(typeof body.code === "string" ? { code: body.code } : {}),
        ...(body.details !== undefined ? { details: body.details } : {}),
    });
}

const refused409 = apiError({
    code: "sandbox_unavailable",
    message: "Plugin 'acme' was not started: the plugin sandbox could not confine it. The Linux kernel sandbox (Landlock + seccomp) is 'degraded' on this server: its launcher refused to start the probe child, so confinement could not be certified.",
    details: {
        sandbox: {
            mechanism: "landlock",
            state: "degraded",
            reason: "…",
            failure: INCIDENT_LINE,
            action: "The shim could not drop the privilege the WordJS service itself was started with. … drop AmbientCapabilities= …",
        },
    },
}, 409);

describe("sandboxRefusalFrom", () => {
    it("recognises the 409 by its stable code and keeps every field the panel shows", () => {
        const r = sandboxRefusalFrom(refused409);
        expect(r).not.toBeNull();
        expect(r!.mechanism).toBe("landlock");
        expect(r!.state).toBe("degraded");
        expect(r!.failure).toBe(INCIDENT_LINE);
        expect(r!.action).toMatch(/AmbientCapabilities=/);
        expect(r!.message).toMatch(/was not started: the plugin sandbox could not confine it/);
    });

    it("is null for every OTHER failure — a validation reject, a generic 500, a non-error", () => {
        expect(sandboxRefusalFrom(apiError({ message: "blocked", details: { dangerousCalls: ["eval"], missingPermissions: [] } }, 400))).toBeNull();
        expect(sandboxRefusalFrom(apiError({ code: "rest_internal_error", message: "The server encountered an internal error." }, 500))).toBeNull();
        expect(sandboxRefusalFrom(new Error("network down"))).toBeNull();
        expect(sandboxRefusalFrom(null)).toBeNull();
        expect(sandboxRefusalFrom(undefined)).toBeNull();
    });

    it("never keys on the wording: the same words without the code are not a sandbox refusal", () => {
        expect(sandboxRefusalFrom(new Error("the plugin sandbox could not confine it"))).toBeNull();
    });

    it("a refusal without details still renders as a refusal, with safe fallbacks", () => {
        const r = sandboxRefusalFrom(apiError({ code: "sandbox_unavailable", message: "" }, 409));
        expect(r).toEqual({
            message: "The plugin sandbox could not confine this plugin, so it was not started.",
            mechanism: "unknown",
            state: "unknown",
            failure: null,
            action: "",
        });
    });
});

describe("SandboxRefusalPanel", () => {
    const render = (el: React.ReactElement) => renderToStaticMarkup(el);

    it("shows the reason, the sandbox and its state, what it reported, the operator action and the health hint", () => {
        const html = render(<SandboxRefusalPanel refusal={sandboxRefusalFrom(refused409)!} />);
        expect(html).toContain("was not started: the plugin sandbox could not confine it");
        expect(html).toContain("Linux — Landlock + seccomp");
        expect(html).toContain("degraded");
        expect(html).toContain(INCIDENT_LINE);
        expect(html).toContain("What to do (server operator)");
        expect(html).toContain("AmbientCapabilities=");
        expect(html).toContain("GET /api/v1/health/details");
        expect(html).toContain("not a problem with this plugin");
    });

    it("has no 'reported' block when the sandbox gave no line, and says so differently for a refused launch on an ACTIVE sandbox", () => {
        const html = render(<SandboxRefusalPanel refusal={{ message: "m", mechanism: "landlock", state: "active", failure: null, action: "a" }} />);
        expect(html).not.toContain("What the sandbox reported");
        expect(html).toContain("The sandbox is working on this server but refused this launch");
    });
});

/**
 * A refusal the backend RECORDED on the plugin's runtime (boot, supervised restart, another node) rather
 * than answered to a request. Before it did, a plugin the sandbox refused at boot showed "Active" with no
 * runtime, and the drawer said "not an isolated plugin".
 */
describe("runtimeSandboxRefusal", () => {
    const refusedRuntime = {
        state: "refused" as const,
        pid: null,
        lastError: "Plugin 'acme' was not started: the plugin sandbox could not confine it. The Linux kernel sandbox (Landlock + seccomp) is 'degraded' on this server.",
        sandbox: { mechanism: "landlock", state: "degraded", reason: "…", failure: INCIDENT_LINE, action: "Run the service as an unprivileged user holding no capabilities …" },
    };

    it("turns a refused runtime into the same refusal a 409 carries, so the same panel renders it", () => {
        const r = runtimeSandboxRefusal(refusedRuntime);
        expect(r).toEqual({
            message: refusedRuntime.lastError,
            mechanism: "landlock",
            state: "degraded",
            failure: INCIDENT_LINE,
            action: refusedRuntime.sandbox.action,
        });
        const html = renderToStaticMarkup(<SandboxRefusalPanel refusal={r!} />);
        expect(html).toContain(INCIDENT_LINE);
        expect(html).toContain("What to do (server operator)");
    });

    it("is null for every other runtime state, and for no runtime at all", () => {
        for (const state of ["running", "restarting", "crashed", "crash-looping", "stopped"] as const) {
            expect(runtimeSandboxRefusal({ state, lastError: "x" })).toBeNull();
        }
        expect(runtimeSandboxRefusal(null)).toBeNull();
        expect(runtimeSandboxRefusal(undefined)).toBeNull();
    });

    it("a refused runtime without details still renders as a refusal, with safe fallbacks", () => {
        expect(runtimeSandboxRefusal({ state: "refused" })).toEqual({
            message: "The plugin sandbox could not confine this plugin, so it was not started.",
            mechanism: "unknown",
            state: "unknown",
            failure: null,
            action: "",
        });
    });
});
