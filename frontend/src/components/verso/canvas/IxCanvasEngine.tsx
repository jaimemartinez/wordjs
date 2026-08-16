"use client";
/**
 * Verso — MOTOR DE INTERACCIONES EN EL CANVAS (F9-D).
 *
 * El sitio público emite el CSS de las interacciones con `<style precedence="wjs-ix">` y deja que
 * React 19 lo suba al `<head>`. **Aquí eso no sirve**: el canvas es un IFRAME y su contenido llega
 * por `createPortal` desde la raíz React del documento PADRE, así que el hoisting de recursos de
 * React apunta al `<head>` del padre y la hoja no aterrizaría nunca dentro del marco. Es
 * exactamente el motivo por el que el `<link>` del tema ya se inyecta a mano ahí
 * (`FrameController.swapThemeCss`). Mismo compilador, mismos bytes; solo cambia el canal — que ya
 * era distinto.
 *
 * Este componente no pinta nada (devuelve `null`): no añade un solo nodo al canvas, para que ni el
 * DnD ni un selector `:last-child` de un tema vean un hermano que el sitio público no tiene. Toma
 * el documento del iframe del contexto del `FrameController` y hace tres cosas:
 *
 *  1. **Compila** las `ix` de todos los nodos del documento con el MISMO `compileIxPage` del sitio
 *     público (un compilador, dos superficies) y escribe el resultado en un único
 *     `<style id="wjs-ix">` dentro del `<head>` del marco.
 *  2. **Arranca el runtime** sobre el documento del marco, para que en el canvas se vea de verdad
 *     lo que el CSS no puede expresar: el latch de "una sola vez", el clic, y el scrub en un
 *     navegador sin `animation-timeline`.
 *  3. **Reproduce** la interacción a petición del panel: escucha `IX_PREVIEW_EVENT` en el documento
 *     del EDITOR (donde el panel puede emitirlo) y lo traduce a `ANIM_REPLAY_EVENT` dentro del
 *     marco — el mismo evento DOM que ya re-arma las animaciones de entrada, porque cruzar el
 *     iframe con un evento del DOM no necesita puente de React.
 *
 * NO se re-arranca el runtime al teclear. La firma del manifiesto es el JSON del IR compilado: el
 * contenido de un bloque no entra en ella, así que escribir texto no toca ni el CSS ni el runtime.
 * Sin eso, cada pulsación re-armaría los bloques y el canvas parpadearía sin parar.
 *
 * ⚠ DIFERENCIA CONOCIDA con el sitio público, acotada: las clases del canvas salen del hash
 * "desnudo" (`ixLayer` sin página, que es lo que estampa `VersoBlock`), mientras que el público
 * puede añadir un sufijo de desambiguación si dos cuerpos DISTINTOS colisionan en el mismo hash de
 * 32 bits dentro de una misma página. Cuando eso ocurre —y con decenas de unidades por página es
 * remotísimo— el canvas enseña el movimiento del primer cuerpo en el segundo bloque. Nunca al
 * revés, y nunca en el sitio publicado.
 */
import React from "react";
import { compileIxPage, type IxCompileCtx, type IxRuntimeUnit } from "@/lib/verso/interactions";
import { startIxRuntime } from "@/lib/verso/interactions/runtime";
import { defaultIxHost } from "@/lib/verso/interactions/runtime/host";
import { ANIM_REPLAY_EVENT } from "@/components/blocks/entranceAnimation";
import type { EditorHandle } from "@/lib/verso/store";
import type { VersoEditorState } from "@/lib/verso/types";
import { useStoreSlice } from "../render/context";
import { VersoCanvasContext } from "./FrameController";

/** Id del `<style>` de interacciones dentro del `<head>` del iframe (hermano de THEME_LINK_ID). */
export const IX_STYLE_ID = "wjs-ix";

/**
 * Evento con el que el panel pide "vuelve a reproducirlo". Se emite en el documento del EDITOR y lo
 * traduce este componente; el panel no conoce el iframe ni tiene por qué.
 */
export const IX_PREVIEW_EVENT = "wjs-ix-preview";

/** Pide una reproducción de las interacciones del canvas. No-op fuera del navegador. */
export function requestIxPreview(doc?: Document | null): void {
  const target = doc ?? (typeof document === "undefined" ? null : document);
  target?.dispatchEvent(new CustomEvent(IX_PREVIEW_EVENT));
}

const selectNodes = (s: VersoEditorState) => s.doc.nodes;

export interface IxCanvasEngineProps {
  handle: EditorHandle;
  /** Presets del sistema + del sitio. Sin él, solo los del sistema (los resuelve el compilador). */
  ixCtx?: IxCompileCtx;
}

export default function IxCanvasEngine({ handle, ixCtx }: IxCanvasEngineProps) {
  const canvas = React.useContext(VersoCanvasContext);
  const nodes = useStoreSlice(handle, selectNodes);

  // El manifiesto viaja como FIRMA (su JSON), no como array: así el efecto que arranca el runtime
  // depende de lo que el runtime hace, no de la identidad de un objeto que se recrea en cada
  // compilación. Dos compilaciones con el mismo IR no re-arman nada — que es la diferencia entre
  // teclear tranquilo y ver el canvas parpadear con cada pulsación.
  const { css, sig } = React.useMemo(() => {
    const specs = Object.values(nodes).map((node) => node.props.ix);
    const page = compileIxPage(specs, ixCtx);
    return { css: page.css, sig: JSON.stringify(page.runtime) };
  }, [nodes, ixCtx]);

  /* ── 1. La hoja, dentro del marco ─────────────────────────────────── */
  React.useEffect(() => {
    const doc = canvas?.getFrameDocument();
    const head = doc?.head;
    if (!head) return;
    let style = doc.getElementById(IX_STYLE_ID) as HTMLStyleElement | null;
    if (css === "") {
      style?.remove();
      return;
    }
    if (!style) {
      style = doc.createElement("style");
      style.id = IX_STYLE_ID;
      head.appendChild(style);
    }
    // `textContent`, nunca `innerHTML`: el CSS lo escribe el compilador (números clampados y tokens
    // de listas cerradas — ninguna cadena del autor llega hasta aquí), y aun así no hay motivo para
    // pasar por un parser de HTML.
    if (style.textContent !== css) style.textContent = css;
  }, [canvas, css]);

  /* ── 2. El runtime, sobre el documento del marco ──────────────────── */
  React.useEffect(() => {
    const doc = canvas?.getFrameDocument();
    if (!doc) return;
    const units = JSON.parse(sig) as IxRuntimeUnit[];
    if (units.length === 0) return;
    // Este efecto corre DESPUÉS del que escribe la hoja (orden de declaración), así que el CSS ya
    // está en el `<head>` del marco y los bloques ya están montados: el runtime arma sobre el DOM
    // definitivo, nunca sobre uno a medio pintar.
    const stop = startIxRuntime(units, defaultIxHost(doc));
    return () => stop();
  }, [canvas, sig]);

  /* ── 3. La previsualización que pide el panel ─────────────────────── */
  React.useEffect(() => {
    const frameDoc = canvas?.getFrameDocument();
    if (!frameDoc) return;
    const editorDoc = typeof document === "undefined" ? null : document;
    const onPreview = () => {
      // El MISMO evento que ya re-arma las entradas: una sola reproducción mueve las dos capas.
      frameDoc.dispatchEvent(new CustomEvent(ANIM_REPLAY_EVENT));
    };
    editorDoc?.addEventListener(IX_PREVIEW_EVENT, onPreview);
    // También dentro del marco: un futuro botón de la propia página del canvas no necesita saber
    // que hay un documento padre.
    if (frameDoc !== editorDoc) frameDoc.addEventListener(IX_PREVIEW_EVENT, onPreview);
    return () => {
      editorDoc?.removeEventListener(IX_PREVIEW_EVENT, onPreview);
      if (frameDoc !== editorDoc) frameDoc.removeEventListener(IX_PREVIEW_EVENT, onPreview);
    };
  }, [canvas]);

  return null;
}
