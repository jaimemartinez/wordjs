/**
 * Verso F6 — setup global: instalación (solo si hace falta) + login por API y
 * storageState compartido.
 *
 * INSTALACIÓN: un checkout limpio (CI) arranca SIN instalar — todas las rutas
 * devuelven 503 `setup_required`, así que el login no existe todavía. El camino
 * oficial de automatización es el que documenta core/install-token.ts: exportar
 * `WORDJS_INSTALL_TOKEN` al arrancar el servidor y llamar a POST
 * /api/v1/setup/install con la cabecera `x-install-token` (NUNCA se inventa un
 * token: sin la env var no hay instalación automática y el setup falla claro).
 * En local, donde la instancia YA está instalada, `/setup/status` responde
 * installed:true y este paso no toca nada.
 *
 * LOGIN: POST /api/v1/auth/login — el CSRF del backend es same-origin por
 * Origin/Referer (middleware/auth.ts csrfProtection), así que basta la cabecera
 * Origin; la sesión llega como cookie HttpOnly que storageState() captura.
 *
 * Credenciales: la cuenta seed de dev (admin/admin123 — lib/local-dev-stack).
 * Sobreescribibles vía VERSO_E2E_USER / VERSO_E2E_PASS (en CI la contraseña
 * debe tener ≥10 caracteres: el instalador lo exige).
 */
import { test as setup, expect, request, type APIRequestContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ADMIN_STORAGE_STATE, E2E_BASE_URL } from "../playwright.config";

const USER = process.env.VERSO_E2E_USER ?? "admin";
const PASS = process.env.VERSO_E2E_PASS ?? "admin123";

async function installIfNeeded(ctx: APIRequestContext): Promise<string> {
    const status = await ctx.get("/api/v1/setup/status");
    if (status.ok()) {
        const body = (await status.json().catch(() => ({}))) as { installed?: boolean };
        if (body.installed) return "ya instalada";
    }
    const token = String(process.env.WORDJS_INSTALL_TOKEN ?? "").trim();
    expect(
        token,
        "la instancia no está instalada y falta WORDJS_INSTALL_TOKEN — arranca el servidor con esa env var (ver core/install-token.ts) para que el setup e2e pueda instalar",
    ).toBeTruthy();
    const res = await ctx.post("/api/v1/setup/install", {
        headers: { "x-install-token": token },
        data: {
            siteName: "WordJS E2E",
            siteDescription: "Verso end-to-end",
            adminUser: USER,
            adminEmail: "e2e@localhost.lan",
            adminPassword: PASS,
            dbDriver: "sqlite-native",
            // Contenido semilla: los specs crean lo suyo, pero una instalación con
            // portada/menú ejercita el mismo camino público que en producción.
            demoContent: true,
        },
    });
    expect(
        res.ok(),
        `instalación falló: ${res.status()} ${await res.text().catch(() => "")}`,
    ).toBeTruthy();
    return "instalada por el setup e2e";
}

setup("instalar si hace falta, login admin por API y guardar storageState", async () => {
    const ctx = await request.newContext({
        baseURL: E2E_BASE_URL,
        extraHTTPHeaders: { Origin: E2E_BASE_URL },
    });
    const how = await installIfNeeded(ctx);
    // eslint-disable-next-line no-console -- traza útil en el log de CI
    console.log(`[verso-e2e] instancia: ${how}`);
    const res = await ctx.post("/api/v1/auth/login", {
        data: { username: USER, password: PASS },
    });
    expect(res.ok(), `login falló: ${res.status()} ${await res.text().catch(() => "")}`).toBeTruthy();
    fs.mkdirSync(path.dirname(ADMIN_STORAGE_STATE), { recursive: true });
    await ctx.storageState({ path: ADMIN_STORAGE_STATE });
    await ctx.dispose();
});
