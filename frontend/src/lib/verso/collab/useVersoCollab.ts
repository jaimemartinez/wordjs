/**
 * Verso/colaboración — HOOK DE REACT, AISLADO Y AUTOCONTENIDO (F8.3).
 *
 * Este fichero es la ÚNICA superficie que el editor necesita tocar. No importa nada de
 * `components/verso/editor/**` y no conoce el store: recibe callbacks y devuelve estado. Se puede
 * cablear (y descablear) sin mover una línea del editor.
 *
 * ─── CÓMO SE CABLEA (lo que falta por hacer fuera de aquí) ──────────────────────────────────────
 *
 * ```tsx
 * const collab = useVersoCollab({
 *   postId,
 *   enabled: collabFlagOn,          // apagado ⇒ 0 conexiones y el editor se comporta como hoy
 *   isSlot,                          // el MISMO resolutor de slots que usa el editor
 *   isRichText,                      // el MISMO criterio de campo rico que usa el registry
 *   onReady:      (doc) => editor.replaceDoc(doc),   // documento inicial de la sala
 *   onRemoteDoc:  (doc) => editor.applyRemoteDoc(doc), // ops ajenas ya proyectadas
 * });
 *
 * // 1. Salida: en el sink de `transact()`, por CADA comando EFECTIVO:
 * collab.sendCommand(effectiveCommand);
 *
 * // 2. Presencia: cuando cambie la selección del editor:
 * collab.setSelection({ nodeId, field, anchor, focus });
 *
 * // 3. UI: `collab.members` para los avatares y los bordes de color;
 * //        `collab.status` para el indicador de canal; `collab.notice` para el aviso.
 * ```
 *
 * DOS REGLAS QUE EL CABLEADO DEBE RESPETAR:
 *
 *  1. `onRemoteDoc` entrega un documento ya proyectado por el MISMO camino inmutable de siempre. Al
 *     aplicarlo NO debe crearse entrada de historia: una op ajena no es un «deshacer» tuyo.
 *  2. `sendCommand` espera el comando EFECTIVO (el que devuelve `applyCommand`: índices clampados,
 *     `idMap` materializado), no el crudo. Con el crudo, emisor y receptor aplicarían cosas
 *     distintas y la convergencia dejaría de significar nada.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SlotResolver, VersoDoc, VersoHistoryCommand } from "../types";
import type { CollabOp, RichTextResolver } from "../crdt";
import { VersoCollabSession } from "./client";
import { createBrowserTransport } from "./transport";
import type {
  CollabMember,
  CollabNotice,
  CollabSelection,
  CollabSelf,
  CollabStatus,
  CollabTransport,
  SessionSnapshot,
} from "./types";

export interface UseVersoCollabOptions {
  postId: number | null;
  /**
   * Interruptor general. Apagado ⇒ NO se abre ninguna conexión y el hook devuelve el estado
   * inerte: el editor se comporta exactamente como antes de que existiera la colaboración.
   */
  enabled?: boolean;
  isSlot?: SlotResolver;
  isRichText?: RichTextResolver;
  apiBase?: string;
  /** Transporte alternativo (los tests inyectan aquí un servidor en memoria). */
  transport?: CollabTransport;
  /** Documento inicial de la sala (snapshot del epoch + log ya aplicado). */
  onReady?: (doc: VersoDoc, self: CollabSelf) => void;
  /** Proyección tras aplicar ops REMOTAS. No se dispara por cambios locales. */
  onRemoteDoc?: (doc: VersoDoc, ops: readonly CollabOp[]) => void;
  onNotice?: (notice: CollabNotice) => void;
}

export interface UseVersoCollabResult {
  status: CollabStatus;
  /** Quién soy en la sala (con mi color). `null` hasta el `welcome`. */
  self: CollabSelf | null;
  /** Los DEMÁS editores presentes, con su selección. Nunca me incluye a mí. */
  members: CollabMember[];
  /** Último aviso accionable, o `null`. */
  notice: CollabNotice | null;
  /** Ops emitidas y todavía sin confirmar. >0 sostenido ⇒ el canal no está tragando. */
  pendingOps: number;
  epoch: number;
  /** `siteId` de esta réplica (una por pestaña, §2.1). Cadena vacía si está apagado. */
  siteId: string;
  /** Traduce y encola un comando EFECTIVO. Devuelve las ops emitidas. */
  sendCommand: (command: VersoHistoryCommand) => readonly CollabOp[];
  /** Declara la selección local. Coalescida internamente. */
  setSelection: (sel: CollabSelection | null) => void;
  /** Fuerza el envío del outbox (útil justo antes de un guardado explícito). */
  flush: () => Promise<void>;
  /** Proyección vigente del estado replicado, o `null`. */
  doc: () => VersoDoc | null;
}

const NO_MEMBERS: CollabMember[] = [];

/** Estado con el interruptor apagado: exactamente como si la colaboración no existiera. */
const INERT: SessionSnapshot = {
  status: "off", siteId: "", self: null, members: NO_MEMBERS,
  epoch: 0, vv: {}, pendingOps: 0, notice: null,
};

export function useVersoCollab(options: UseVersoCollabOptions): UseVersoCollabResult {
  const { postId, enabled = true, isSlot, isRichText, apiBase, transport } = options;

  // Los callbacks van por ref para que redefinirlos en cada render NO reabra la sesión: una
  // reconexión por cada pulsación del padre sería exactamente el bug que este patrón evita. La ref
  // se actualiza en un efecto SIN dependencias (corre tras cada render) y no durante el render —
  // escribir una ref mientras se pinta es un efecto secundario y React 19 lo prohíbe. Este efecto
  // se declara ANTES que el de la sesión, así que cuando la sesión arranca ya ve los callbacks
  // buenos.
  const cbs = useRef(options);
  useEffect(() => { cbs.current = options; });

  const active = enabled && typeof postId === "number" && postId > 0;

  const [live, setLive] = useState<SessionSnapshot>(INERT);
  // Derivado, no almacenado: al apagarse, el estado inerte sale del render en vez de un `setState`
  // dentro de un efecto (que dispararía una cascada de renders por cada apagado).
  const snapshot = active ? live : INERT;
  const sessionRef = useRef<VersoCollabSession | null>(null);

  useEffect(() => {
    // Apagado: no se toca el estado (poner el snapshot inerte desde aquí sería un `setState` dentro
    // de un efecto y una cascada de renders). El valor inerte se deriva abajo, en el render.
    if (!active) return;
    const session = new VersoCollabSession(
      {
        postId: postId as number,
        transport: transport ?? createBrowserTransport(),
        apiBase,
        isSlot,
        isRichText,
      },
      {
        onReady: (doc, self) => cbs.current.onReady?.(doc, self),
        onRemoteDoc: (doc, ops) => cbs.current.onRemoteDoc?.(doc, ops),
        onNotice: (notice) => cbs.current.onNotice?.(notice),
        onChange: (next) => setLive(next),
      },
    );
    sessionRef.current = session;
    session.start();

    return () => {
      session.stop();
      sessionRef.current = null;
    };
    // `isSlot`/`isRichText` son resolutores del registry: si cambian de identidad en cada render,
    // memorízalos en el llamador. Entran en las deps a propósito — un resolutor distinto sembraría
    // un árbol distinto y hay que rehacer la sesión, no seguir con la vieja.
  }, [active, postId, transport, apiBase, isSlot, isRichText]);

  const sendCommand = useCallback(
    (command: VersoHistoryCommand) => sessionRef.current?.sendCommand(command) ?? [],
    [],
  );
  const setSelection = useCallback((sel: CollabSelection | null) => sessionRef.current?.setSelection(sel), []);
  const flush = useCallback(async () => { await sessionRef.current?.flush(); }, []);
  const doc = useCallback(() => sessionRef.current?.doc() ?? null, []);

  return useMemo<UseVersoCollabResult>(() => ({
    status: snapshot.status,
    self: snapshot.self,
    members: snapshot.members,
    notice: snapshot.notice,
    pendingOps: snapshot.pendingOps,
    epoch: snapshot.epoch,
    // Del SNAPSHOT, no de la sesión: leer `sessionRef.current` durante el render devolvería el
    // valor de la sesión anterior en el render en que se recrea.
    siteId: snapshot.siteId,
    sendCommand,
    setSelection,
    flush,
    doc,
  }), [snapshot, sendCommand, setSelection, flush, doc]);
}
