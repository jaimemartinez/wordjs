/**
 * Verso F6 — setup global: login por API y storageState compartido.
 *
 * POST /api/v1/auth/login con {username, password} — el CSRF del backend es
 * same-origin por Origin/Referer (middleware/auth.ts csrfProtection), así que
 * basta la cabecera Origin apuntando al propio host; la sesión llega como
 * cookie HttpOnly que storageState() captura para los specs.
 *
 * Credenciales: la cuenta seed de dev (admin/admin123 — lib/local-dev-stack).
 * Sobreescribibles vía VERSO_E2E_USER / VERSO_E2E_PASS.
 */
import { test as setup, expect, request } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ADMIN_STORAGE_STATE, E2E_BASE_URL } from "../playwright.config";

setup("login admin por API y guardar storageState", async () => {
    const ctx = await request.newContext({
        baseURL: E2E_BASE_URL,
        extraHTTPHeaders: { Origin: E2E_BASE_URL },
    });
    const res = await ctx.post("/api/v1/auth/login", {
        data: {
            username: process.env.VERSO_E2E_USER ?? "admin",
            password: process.env.VERSO_E2E_PASS ?? "admin123",
        },
    });
    expect(res.ok(), `login falló: ${res.status()} ${await res.text().catch(() => "")}`).toBeTruthy();
    fs.mkdirSync(path.dirname(ADMIN_STORAGE_STATE), { recursive: true });
    await ctx.storageState({ path: ADMIN_STORAGE_STATE });
    await ctx.dispose();
});
