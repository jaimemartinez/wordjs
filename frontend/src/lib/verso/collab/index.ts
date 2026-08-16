/**
 * Verso/colaboración — API pública del módulo de transporte y presencia (F8.3).
 *
 * El cableado del editor solo necesita `useVersoCollab`. Lo demás se exporta para los tests y para
 * quien quiera montar la sesión fuera de React (por ejemplo, un cliente de diagnóstico).
 *
 * Contrato completo: `documentation/verso/crdt-spec.md` §4 (transporte) y §5 (persistencia).
 */

export { useVersoCollab, type UseVersoCollabOptions, type UseVersoCollabResult } from "./useVersoCollab";
export { VersoCollabSession, type CollabSessionOptions, type SessionListeners } from "./client";
export { createBrowserTransport } from "./transport";
export type {
  CollabMember,
  CollabNotice,
  CollabSelection,
  CollabSelf,
  CollabStatus,
  CollabTransport,
  ErrorMessage,
  MembersMessage,
  OpsMessage,
  PostResponse,
  PresenceMessage,
  ResyncResponse,
  SessionSnapshot,
  StreamHandle,
  StreamHandlers,
  WelcomeMessage,
} from "./types";
