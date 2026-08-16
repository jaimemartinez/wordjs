/**
 * Verso/colaboración — PROTOCOLO DE CABLE (F8.3).
 *
 * Estos tipos describen exactamente lo que viaja entre `backend/src/routes/collab.ts` y el cliente.
 * Se declaran aquí, en el frontend, y NO se comparten por import con el backend a propósito: el
 * backend valida la forma por su cuenta en `core/collab-ops.ts` porque un validador que confía en
 * un tipo de TypeScript no valida nada — el tipo se borra al compilar. Estos tipos son para que el
 * CLIENTE se entienda a sí mismo; el contrato ejecutable está en el validador del servidor.
 *
 * Transporte: SSE de bajada + POST de subida (ver la cabecera de `backend/src/core/collab-rooms.ts`
 * para el porqué). El PROTOCOLO DE MENSAJES es el de la spec §4.2; solo cambia el tubo.
 */

import type { CollabOp, VersionVector } from "../crdt";

/** Selección remota. Las anclas son `PosRef`, nunca offsets: así el caret ajeno no salta. */
export interface CollabSelection {
  nodeId: string | null;
  field?: string;
  anchor?: string;
  focus?: string;
}

export interface CollabMember {
  siteId: string;
  userId: number;
  name: string;
  color: string;
  sel: CollabSelection | null;
  at: number;
}

export interface CollabSelf {
  siteId: string;
  userId: number;
  name: string;
  color: string;
}

export interface WelcomeMessage {
  epoch: number;
  /** `_puck_data` serializado del post en el momento de abrirse el epoch. */
  base: string;
  /** Log de ops posteriores al snapshot, en el orden en que el servidor las aceptó. */
  ops: CollabOp[];
  members: CollabMember[];
  self: CollabSelf;
  serverTime: number;
  /** true ⇒ el log se truncó: la reanudación ya no está garantizada. */
  truncated: boolean;
  limits: {
    maxOpsPerSec: number;
    maxBytesPerSec: number;
    maxFrameBytes: number;
    /**
     * Espera que el servidor exige tras un 429 (`CONFIG.RATE_RETRY_MS`). Reintentar ANTES cuenta
     * como strike y a los tres cierra la sesión, así que este número NO puede estar duplicado a
     * ojo en el cliente: viaja por el cable y de él se deriva el backoff. Opcional para tolerar un
     * servidor anterior a este campo, donde se usa el suelo del cliente.
     */
    rateRetryMs?: number;
  };
}

export interface OpsMessage {
  ops: CollabOp[];
  from: string;
  epoch: number;
}

export interface PresenceMessage {
  entries: CollabMember[];
}

export interface MembersMessage {
  joined?: CollabMember;
  left?: { siteId: string; userId: number };
}

export interface ErrorMessage {
  code: string;
  message: string;
}

export interface ResyncResponse {
  epoch: number;
  ops: CollabOp[];
  base?: string;
  complete: boolean;
}

/** Estado del canal, tal cual se le enseña al usuario (nunca se degrada en silencio). */
export type CollabStatus =
  | "off"
  | "connecting"
  | "live"
  /** Conectado pero con la reanudación comprometida (log lleno): hay que guardar y recargar. */
  | "degraded"
  /** Sin canal. `error` dice por qué; el editor sigue funcionando en local. */
  | "offline";

/** Aviso accionable para la UI. Nunca se pierde nada en silencio (§6). */
export interface CollabNotice {
  code:
    | "forbidden"
    | "epoch-reset"
    | "log-full"
    | "rate-limited"
    | "rejected-ops"
    | "reconnected"
    | "transport-error"
    /** El servidor no pudo guardar el lote (fallo de BD). Se reintenta; NUNCA se da por bueno. */
    | "store-failed"
    /** El saneado del servidor reescribió un valor y la réplica local lo ha adoptado. */
    | "normalized"
    /** La identidad de réplica cambió (rotación de clave): hubo que re-sembrar el estado. */
    | "identity-reset";
  message: string;
  at: number;
  /** Detalle de las ops que el servidor rechazó, para el panel de "no se pudo aplicar". */
  rejected?: { index: number; code: string }[];
}

/** Respuesta de `POST /ops`. Lo que el cliente DEBE mirar, y por qué, está en `client.ts#flush`. */
export interface OpsResponse {
  ok?: boolean;
  /** Altas nuevas en el log. */
  accepted?: number;
  /** Ops que el servidor YA tenía (reenvío tras reconexión): entregadas, pero no nuevas. */
  known?: number;
  rejected?: { index: number; code: string }[];
  /** false ⇒ difundido pero NO guardado: la sesión ya no es reanudable. */
  persisted?: boolean;
  /** Ops que el saneado del servidor reescribió, en su forma canónica. */
  normalized?: CollabOpLike[];
}

/** Forma mínima de una op tal como vuelve del servidor (el tipo fuerte vive en `../crdt`). */
export interface CollabOpLike {
  k: string;
  id: { site: string; counter: number };
  nodeId?: string;
  key?: string;
  value?: unknown;
  props?: Record<string, unknown>;
}

/* ------------------------------------------------------------------------------------------- */
/* Transporte inyectable                                                                         */
/* ------------------------------------------------------------------------------------------- */

export interface StreamHandlers {
  onEvent: (event: string, data: unknown) => void;
  onOpen: () => void;
  onError: (err: unknown) => void;
}

export interface StreamHandle {
  close: () => void;
}

export interface PostResponse {
  status: number;
  body: unknown;
}

/**
 * La costura que hace la sesión testeable sin navegador: en producción es `EventSource` + `fetch`;
 * en los tests es un servidor de mentira en memoria que puede reordenar y duplicar a voluntad.
 */
export interface CollabTransport {
  openStream: (url: string, handlers: StreamHandlers) => StreamHandle;
  post: (url: string, body: unknown) => Promise<PostResponse>;
}

export interface SessionSnapshot {
  status: CollabStatus;
  /** Identidad de ESTA réplica (una por pestaña). Viaja en el snapshot y no por una ref: el
   *  render no puede leer una ref sin arriesgarse a pintar un valor viejo. */
  siteId: string;
  self: CollabSelf | null;
  members: CollabMember[];
  epoch: number;
  /** Version vector local — expuesto para diagnóstico y para el `resync`. */
  vv: VersionVector;
  pendingOps: number;
  notice: CollabNotice | null;
}
