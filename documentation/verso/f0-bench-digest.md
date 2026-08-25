# F0 · Benchmark de competidores

> **HISTORICAL — F0 competitor benchmark, scored before the editor decision.** The competitor
> versions and scores are a snapshot from that pass and were not re-verified since. Kept as the
> record of the benchmark that fed F1; it makes no claim about WordJS code.

| Editor | inline editing | drag drop | responsive editing | collaboration | history versions | accessibility | performance | keyboard shortcuts | data model portability | extensibility api | styling design tokens | animations interactions | templates patterns | ai features | dynamic content cms binding |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Gutenberg | 4 | 3 | 2 | 3 | 3 | 3 | 2 | 4 | 4 | 4 | 4 | 2 | 4 | 2 | 4 |
| Elementor | 4 | 4 | 4 | 2 | 4 | 2 | 2 | 3 | 3 | 4 | 4 | 4 | 5 | 3 | 4 |
| Webflow | 4 | 5 | 5 | 3 | 4 | 3 | 3 | 4 | 2 | 4 | 4 | 5 | 4 | 4 | 4 |
| Framer | 5 | 4 | 3 | 5 | 4 | 2 | 3 | 3 | 1 | 4 | 3 | 5 | 4 | 5 | 3 |
| Notion | 4 | 4 | 2 | 4 | 3 | 2 | 3 | 4 | 2 | 4 | 2 | 3 | 4 | 4 | 2 |
| Builder.io | 4 | 4 | 3 | 4 | 3 | 2 | 3 | 3 | 2 | 5 | 4 | 3 | 4 | 5 | 5 |
| Craft CMS | 3 | 4 | 3 | 2 | 3 | 5 | 3 | 2 | 4 | 5 | 2 | 1 | 4 | 2 | 5 |

## Gutenberg (WordPress Block Editor) — estado a marzo 2026, Gutenberg plugin 22.8 / núcleo WP 6.9, con WP 7.0 en ciclo de desarrollo

**Killer features:**
- Modelo de datos portable de verdad: HTML plano + comentarios delimitadores en post_content, degrada con gracia sin el plugin/bloque, es diffable en git y no depende de un blob binario propietario — el activo arquitectónico más difícil de igualar.
- Sistema formal de deprecated/migrate() en block.json: más de 10 años de compatibilidad retroactiva para decenas de miles de bloques de terceros sin romper contenido histórico al cambiar la forma de un bloque.
- theme.json como sistema real de design tokens: cada preset se convierte automáticamente en variable CSS consumida por editor y frontend desde la misma fuente de verdad, con variaciones de estilo completas intercambiables.
- Full Site Editing: cabecera, pie, plantillas y patrones se editan visualmente con el MISMO modelo de bloques que el contenido — no hay un 'modo tema' separado del 'modo contenido'.
- Block Bindings API + Query Loop: enlazar atributos de bloque a post-meta/campos personalizados sin escribir PHP/JS de render, con propagación automática al actualizar la fuente.
- Command Palette (Cmd/Ctrl+K) unificado sobre todo el admin, no solo el editor de contenido.
- Colaboración en tiempo real basada en un CRDT real (Yjs) integrado en los mismos data stores que ya usa cualquier bloque estándar — aunque todavía en beta.

**Debilidades:**
- Lag de tipeo bien documentado y estructural en posts grandes: React re-renderiza el árbol completo del post en cada mutación de bloque; es la crítica más vieja y más repetida de Gutenberg (issues abiertos desde 2018-2019, todavía citados en 2025-2026) y sigue sin una solución de raíz.
- Edición responsive débil: no hay overrides visuales por breakpoint para la mayoría de bloques, solo una previsualización de dispositivo en el Site Editor — brecha señalada desde hace años frente a herramientas centradas en diseño visual.
- La colaboración en tiempo real llegó muy tarde (recién en beta a partir de 2026), con límites de escalado por defecto, se desactiva si detecta meta boxes legacy, y voces internas de la comunidad cuestionan si encaja en la filosofía de simplicidad de WordPress o si sobrecarga a los hostings compartidos.
- Accesibilidad 'objetivo WCAG 2.2 AA' pero no conformidad total admitida por el propio proyecto: toolbars anidados y drag-and-drop siguen siendo duros con teclado/lector de pantalla, y el modelo de bloques no impide que autores sin entrenamiento produzcan marcado no semántico.
- No existe un panel de autor para animaciones/interacciones (hover, scroll-reveal, transiciones) con controles visuales en el núcleo; la Interactivity API es infraestructura de desarrollador, no una herramienta no-code para quien solo escribe contenido.
- La IA en el núcleo es todavía plomería (Connectors/MCP/Abilities API recién en marzo de 2026), no generación de contenido pulida y nativa — eso sigue viviendo en plugins de terceros, yendo por detrás de competidores con IA nativa integrada en la UI de edición.
- El churn de API impone un impuesto de mantenimiento perpetuo al ecosistema: apiVersion 3 obligatorio desde WP 6.9, iframe obligatorio de cara a WP 7.0 — cada salto fuerza a reescribir y volver a probar bloques de terceros que ya funcionaban.
- Curva de aprendizaje alta para FSE/theme.json en el usuario medio; la distinción plantilla vs. template part vs. patrón sigue confundiendo años después del lanzamiento de Full Site Editing.

**Arquitectura:** Modelo de datos: el contenido vive en wp_posts.post_content como HTML aumentado con comentarios delimitadores `<!-- wp:namespace/bloque {"attr":valor} -->...<!-- /wp:namespace/bloque -->`. Un parser (@wordpress/blocks) convierte eso en un árbol de objetos {name, attributes, innerBlocks, innerHTML}. La función save() de cada tipo de bloque es pura (función de sus atributos) y produce el HTML estático que literalmente queda guardado — para bloques estáticos WordPress no necesita PHP para renderizar el contenido público, ya está horneado en el momento de guardar. Los bloques dinámicos en cambio solo guardan el comentario wrapper y delegan el marcado a render_callback/render.php (o a los nuevos "bloques solo-PHP"), ejecutado en cada carga de página.

Cliente del editor: React + stores estilo Redux vía @wordpress/data (core/block-editor, core/editor, etc.), componentes funcionales, y el lienzo se renderiza dentro de un `<iframe>` (progresivamente obligatorio, totalmente forzado de cara a WP 7.0) para aislar el CSS/JS del tema del admin y lograr fidelidad WYSIWYG real.

Registro de bloques: block.json declara nombre, apiVersion, esquema de atributos, "supports" (color, spacing, etc. que autogeneran controles de UI + custom properties CSS), y los scripts de editor/estilo/frontend. registerBlockType() en JS conecta edit()/save(). Los cambios de forma de atributos/marcado se gestionan con un array `deprecated` + funciones `migrate`, de modo que contenido histórico se vuelve a parsear a la forma actual sin perder datos — es el mecanismo que sostiene la estabilidad del modelo de datos a largo plazo pese a que el software cambia constantemente.

Composición: InnerBlocks permite que un bloque defina áreas anidadas (con template, allowedBlocks, templateLock), habilitando patrones, Group, Columns y Query Loop; el mismo parser/árbol maneja anidamiento recursivo arbitrario.

Drag & drop: implementación artesanal sobre HTML5 DnD + eventos de puntero dentro de @wordpress/block-editor (no una librería como dnd-kit/react-dnd); el List View ofrece un árbol virtualizado del documento que dispara las mismas acciones del reducer (mover bloque a posición) que el drag en el lienzo — de ahí la fragilidad reportada en bloques anidados.

Estilos: theme.json se parsea en PHP y se fusiona (core → tema → Estilos Globales guardados en BD) en una única hoja de estilos inyectada una vez, generando custom properties `--wp--preset--*` y `--wp--style--*` consumidas tanto por el iframe del editor como por el frontend público — la misma fuente de verdad explica por qué la fidelidad WYSIWYG es alta.

Colaboración (nuevo, ciclo WP 7.0, desde ~marzo 2026): construida sobre Yjs (CRDT) — las operaciones del editor se convierten en actualizaciones de un documento Yjs sincronizadas a través de un canal ahora respaldado por una tabla de base de datos dedicada (migrada fuera de postmeta tras inestabilidad temprana); el estado de colaboración fluye por los mismos stores de @wordpress/data, así que cualquier bloque/plugin que lea/escriba por los stores estándar hereda colaboración automáticamente, pero bloques con meta boxes legacy o estado no estándar desactivan la colaboración por completo; el escalado sigue limitado (tope bajo de colaboradores concurrentes por defecto) y el acceso beta ha sido mayormente vía WordPress VIP.

Extensibilidad más allá de bloques: Slot/Fill para inyectar UI en regiones fijas del editor, wp.hooks (filters/actions) para extensión imperativa, Script Modules (ES modules nativos) reemplazando el patrón antiguo de wp_enqueue_script para el código frontend de la Interactivity API, Block Hooks para auto-inserción de bloques dirigida por tema/plugin, y la nueva capa (2026) de Abilities API + Connectors/MCP que permite a agentes de IA externos descubrir e invocar capacidades del sitio bajo límites de permisos definidos.

Nota de investigación: se verificó con WebSearch información posterior al cutoff (hasta Gutenberg 22.8 / marzo 2026, ciclo de desarrollo de WP 7.0), incluyendo el estado beta real de la colaboración en tiempo real, las mejoras de Block Bindings en WP 6.9, y el lanzamiento de Connectors/MCP en Gutenberg 22.7 — la web estuvo disponible durante toda la investigación.

**Standouts por dimensión:**
- [inline_editing] RichText + Format Library: el mismo motor de formatos de texto se reutiliza en cientos de bloques de terceros sin reimplementación.
- [collaboration] CRDT real (Yjs) integrado en los mismos @wordpress/data stores que ya usa cualquier bloque — no es un parche superficial, cualquier bloque que lea/escriba por los stores estándar hereda colaboración automáticamente.
- [keyboard_shortcuts] Command Palette: un único cuadro de comandos que cubre todo el admin, no solo el editor — referencia real a superar.
- [data_model_portability] Serialización como HTML + comentarios: el activo arquitectónico más fuerte de Gutenberg — portable, legible, versionable con herramientas estándar.
- [extensibility_api] Deprecated + migrate() en block.json: mecanismo formal para migrar contenido histórico cuando cambia la forma de los atributos, sin perder datos ni romper posts viejos.
- [styling_design_tokens] theme.json: variables CSS generadas automáticamente + variaciones de estilo completas seleccionables, misma fuente de verdad para editor y frontend.
- [templates_patterns] Full Site Editing: todo el sitio (no solo el contenido) vive en el mismo modelo de bloques — sin un 'modo tema' separado del 'modo contenido'.
- [dynamic_content_cms_binding] Block Bindings API: fuente de verdad única para datos dinámicos, propagación automática a todos los bloques que la referencian, sin código de render custom.

## Elementor (WordPress) — Editor clásico + Editor V4 / Atomic Editor, GA desde abril 2026, versión estable ~4.3.x a julio 2026

**Killer features:**
- Theme Builder + biblioteca de Website Kits + mercado de terceros: nadie en WordPress iguala el volumen y curación de plantillas reutilizables listas para producción.
- Dynamic Tags nativos para ACF/Toolset/Pods/WooCommerce combinados con Loop Builder: binding CMS sin código de lo más completo del segmento, con loops anidados para repeaters.
- Editor V4: Variables Manager + Global Classes — el primer sistema de design tokens real (CSS compilado, no inline) que ha tenido un builder visual WP mainstream.
- Ecosistema de extensibilidad con miles de addons de terceros y una API de Widgets/Controls/Dynamic Tags/Hooks documentada — el mayor efecto de red del espacio.
- Edición inline WYSIWYG directa sobre el canvas renderizado con el estilo real del sitio, sin preview separado, desde hace casi una década.

**Debilidades:**
- Cero edición colaborativa en tiempo real: solo lock de edición heredado de WordPress que bloquea por completo a un segundo usuario; feature request abierto sin respuesta oficial desde 2023.
- Reputación de rendimiento/bloat bien documentada y medida (hasta 40-60% más lento que competidores más ligeros como Bricks en benchmarks de 2026); DOM profundo del modelo Section/Column legacy y revisiones que guardan la página completa inflando la base de datos.
- Accesibilidad crecientemente paywalled: skip-links, indicadores de foco y control de contraste antes gratuitos ahora exigen el plugin de pago Ally o Pro, con acusaciones de práctica predatoria justo cuando la European Accessibility Act ya es exigible.
- Migración a Editor V4/Atomic con fricción real: datos legacy vs Atomic son formatos distintos que requieren conversión, y buena parte de los miles de addons de terceros todavía se está adaptando a la nueva API — riesgo de fragmentación del ecosistema.
- Segmentación agresiva por planes de pago: Theme Builder, popups, formularios, WooCommerce builder, dynamic tags avanzados y motion effects viven detrás de Pro, y ahora la IA además está limitada por créditos de una suscripción adicional (Elementor One) — la capa gratuita es deliberadamente una demo limitada.

**Arquitectura:** Elementor vive hoy en dos capas superpuestas. La legacy (aún la que corre en la inmensa mayoría de los 21M+ sitios activos): editor construido sobre Backbone.js/Marionette, canvas renderizado dentro de un iframe que refleja en vivo el árbol de datos (parent window = paneles de control, iframe = preview real de la página con los estilos del sitio cargados). El modelo de datos es un JSON anidado por post (guardado en post meta `_elementor_data`) con jerarquía Section > Column > Widget (y desde 3.6, alternativamente Container flexbox); cada widget se renderiza server-side en PHP (`render_content`) y también tiene una plantilla cliente en Underscore.js para refrescar el preview sin reload completo. El estilo se generaba históricamente como CSS inline masivo por elemento — la causa raíz de la fama de "bloat" y DOM profundo ("Divitis").

La capa nueva es Editor V4 / "Atomic Editor" (GA desde abril 2026 para instalaciones nuevas, activable manualmente en sitios existentes; estable en producción desde 3.35 beta, versión actual ~4.3.x a jul-2026). Reescribe la UI del editor en React y sustituye Section-Column-Widget por "Atomic Elements": bloques mínimos y semánticos (Div Block, Flexbox Container, Heading, Paragraph, Button, Image) que emiten HTML más limpio. El estilado pasa a ser CSS-first: un Variables Manager centraliza tokens (color/tipografía/tamaño) y Global Classes son reglas CSS reutilizables reales (no inline) que se aplican por clase y se compilan a hojas de estilo centralizadas — el primer sistema de design tokens serio que ha tenido Elementor.

No hay CRDT ni OT: cero edición colaborativa real. La concurrencia se resuelve con el lock de edición heredado de WordPress core (Heartbeat API) — bloquea por completo a un segundo usuario mientras el primero tiene la página abierta, no hay fusión ni cursores compartidos. Portabilidad: export/import es JSON por plantilla o "Website Kit" completo, pero el JSON solo tiene sentido dentro del propio registro de widgets de Elementor (lock-in de facto), y los datos legacy (Section/Column) y Atomic (V4) son formatos distintos que requieren conversión — la migración V3→V4 no es transparente, y buena parte del ecosistema de +addons de terceros todavía está adaptándose a la nueva API.

**Standouts por dimensión:**
- [inline_editing] Edición de texto directamente sobre el elemento renderizado con su estilo real, sin vista previa separada.
- [responsive_editing] 6 breakpoints configurables con edición en vivo en cada uno, más granular que la mayoría de constructores WP.
- [extensibility_api] Volumen de la comunidad de addons de terceros, sin comparación en el espacio WordPress.
- [styling_design_tokens] Variables Manager + Global Classes: tokens reales compilados a CSS, no solo swatches globales.
- [templates_patterns] Theme Builder + biblioteca de Kits + mercado de terceros: la mayor superficie de plantillas reutilizables del segmento.

## Webflow (Designer)

**Killer features:**
- Interactions con GSAP (IX3): timeline visual con ScrollTrigger/SplitText/Stagger nativos, y las interacciones son PRESETS reutilizables que se propagan automáticamente a todas las instancias de una clase — defines una vez, aplicas a N elementos, cambias una vez y se actualizan todos.
- Page Branching + Branch Staging: fork/merge atómico tipo Git aplicado a una página de diseño visual, con entorno de staging real para probar antes de publicar y recuperación de 30 días tras el merge.
- DevLink: exportación unidireccional de Componentes de Webflow a código React (.tsx) tipado y sincronizado, con slots como ReactNode props y clases con CSS `@scope` — puente diseño-código real, no solo un volcado de HTML.
- Sistema de clases + combos + Variables con Modes: tokens de diseño (color/espaciado/tipografía) que compilan a custom properties CSS y soportan temas/multi-marca intercambiables con un toggle, todo sin salir del editor visual.
- Designer Extensions: apps de terceros corren DENTRO del propio canvas mediante una API cliente TypeScript de primera clase, no como integraciones externas — ecosistema (Finsweet, Relume) construido sobre esa base.
- Amplitud de superficie IA end-to-end: Site Builder prompt-to-production, AI Assistant en el Designer, contenido CMS por IA, A/B testing y personalización (Optimize), SEO/AEO, traducción, alt-text automático y conector MCP oficial con Claude.

**Debilidades:**
- Vendor lock-in real y muy criticado: exportar código requiere plan Workspace de pago y produce HTML no semántico masivo (`div-block-47`, 15.000+ líneas de CSS en un sitio de 20 páginas); el contenido CMS, formularios, búsqueda y localización no sobreviven fuera de Webflow hosting.
- Techos duros de CMS que fuerzan parches de terceros: límites de ítems (2.000 en plan CMS), campos por colección, y sobre todo listas anidadas muy restrictivas (2 por página, 10 ítems cada una) — la comunidad recurre sistemáticamente a Finsweet Attributes para catálogos grandes.
- Colaboración en tiempo real todavía inmadura frente a Figma/Google Docs: sin cursores en vivo (solo resaltado de elemento), texto que sincroniza al perder foco en vez de tecla a tecla, e incompatible con Interactions Clásicas (IX2).
- Rendimiento real inconsistente pese al CDN: el sitio promedio saca 45-60 en Lighthouse móvil, sin enrutador cliente (cada navegación recarga el documento completo) y con interactions/fuentes/scripts de terceros como culpables recurrentes de LCP/INP/CLS.
- Estructura de precios y soporte cuestionada: cargos por asiento, 2% de comisión de transacción en el plan Ecommerce Basic (155% de salto de precio para eliminarla), y reseñas que describen el soporte al cliente estándar como pobre o inexistente.
- Deprecaciones que rompen sitios construidos sobre features nativas: Logic se retiró en junio de 2025 y User Accounts en enero de 2026, forzando migraciones obligatorias a soluciones de terceros.
- Las herramientas de accesibilidad son de diagnóstico, no de garantía: el panel de Auditoría y el checker de contraste ayudan, pero no validan estructuralmente ARIA, foco ni orden de tabulación — la responsabilidad final queda enteramente en quien diseña.

**Arquitectura:** Nota metodológica: WebSearch estuvo disponible y se usó activamente (fuentes fechadas en 2026, incluyendo Webflow Help Center y Webflow Developer Docs oficiales); un intento de WebFetch directo a webflow.com/updates falló con error de parseo ("Header overflow"), así que esa pieza puntual se cubrió con las fuentes de terceros citadas en las búsquedas — el resto del análisis se apoya en fuentes primarias de Webflow más cobertura periodística/técnica de 2026.

Modelo de datos: cada página es un árbol de elementos tipo DOM. Los estilos NO son inline: viven como objetos "Class" reutilizables indexados por breakpoint, con cascada aditiva (desktop hereda hacia abajo salvo sobreescritura) y "Combos" como composición de clases sobre un mismo elemento. Componentes/Symbols son subárboles reutilizables con props/overrides y slots. Las CMS Collections son esquemas tipados independientes del árbol de páginas, enlazados a él mediante campos reference/multi-reference y "Collection Lists" que iteran sobre ítems. Las Variables son tokens con "Modes" que compilan a custom properties CSS.

Render: el Designer edita DOM real dentro de un canvas en iframe — es WYSIWYG genuino, no una representación intermedia (por eso las Designer Extensions también corren como iframes con la misma Designer API cliente que usa el propio producto). El sitio publicado se sirve estático/SSG por CDN (Fastly + CloudFront), con un runtime JS que hidrata las Interactions (motor legacy IX2 o el nuevo motor GSAP de IX3). No existe enrutador cliente: cada navegación entre páginas es una carga de documento fresca, y las "transiciones" de página se simulan coordinando animaciones de salida en una página con animaciones de entrada en la siguiente.

Drag-and-drop: estructural sobre el árbol, respetando genuinamente Flexbox/Grid (no posicionamiento absoluto por defecto), con indicadores de inserción y navegación de jerarquía por teclado.

Colaboración: pasó de bloqueo exclusivo (un editor a la vez) a multiplayer, con GA en octubre de 2025 y adopción forzada (sin opt-out) desde febrero de 2026. El patrón de comportamiento documentado —resaltado de elemento en vez de cursor vivo, texto que sincroniza recién al perder foco, e incompatibilidad total con IX2 legacy— sugiere una sincronización basada en eventos discretos sobre el árbol de elementos más que un CRDT de texto carácter-a-carácter tipo Figma/Google Docs; esto es una inferencia razonable a partir del comportamiento observado y reportado por usuarios, no un detalle de implementación confirmado públicamente por Webflow.

Extensibilidad: Designer Extensions = SPA en iframe seguro + Designer API cliente en TypeScript que manipula el árbol programáticamente (el mismo camino que usa el propio Designer); Data API v2 REST con scopes granulares por app; DevLink = pipeline de exportación unidireccional Webflow→React que traduce árbol+clases a componentes .tsx con CSS `@scope`; y desde 2026 un servidor MCP que expone ese mismo árbol/CMS a agentes de IA bajo permisos explícitos y detrás de una publicación humana.

**Standouts por dimensión:**
- [inline_editing] WYSIWYG sobre DOM real editable in-place, no una vista previa aparte.
- [drag_drop] Box model completo (flex/grid) manipulable por arrastre directo, no solo apilado de bloques.
- [history_versions] Page Branching: modelo tipo fork/merge de Git aplicado a una página de diseño visual, con staging real antes de publicar.
- [extensibility_api] Designer Extensions corren DENTRO del propio lienzo (no una integración externa aparte), con API cliente TypeScript de primera clase.
- [animations_interactions] Interacciones reutilizables como presets con propagación automática: se define una vez, se aplica a N elementos, se edita una vez y todos se actualizan.

## Framer

**Killer features:**
- On-Page Editing: edita directamente sobre la URL YA publicada en producción, con cola de revisión antes de publicar -nadie más en la categoría edita el sitio en vivo con esta fidelidad.
- Motor de animación (Scroll Transforms con modo scrub bidireccional + variantes multi-disparador) heredado de Motion/Framer Motion: el más completo del mercado.
- Workshop + MCP propio: generación/iteración de componentes de código con IA (Claude) dentro del mismo lienzo, y puente nativo a LLMs externos para gestionar CMS y SEO.
- Componentes de código React reales conviviendo en el mismo árbol de capas que los componentes visuales -lo que se diseña es literalmente lo que se publica, sin paso de traducción a código.
- Branching estilo Git: aísla cambios de equipo del proyecto publicado (main) sin bloquear a nadie, con revisión antes de fusionar.
- Components in CMS: cualquier componente creado en el Canvas puede insertarse como contenido dinámico dentro de una colección (galerías animadas, embeds interactivos).

**Debilidades:**
- Cero exportación real: sin ZIP/HTML descargable, sin API de archivos fuente, sin export CSV/bulk nativo del CMS -lock-in de datos de facto pese al discurso de "estándares abiertos" (oportunidad directa para WordJS: portabilidad real de datos).
- Accesibilidad superficial y delegada a terceros: alt text/tab order/reduced motion no garantizan WCAG; auditores externos advierten que genera una falsa sensación de cumplimiento.
- Performance real inconsistente: el editor no impide animaciones pesadas, imágenes sin comprimir ni scripts síncronos de terceros -quejas recurrentes de PageSpeed bajo en sitios reales pese al marketing de "built-in performance".
- CMS con techos de escala (30 campos, 1.000-10.000 ítems, referencias multinivel lentas, sin filtro nativo de rango numérico) -no aguanta catálogos grandes o relacionales complejos sin plugins.
- Responsive estrictamente desktop-first sin cascada bidireccional entre breakpoints -sorprende a equipos mobile-first.
- Monetización de IA por "créditos" variables (2026) que añade fricción de costo impredecible sobre funciones antes fijas.
- Sistema de tokens de diseño menos riguroso que el estado del arte -sin modos/alias tipados formales al estilo Figma Variables.

**Arquitectura:** Investigación hecha con WebSearch/WebFetch (agosto 2026); Framer no publica un blog técnico detallado de su motor interno como sí hizo Figma, así que algunos puntos (motor de sincronización multiplayer) quedan sin confirmación pública oficial.

Modelo de datos: árbol de capas (Frames/Stacks/Components) similar en espíritu a Figma, pero el canvas del editor renderiza DOM/HTML-CSS real -no un motor de vectores WebGL- precisamente porque el editor produce directamente el sitio publicable (\"lo que diseñas ES el sitio\", sin paso de traducción a código).

Componentes: conviven dos sistemas. (1) Componentes visuales: capas + variantes + propiedades gestionadas por el árbol nativo (equivalente a Figma components/variants pero compiladas a HTML real). (2) Code components: React/TypeScript reales que Framer envuelve en un renderer, exponiendo sus props como controles editables en el panel derecho; se ejecutan de verdad en canvas, preview y sitio publicado.

Animación: motor de variantes + disparadores (hover/click/viewport/scroll) construido sobre Motion (librería open-source de la propia Framer), compilando "Scroll Transforms" a transformaciones CSS aceleradas por GPU, con modo scrub que ata el progreso de la animación al scroll en ambas direcciones.

Colaboración: multiplayer en vivo (cursores, presencia, edición simultánea del árbol de capas); en 2026 se añadió "Branching" como capa de control de versiones tipo Git -copias aisladas del proyecto que se revisan y aplican a main, reversibles desde el historial-. Persistencia/versionado: snapshots automáticos escalonados (5 min / 1h / 1 día) más los branches.

CMS: motor de colecciones propietario (hasta 30 campos, hasta 10k ítems en plan Scale) con API de plugin (@framer/plugin, sandbox) para gestión programática -createCollection, campos Gallery, Code File API para overrides/code components, mensajería en background- pero sin export bulk nativo.

Publicación: sin export de código fuente; el output HTML/CSS/JS se sirve exclusivamente desde la infraestructura propia de Framer (CDN/edge con pre-render y cache), lo cual es también la causa estructural del lock-in de datos documentado en data_model_portability.

**Standouts por dimensión:**
- [inline_editing] On-Page Editing: edición WYSIWYG sobre la URL pública en producción con flujo de revisión antes de publicar.
- [drag_drop] Bento grid nativo + reordenamiento con placeholders que mantienen el espacio del layout.
- [responsive_editing] breakpoints custom ilimitados por ancho exacto en píxeles.
- [collaboration] Branching estilo Git: aísla el trabajo de un equipo del proyecto "main" publicado, con revisión antes de fusionar.
- [history_versions] snapshotting automático escalonado (5min/1h/1día) sin intervención manual del usuario.
- [extensibility_api] Code File API: plugins crean y gestionan code components/overrides de forma programática.
- [animations_interactions] Scroll Transforms con modo scrub bidireccional sobre motor de variantes multi-disparador.
- [templates_patterns] librería propia "Blocks" (100+ componentes) + marketplace de creators con cadencia semanal.
- [ai_features] Workshop (generación/iteración de componentes de código con IA dentro del lienzo) + MCP propio bring-your-own-LLM.
- [dynamic_content_cms_binding] "Components in CMS": inserta componentes visuales completos del Canvas como contenido dinámico de una colección.

## Notion (block editor web/desktop/mobile, estado 2025-2026)

**Killer features:**
- Motor de edición inline construido a medida (no Slate/ProseMirror/Tiptap) donde CADA bloque es contenteditable independiente y 'Turn into' cambia el tipo de bloque preservando el contenido — el estándar de facto que el resto del mercado imita.
- Slash command (/) como superficie unificada de inserción de cualquier tipo de contenido, copiado por prácticamente todo competidor de bloques desde entonces.
- Synced blocks: un bloque, múltiples ubicaciones, edición propagada en vivo en todas sus instancias — muy pocos editores lo replican con esta fidelidad.
- Sync engine CRDT por bloque + Postgres shardeado en 96 instancias/480 shards lógicos por workspace, con carga perezosa por bloque que permite abrir páginas de miles de bloques con latencia inicial baja aunque el documento sea enorme.
- Plataforma de extensión 2026 más agresiva del sector: Notion Workers (runtime sandboxed hospedado desplegable vía CLI), External Agents API, webhooks de automatización y de producción, y soporte MCP nativo — todo lanzado en un solo release de mayo 2026.
- Notion AI Q&A que cruza el workspace CON apps conectadas externas (Slack, Jira, GitHub, Drive) y responde con citas verificables, más Autofill de propiedades de base de datos que ya atraviesa un salto de relación.

**Debilidades:**
- Portabilidad de datos rota: las bases de datos exportan solo a CSV (pierden relations, rollups, filtros y vistas), y synced blocks/linked databases pierden su estructura por completo al exportar — lock-in explícitamente denunciado por la propia comunidad de usuarios como 'el impuesto que pagas al salir'.
- Rendimiento se degrada con el uso real: páginas de miles de bloques, vistas de base de datos por encima de ~5,000-10,000 filas, y dashboards con múltiples embeds se vuelven notoriamente lentos; estimaciones de comunidad hablan de 2.5h/mes perdidas por usuario power esperando cargas.
- Historial de versiones limitado y segmentado por plan de pago (solo 7 días en el plan Free), con grano de snapshot cada ~10 minutos — no es un backup real ni permite versiones con nombre o branching.
- Accesibilidad con fallas WCAG documentadas de forma consistente por auditores externos: contraste, alt text, orden de tabulación, y lectores de pantalla que no navegan correctamente el área editable ni comunican el estado de los controles.
- Edición responsiva casi inexistente en el editor core: sin vista de breakpoints, columnas que solo apilan en pantallas angostas; la app móvil acumula quejas de selección de texto rota, contenido duplicado/perdido y lentitud en conexiones débiles.
- Personalización de marca muy pobre a nivel nativo: solo 3 tipografías y ~10 colores de sistema, con CSS casi 100% inline en atributos style — cualquier theming serio requiere extensiones de terceros o capas de publicación externas.
- Resolución de conflictos offline deficiente: en vez de fusionar cambios concurrentes sin conexión, Notion puede crear páginas duplicadas '(Conflict)' que el usuario debe reconciliar a mano.
- Sin API pública para extender el propio editor con nuevos tipos de bloque de terceros con UI propia — la extensibilidad 2026 es fuerte a nivel de datos/automatización pero sigue cerrada a nivel de renderer del canvas.

**Arquitectura:** Nota de fuentes: Notion no publica su arquitectura interna en detalle; lo siguiente combina writeups de ingeniería públicos, análisis de "system design" de terceros y observación de comportamiento, verificado vía WebSearch posterior a mi cutoff (no hubo indisponibilidad de red).

Modelo de datos: bloque como primitiva universal — texto, imagen, base de datos y página son el MISMO tipo de objeto con la misma forma estructural; la transformación de tipo (párrafo→encabezado→lista) cambia solo un atributo "type" y preserva el resto de propiedades, por eso "Turn into" nunca pierde contenido. El documento entero es, en esencia, un árbol de bloques con IDs estables y referencias (page_id, parent_id).

Render/edición: contenteditable custom construido desde cero (no Slate/ProseMirror/Tiptap), con cada bloque como una isla contenteditable independiente — esto es lo que permite edición concurrente fina sin que un usuario bloquee el árbol completo de otro. El drag-and-drop no usa un framework DnD genérico: calcula handles por hover y una línea de inserción derivada de la posición del bloque en el DOM.

Colaboración: sync engine basado en CRDTs por bloque — como cada bloque es una unidad independiente, usuarios editando bloques distintos operan sobre CRDTs separados que no compiten entre sí, lo que simplifica el merge frente a un único CRDT de documento completo. El flujo de escritura es optimista: apply local inmediato → validación en servidor → propagación a suscriptores vía WebSocket, lo que explica por qué Notion se siente responsivo incluso con red inestable, aunque el offline "de verdad" (edición sin conexión de dos personas sobre la misma página) puede degradar a duplicados en vez de un merge limpio.

Persistencia y escala: PostgreSQL shardeado en 96 instancias físicas con 480 shards lógicos enrutados por workspace_id, sosteniendo un reporte de más de 200 mil millones de bloques con latencia sub-segundo. La carga perezosa (lazy) por bloque es la pieza clave que permite abrir páginas con cientos/miles de bloques rápido sin traer el árbol completo de una vez — y también explica por qué el rendimiento cae de forma más visible en operaciones que SÍ necesitan materializar todo (vistas de base de datos grandes, exportación completa).

Publicación web: Notion Sites es una capa de renderizado separada del editor de documentos (no comparte el mismo motor responsivo), lo que explica por qué el control de breakpoints/diseño en Sites es limitado comparado con page builders dedicados — es fundamentalmente el mismo árbol de bloques reinterpretado como HTML público, no un sistema de diseño paralelo con sus propios controles de layout.

**Standouts por dimensión:**
- [inline_editing] Motor contenteditable propio (no Slate/ProseMirror/Tiptap) con atajos markdown en vivo (#, -, [], >, **texto**) y 'Turn into' que cambia el tipo de bloque preservando el contenido subyacente sin reescribir el árbol.
- [drag_drop] Handle de arrastre (⋮⋮) que aparece al hover con línea de inserción en vivo, drag multi-bloque, Option/Alt+drag para duplicar, y drag cross-página vía sidebar.
- [collaboration] Sync engine con CRDT por bloque: usuarios editando bloques distintos son CRDTs independientes, lo que permite apply optimista local → validación de servidor → sync a suscriptores, con carga perezosa por bloque para abrir páginas grandes rápido.
- [keyboard_shortcuts] Cmd/Ctrl+P como búsqueda universal instantánea a cualquier página, combinado con +120 atajos catalogados y triggers de texto (@, [[, /, +) que funcionan como comandos de primera clase, no como afterthought.
- [extensibility_api] En 2026 lanzó Notion Workers (runtime hospedado sandboxed para código custom desplegado vía CLI), una External Agents API y webhooks tanto de automatización (no-code) como de API (producción) — la plataforma de extensión más agresiva del sector este año, sumado a soporte MCP nativo.
- [templates_patterns] Marketplace con más de 30,000 plantillas oficiales y de comunidad con duplicado de un clic al workspace, más 'template buttons' que generan bloques repetibles bajo demanda dentro de una página.
- [ai_features] Q&A que indexa no solo el workspace sino apps conectadas (Slack, Jira, GitHub, Google Drive) y responde con citas verificables; Autofill de propiedades de base de datos que en 2026 ya atraviesa un salto de relación (una tarea puede heredar metadata de su proyecto relacionado automáticamente).

## Builder.io

**Killer features:**
- Visual Copilot: convierte selecciones de Figma en código de framework real (React/Vue/Angular/Svelte/Next) con un modelo propio entrenado en +2M puntos de datos y mapeo automático a componentes del design system ya registrados — no genera HTML genérico, genera EL código del proyecto.
- Fusion: agente de IA que integra Slack/Jira/Figma/GitHub y cierra el ciclo completo diseño→PR real contra el repositorio de producción, entendiendo APIs, fuentes de datos y el design system del equipo — ningún otro editor visual de esta categoría llega tan lejos del canvas.
- registerComponent + esquema de inputs tipados: cualquier componente de código de la app se vuelve editable visualmente sin fork del editor ni capa de plugin intermedia — el contrato de extensibilidad es el propio código.
- Mitosis: compilador open-source propio que permite escribir un componente una vez y emitir salida nativa e idiomática a React, Vue, Angular, Svelte, Qwik y más — SDKs multi-framework reales, no un iframe embebido disfrazado.
- A/B testing y personalización resueltos en el edge (Next.js Edge Middleware) antes del render, evitando el parpadeo (CLS) típico de experimentos resueltos en cliente — arquitectura de testing más avanzada que la media del mercado.
- Colaboración en tiempo real con cursores nombrados dentro del propio editor visual (no solo en un IDE aparte), extendida en 'Builder 2.0' a sesiones mixtas humano+agente de IA trabajando en paralelo sobre el mismo proyecto.

**Debilidades:**
- Vendor lock-in estructural confirmado por consultoras de migración independientes: el SDK se entreteje en la capa de RENDER del frontend, así que abandonar Builder.io no es exportar contenido sino reconstruir la capa de composición de páginas completa — el JSON de bloques está atado al mapa de componentes registrados y al runtime del SDK.
- A/B testing, personalización avanzada, heatmaps y analytics están reservados al plan Enterprise — no es una capacidad universal del producto sino un upsell caro, según comparativas de pricing 2026.
- Rendimiento del EDITOR (no del output publicado) se degrada con páginas de muchos bloques anidados — hilos activos y repetidos en su propio foro de soporte ('Editor lag') sin resolución definitiva reportada.
- Documentación percibida como desactualizada y soporte lento; reseñas señalan que el chatbot de soporte deriva rápido al correo humano en vez de resolver.
- Curva de aprendizaje empinada para el modelado de contenido (Data Models, Symbols vs Templates vs componentes de código) que confunde a equipos no técnicos, el público objetivo principal del producto.
- Breakpoints personalizables llegaron tarde al producto — durante años solo existieron 3 breakpoints fijos (mobile/tablet/desktop), mientras competidores llevan años con breakpoints ilimitados y edición por rango.
- Sin evidencia pública de un auditor de accesibilidad integrado al flujo visual (contraste, alt-text, orden de tabulación, roles ARIA) — el cumplimiento WCAG del contenido publicado depende enteramente de la disciplina del desarrollador que registra los componentes.

**Arquitectura:** Pude usar WebSearch/WebFetch en esta sesión (sin bloqueos de red), así que lo que sigue viene de fuentes públicas 2025-2026 (docs oficiales de builder.io/c/docs, GitHub BuilderIO/builder, foro oficial, reseñas G2/Product Hunt/Gartner) contrastadas contra mi conocimiento previo. Un detalle interno (protocolo exacto de sync colaborativo) no está documentado públicamente y lo marco como inferencia, no como hecho verificado.

MODELO DE RENDER (WYSIWYG real, no aproximación): el editor visual corre como app web separada que carga el sitio del cliente DENTRO de un `<iframe>` cuya URL provee el propio desarrollador. El SDK instalado en esa página, al detectar que está embebida en el editor, avisa su presencia por `postMessage`; Builder responde enviando el contenido completo como JSON y a partir de ahí solo envía "patches" incrementales por cada edición. Es decir: el editor NUNCA renderiza HTML propio — delega el render real al SDK/framework del cliente dentro del iframe, así que lo que se edita es literalmente la app de producción, no una maqueta. Es la misma familia arquitectónica de "bring your own rendering" que Contentful/Storyblok con visual editing, pero Builder la tiene más madura y es su producto original.

MODELO DE DATOS: JSON declarativo por página/sección con un array `blocks`; cada nodo lleva `@type` (`@builder.io/sdk:Element`), `tagName`/`component.name` + `component.options`, estilos por breakpoint embebidos inline por nodo (no hay hoja de estilos separada), y bindings de estado como expresiones evaluadas en runtime por el SDK. Los "Symbols" (componentes reutilizables tipo header/footer) son referencias a otro content-entry con `inputs` propios, resueltos en tiempo de render — permite parametrización tipo componente pero el dato vive fuera del árbol de la página, lo que complica exportar/portar el contenido sin el runtime de Builder.

EXTENSIBILIDAD: 100% código-primero. `Builder.registerComponent(Component, {name, inputs})` registra un mapa nombre→referencia + esquema de inputs tipados; el editor genera el panel de propiedades automáticamente desde ese esquema. No existe un "plugin SDK" separado del código de la app — el contrato es el propio código React/Vue/etc. del cliente. Esto es su punto más fuerte y el que WordJS debería igualar o superar.

MULTI-FRAMEWORK: usan Mitosis, su propio compilador open-source, para escribir componentes de UI una vez y emitir salida nativa a React, Vue, Angular, Svelte, Qwik, Solid, etc. — no es un iframe embebido universal disfrazado; cada SDK genera código idiomático del framework destino. Es una apuesta de ingeniería seria y explica por qué su lista de SDKs es tan larga sin fragmentar el producto.

A/B TESTING Y TARGETING: se modelan como "variantes" dentro de un content-entry (Data Model), resueltas en el edge (ej. Next.js Edge Middleware / Vercel) ANTES del render, para evitar el parpadeo (CLS) típico de experimentos resueltos en cliente. Arquitectura de testing a nivel de edge, no de cliente — técnicamente más avanzado que la mayoría de competidores de esta categoría.

COLABORACIÓN: cursores con nombre sincronizados en tiempo real entre usuarios (estilo Google Docs), checkpoints manuales (Cmd/Ctrl+S) y un historial de revisiones con rollback punto-a-punto. El comportamiento descrito (múltiples editores viendo cambios de otros en vivo dentro del mismo iframe) sugiere algún tipo de sync operacional (OT o CRDT ligero) sobre el JSON del content-entry, pero Builder no publica el protocolo — no puedo confirmar cuál de los dos usan.

CAPA DE IA (Fusion): es una capa de agente SEPARADA del runtime del editor visual — se integra con Slack/Jira/Figma/GitHub y opera directamente sobre el repositorio del cliente generando ramas y pull requests reales (no contenido dentro de Builder). Visual Copilot, en cambio, sí vive dentro del editor: convierte selecciones de Figma a código de framework real usando un modelo propio entrenado en +2M puntos de datos, con mapeo a componentes de design system ya registrados.

**Standouts por dimensión:**
- [drag_drop] Drag-and-drop desde tres fuentes distintas (bloques, Symbols con inputs, Templates) unificado en el mismo panel Insert.
- [extensibility_api] registerComponent + esquema de inputs tipados como contrato único entre código de la app y editor visual, sin capa de plugin intermedia.
- [ai_features] Fusion: agente de IA que cierra el ciclo diseño→PR real contra el repositorio de producción, no solo generación de contenido dentro del propio editor.

## Craft CMS — Editor de entradas (Entry Types / Matrix) + Live Preview

**Killer features:**
- Entry Types globales y reutilizables entre secciones y campos Matrix anidados: se modela un bloque de contenido una sola vez y se reutiliza en todo el sitio sin duplicar la definición — la barra a superar en modelado de contenido estructurado.
- Project Config: todo el esquema (secciones, entry types, campos, ajustes de plugins) se serializa a YAML versionable en Git y se sincroniza automáticamente entre entornos al desplegar — portabilidad de estructura best-in-class.
- Live Preview que renderiza la ruta de producción real (Twig) contra los datos del draft vía token — no una simulación de canvas, sino el sitio de verdad, con múltiples preview targets nombrados por sección.
- Programa de accesibilidad público y auditado (WCAG 2.1 AA / ATAG 2.0 AA) con reportes de conformidad y actualizaciones trimestrales — nivel de transparencia que ningún competidor documenta igual.
- API GraphQL autogenerada desde el modelo de contenido y totalmente extensible por plugins vía eventos; cualquier campo de terceros se integra en el field layout como si fuera nativo.

**Debilidades:**
- Cero edición WYSIWYG directa sobre el contenido renderizado: todo es formulario + iframe de preview al lado, nunca clic-y-escribe sobre el layout real — Craft lo defiende como filosofía, pero es la queja constante de quien viene de un page builder.
- Sin coedición simultánea nativa: el modelo por defecto es un draft provisional privado por usuario. La colaboración en tiempo real (Datastar) se demostró en Dot All 2025 pero es una capa opcional que integra el desarrollador, no el comportamiento de fábrica del CP; comentarios y aprobaciones nativas están anunciados para Craft 6 pero seguían en alpha a fecha de hoy (agosto 2026).
- No existe diff/comparación de versiones en el núcleo — feature request abierto desde hace años (GitHub #898) — solo se marca qué campos cambiaron, sin ver el antes/después.
- Rendimiento del CP se degrada de forma documentada con field layouts complejos (Matrix/Neo con muchos block types anidados): reportes de 2.8s+ solo para generar el formulario.
- Cero superficie de diseño/tokens para el editor de contenido: toda la maquetación vive en Twig/CSS del desarrollador, así que un editor de marketing no puede tocar estilos ni marca sin pasar por código.
- Atajos de teclado mínimos más allá de guardar (Cmd+S) — sin command palette ni quick-switcher, con una discusión de la comunidad pidiendo un sistema real de shortcuts sin resolver desde hace años.
- Curva de aprendizaje pronunciada y coste real: licencias desde ~$199/sitio más plugins de pago que se acumulan (rating G2 4.2/5 mencionando repetidamente ambos puntos).
- Migración de framework a mitad de vuelo: Craft 6 está reescribiendo la base de Yii2 a Laravel (en alpha desde mayo 2026) — riesgo de inestabilidad del ecosistema de plugins mientras dure la transición.

**Arquitectura:** Backend PHP monolítico sobre Yii2, en plena migración a Laravel para Craft 6 (alpha activo desde mayo 2026, beta prevista Q3 2026, GA Q4 2026): Pixel & Tonic lo describe como "strict port", no reescritura — Elements, Fields, Sections, Matrix y el sistema de plugins se mantienen intactos, con una capa de compatibilidad Yii2 para no romper plugins existentes. El Control Panel es server-rendered (Twig) con Garnish.js (toolkit JS propio, jQuery-based, de Pixel & Tonic) para drag&drop, slideouts, lightswitches y condicionales; partes puntuales más nuevas (editor de imágenes, algunos widgets) usan Vue — esto último no lo pude re-verificar 100% con búsqueda en vivo, se apoya en conocimiento previo. Modelo de datos: "Elements" es la clase base universal (Entry, Asset, User, Category, Matrix-nested-entry...) y cada uno tiene un Field Layout (tabs + custom fields con visibilidad condicional vía un Condition Builder). Desde Craft 5, los bloques de Matrix dejaron de ser un tipo aparte: son Entries reales, propiedad de un elemento padre vía la tabla elements_owners, con Entry Types globales reutilizables entre secciones y Matrix anidados — 4 modos de vista (Blocks/Cards/Card Grid/Index) y anidamiento recursivo. Drafts/Revisions no son un diff versionado: son filas Element duplicadas con draftId/revisionId — un "provisional draft" (uno por usuario por elemento canónico, autosave) vs drafts nombrados vs revisions inmutables al publicar. El DnD es reordenamiento de listas/árboles (Garnish), no un motor de canvas con posicionamiento libre tipo page-builder. Live Preview no simula nada: itera un iframe contra la ruta real del front-end (Twig de producción) renderizada con los datos del draft provisional vía token — por eso su fidelidad es total. GraphQL se autogenera del field layout y es extensible vía eventos Yii2. La colaboración en tiempo real (anunciada en Dot All 2025) no vive en el core: se construye sobre Datastar, una librería open-source de reactividad SSE/hypermedia con SDK y plugin para Craft, agnóstica de backend — se demostró en vivo con 70 editores simultáneos sin conflictos, pero es una capa opt-in que el desarrollador cablea, no el modelo por defecto del CP (que sigue siendo un draft provisional por usuario). Project Config guarda el esquema (no el contenido) como YAML versionable en Git, separado de la base de datos — portabilidad de estructura entre entornos, no de contenido.

**Standouts por dimensión:**
- [accessibility] Reporte de conformidad WCAG/ATAG público y auditado con cadencia trimestral — ningún competidor documenta esto con este nivel de detalle.
- [data_model_portability] Project Config: esquema completo como YAML diffable en Git, sincronizado automáticamente entre entornos — de lo mejor resuelto en cualquier CMS.
- [extensibility_api] Cualquier campo o tipo de elemento de un plugin de terceros se comporta como nativo dentro del field layout, incluida su exposición automática por GraphQL.
- [templates_patterns] Entry Types como recurso global reutilizable en secciones y Matrix anidados — define un bloque una vez, úsalo en todo el sitio sin duplicar el modelo.
- [dynamic_content_cms_binding] Live Preview renderiza literalmente la ruta de producción (Twig real) contra los datos del draft — fidelidad total porque no hay una capa de simulación intermedia.

