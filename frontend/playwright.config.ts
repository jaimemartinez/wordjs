/**
 * Verso F6 — configuración Playwright del programa E2E del editor.
 *
 * Stack bajo test: el MONOLITO en HTTP plano (WORDJS_HTTP=1 → sin TLS
 * autofirmado, baseURL http://localhost:3000). El webServer arranca
 * `npm run dev:mono` desde la raíz del repo; en local, si ya hay un servidor
 * vivo en el puerto, se REUSA (reuseExistingServer) — en CI siempre arranca
 * uno efímero. `/healthz` responde directo desde dispatch() del monolito, por
 * eso es la URL de readiness.
 *
 * Auth: el proyecto `setup` hace login por API (admin/admin123, la cuenta de
 * dev seed) con cabecera Origin (el CSRF del backend es same-origin por
 * Origin/Referer, sin token) y guarda el storageState que heredan los specs.
 *
 * NOTA CI (F6b): los presupuestos de perf.spec.ts se calibran en el runner de
 * Actions; ver el comentario del spec y el job verso-e2e de ci.yml.
 */
import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

export const E2E_BASE_URL = process.env.VERSO_E2E_BASE_URL ?? "http://localhost:3000";
export const ADMIN_STORAGE_STATE = path.join(__dirname, "e2e", ".auth", "admin.json");

export default defineConfig({
    testDir: "./e2e",
    outputDir: "./e2e/.results",
    fullyParallel: false,
    // Un solo worker: el stack comparte una única BD de dev — los specs crean
    // páginas y no deben carrerear entre sí (y el perf gate exige la máquina quieta).
    workers: 1,
    timeout: 120_000,
    expect: { timeout: 15_000 },
    reporter: [["list"]],
    use: {
        baseURL: E2E_BASE_URL,
        trace: "retain-on-failure",
        viewport: { width: 1440, height: 900 },
    },
    webServer: {
        command: "npm run dev:mono",
        cwd: path.join(__dirname, ".."),
        url: `${E2E_BASE_URL}/healthz`,
        // dev:mono corre predev (registries generados) antes de arrancar — el
        // primer boot en frío tarda minutos.
        timeout: 600_000,
        reuseExistingServer: !process.env.CI,
        // El entorno se propaga EXPLÍCITAMENTE (no se asume herencia): en un
        // checkout limpio el setup e2e instala la instancia y necesita que el
        // servidor arranque con el MISMO WORDJS_INSTALL_TOKEN que él enviará
        // (core/install-token.ts honra esa env var precisamente para automatizar).
        env: {
            ...(process.env as Record<string, string>),
            WORDJS_HTTP: "1",
        },
    },
    projects: [
        {
            name: "setup",
            testMatch: /global\.setup\.ts/,
        },
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"], storageState: ADMIN_STORAGE_STATE },
            dependencies: ["setup"],
            testMatch: /verso\/.*\.spec\.ts/,
        },
    ],
});
