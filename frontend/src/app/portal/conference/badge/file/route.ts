/**
 * A badge file (conference-manager 2.19.0): the plugin answers JSON only, so this route turns a short-lived
 * ticket (`?d=`, minted by the credential page, the coordinator portal or the admin) into the file's bytes,
 * with its real type — a PDF opens in the phone's viewer and downloads on a computer. The ticket is the only
 * credential (random, 120 s, 3 uses); nothing here is cached, sniffed or redirected, and only the allowlisted
 * types are ever served.
 */
import { serverFetch } from "@/lib/server-api";

export const dynamic = "force-dynamic";

const ALLOWED = new Set(["application/pdf"]);

export async function GET(request: Request): Promise<Response> {
    const d = new URL(request.url).searchParams.get("d") || "";
    if (!/^[0-9a-f]{32}$/.test(d)) return notFound();
    const file = await serverFetch<{ mime?: string; filename?: string; b64?: string }>(
        `/plugin/conference-manager/public/badge/file?d=${d}`);
    // (serverFetch is no-store unless asked to revalidate: a file is never cached.)
    if (!file || !file.b64 || !file.mime || !ALLOWED.has(file.mime)) return notFound();
    const bytes = Buffer.from(file.b64, "base64");
    const name = String(file.filename || "escarapela.pdf").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "escarapela.pdf";
    return new Response(bytes, {
        status: 200,
        headers: {
            "Content-Type": file.mime,
            "Content-Length": String(bytes.length),
            "Content-Disposition": `inline; filename="${name}"`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
        },
    });
}

function notFound(): Response {
    return new Response("El enlace de descarga venció. Vuelve a pedir el archivo.", {
        status: 410,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
}
