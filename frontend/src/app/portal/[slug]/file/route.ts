/**
 * /portal/<slug>/file?d=<ticket> — a plugin portal's file download (frontend.portalPage.file). A plugin answers
 * JSON only, so its public file route turns a short-lived ticket (minted by the portal for whoever may have
 * the file) into { mime, filename, b64 }, and this route answers the bytes with their real type: a PDF opens
 * in the phone's viewer and downloads on a computer. The ticket is the only credential; nothing here is
 * cached, sniffed or redirected, and only the allowlisted types are ever served.
 */
import { serverFetch } from "@/lib/server-api";
import { portalNotFound, servedPortal } from "@/lib/portalRoutes";

export const dynamic = "force-dynamic";

const ALLOWED = new Map([
    ["application/pdf", "pdf"],
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
]);
// A ticket: an opaque token — letters, digits, - and _, 16 to 128 characters.
const TICKET_RE = /^[A-Za-z0-9_-]{16,128}$/;
// The API path the backend names: under the plugin routes, nothing that could leave them.
const ENDPOINT_RE = /^\/plugin\/[A-Za-z0-9_-]+\/public(?:\/[A-Za-z0-9_-]+)+$/;

type Params = { params: Promise<{ slug: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
    const { slug } = await params;
    const d = new URL(request.url).searchParams.get("d") || "";
    if (!TICKET_RE.test(d)) return expired();
    const info = await servedPortal(slug);
    if (!info) return portalNotFound();
    if (!info.fileEndpoint || !ENDPOINT_RE.test(info.fileEndpoint)) return portalNotFound();
    // (serverFetch is no-store unless asked to revalidate: a file is never cached.)
    const file = await serverFetch<{ mime?: string; filename?: string; b64?: string }>(
        `${info.fileEndpoint}?d=${encodeURIComponent(d)}`);
    const ext = file && file.mime ? ALLOWED.get(file.mime) : undefined;
    if (!file || !file.b64 || !file.mime || !ext) return expired();
    const bytes = Buffer.from(file.b64, "base64");
    const name = String(file.filename || `file.${ext}`).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || `file.${ext}`;
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

function expired(): Response {
    return new Response("El enlace de descarga venció. Vuelve a pedir el archivo.", {
        status: 410,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
}
