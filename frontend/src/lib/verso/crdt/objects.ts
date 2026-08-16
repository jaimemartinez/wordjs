/**
 * Verso CRDT — escritura SEGURA de claves en objetos planos.
 *
 * `obj[k] = v` con `k === "__proto__"` NO crea una propiedad propia: cambia el
 * prototipo (o se ignora en silencio). Es decir, el dato DESAPARECE sin error.
 * El fuzzer adversarial lo cazó con un `slotKey: "__proto__"` que borró un
 * bloque entero de la proyección — la misma familia de trampas que ya obligó a
 * `normalize.ts`/`commands.ts` a usar `Object.hasOwn` en vez de `in` (F6).
 *
 * `setOwn` define SIEMPRE una propiedad propia y enumerable, que es exactamente
 * lo que hace `JSON.parse` con una clave `__proto__`: así el valor sobrevive,
 * se serializa y el round-trip sigue siendo byte-exacto.
 */

export function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
    return;
  }
  target[key] = value;
}
