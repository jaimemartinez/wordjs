# ADR 0006 — F5: contrato visual único y artefactos generados

- Estado: aceptado
- Fecha: 2026-08-20
- Fuente canónica: `contracts/visual-contract.v1.json`

## Contexto

Templates, chrome, temas, el renderer público y Verso repetían manualmente tipos, propiedades,
slots, límites, nombres de archivo y reglas de sanitización. Una prueba de paridad solo detectaba
algunas diferencias después de escribir dos copias; no impedía crear una tercera ni garantizaba que
un cambio alcanzara todos los consumidores.

F5 conserva dos programas separados —el backend no se importa desde Next.js— pero elimina las dos
definiciones. El JSON canónico describe los formatos de template/chrome/tema, el registro core de
Verso y las políticas visuales de URL, HTML, clases y estilos. `scripts/generate-visual-contract.mjs`
valida esa definición y produce proyecciones específicas para cada paquete, tipos TypeScript, el
registro de Verso y documentación para plugins.

## Decisión

El backend sigue siendo la autoridad de seguridad: valida antes de persistir y sanea contenido no
confiable. El frontend usa su proyección para fallar temprano y para renderizar únicamente datos que
cumplen el mismo contrato. Esa validación de lectura no convierte al navegador en autoridad.

Los artefactos generados se versionan. `npm run verify:f5` ejecuta el generador en modo `--check` y
falla si falta un archivo o no corresponde a la definición. Los maps de render de core, chrome y
template son exhaustivos mediante `satisfies Record<GeneratedType, ...>`. El registro de Verso usa el
orden generado y rechaza implementaciones ausentes, sobrantes, con otra categoría o con slots distintos.

## Invariantes

- **F5-INV-01** — `contracts/visual-contract.v1.json` es la única definición manual de límites y allowlists visuales compartidos.
- **F5-INV-02** — backend y frontend consumen artefactos separados, generados desde la misma versión del contrato.
- **F5-INV-03** — ningún módulo frontend importa implementación del backend.
- **F5-INV-04** — el backend valida y sanea antes de persistir; el parser frontend es defensa de lectura, no autoridad.
- **F5-INV-05** — template y chrome fallan cerrados ante tipos, propiedades, profundidad, cantidad o tamaño fuera de contrato.
- **F5-INV-06** — las reglas compartidas de URL, HTML, iframe, clase y estilo nacen de la sección `security` canónica.
- **F5-INV-07** — cada tipo core tiene exactamente una entrada generada de tipo, categoría, renderer y slots.
- **F5-INV-08** — los renderers core, chrome y template deben cubrir exhaustivamente sus unions generadas.
- **F5-INV-09** — un artefacto generado ausente o stale rompe CI antes de compilar o probar el producto.
- **F5-INV-10** — la documentación de plugins se regenera junto con el código y nunca se edita como otra fuente de verdad.

## Cómo cambiar el contrato

1. Cambiar `contracts/visual-contract.v1.json` y subir `version` cuando el formato persistido cambie.
2. Ejecutar `npm run generate:f5` desde la raíz.
3. Implementar el componente de un tipo nuevo; TypeScript y el registro de Verso indican todas las superficies pendientes.
4. Ejecutar `npm run verify:f5`, las pruebas de backend y frontend y los builds.

Para extensiones de plugins, el registro core no es una lista cerrada de plugins: un plugin conserva
su registro propio. La política de saneamiento del backend sí se aplica a cualquier árbol, incluido
un bloque de plugin, de modo que ampliar el editor no crea una vía alternativa de HTML/URL/estilo.

## Consecuencias

Se elimina el drift silencioso y se vuelve mecánico localizar el impacto de un cambio. A cambio, los
archivos `*.generated.ts` y la documentación generada forman parte del commit, y modificar uno a mano
no sirve: el gate lo rechazará. Una definición válida tampoco inventa una implementación visual; un
bloque nuevo todavía requiere su componente, pero no puede integrarse a medias porque los maps
exhaustivos y el registro fallan hasta que exista.
