/**
 * Verso/colaboración — TRANSPORTE DE NAVEGADOR: `EventSource` (bajada) + `fetch` (subida).
 *
 * Cero dependencias y cero bundle: ambas APIs son nativas. Y cero configuración de despliegue: son
 * peticiones HTTP normales bajo `/api/v1`, con URL RELATIVA, así que funcionan igual en monolito,
 * en modo separado y detrás del gateway/nginx en cualquier puerto o protocolo — el mismo camino que
 * ya sirve `/api/v1/notifications/stream` en producción.
 *
 * Autenticación: la cookie HttpOnly `wordjs_token` viaja sola en same-origin, tanto en el
 * `EventSource` como en el `fetch`. No se pone el JWT en la query (se filtraría por access logs,
 * `Referer` e historial) ni se guarda en `localStorage`.
 */

import type { CollabTransport, PostResponse, StreamHandlers } from "./types";

/**
 * Eventos que el cliente escucha por nombre. `EventSource` NO entrega los eventos con `event:` por
 * el `onmessage` genérico: hay que suscribirse a cada nombre, así que la lista tiene que estar
 * completa o el mensaje se pierde en silencio.
 */
const EVENTS = ["welcome", "ops", "presence", "members", "warning", "error"] as const;

export function createBrowserTransport(): CollabTransport {
  return {
    openStream(url: string, handlers: StreamHandlers) {
      const source = new EventSource(url, { withCredentials: true });
      let closed = false;

      source.onopen = () => handlers.onOpen();
      source.onerror = (err) => {
        // `EventSource` reintenta solo, pero con su propia política y sin saber nada de nuestro
        // `epoch`. Preferimos cerrarlo y que la sesión decida: así el backoff y el reenvío del
        // outbox están en un solo sitio.
        if (closed) return;
        closed = true;
        try { source.close(); } catch { /* ya cerrado */ }
        handlers.onError(err);
      };
      for (const name of EVENTS) {
        source.addEventListener(name, (ev: MessageEvent) => {
          let data: unknown = null;
          try { data = JSON.parse(ev.data); } catch { return; }
          handlers.onEvent(name, data);
        });
      }

      return {
        close() {
          closed = true;
          try { source.close(); } catch { /* ya cerrado */ }
        },
      };
    },

    async post(url: string, body: unknown): Promise<PostResponse> {
      const res = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let parsed: unknown = null;
      try { parsed = await res.json(); } catch { parsed = null; }
      return { status: res.status, body: parsed };
    },
  };
}
