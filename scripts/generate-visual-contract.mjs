#!/usr/bin/env node
/**
 * Generate every runtime view of the WordJS visual contract from one JSON source.
 *
 * The backend and frontend deliberately receive separate files: Next.js never imports backend code,
 * while both packages still consume byte-equivalent data. Run with --check in CI to reject drift.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_REL = "contracts/visual-contract.v1.json";
const SOURCE = path.join(ROOT, SOURCE_REL);
const CHECK = process.argv.includes("--check");

const fail = (message) => {
  process.stderr.write(`[visual-contract] ${message}\n`);
  process.exitCode = 1;
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const unique = (values, label) => {
  assert(Array.isArray(values), `${label} must be an array`);
  assert(new Set(values).size === values.length, `${label} contains duplicates`);
};

function validateContract(contract) {
  assert(contract?.contract === "wordjs.visual", "contract must be wordjs.visual");
  assert(Number.isSafeInteger(contract.version) && contract.version > 0, "version must be a positive integer");

  const template = contract.formats?.template;
  const chrome = contract.formats?.chrome;
  const theme = contract.formats?.theme;
  assert(template && chrome && theme, "template, chrome and theme formats are required");
  for (const [surface, limits] of [["template", template.limits], ["chrome", chrome.limits]]) {
    for (const field of ["maxBytes", "maxBlocks", "maxDepth"]) {
      assert(Number.isSafeInteger(limits?.[field]) && limits[field] > 0, `${surface}.limits.${field} must be a positive integer`);
    }
  }
  assert(template.blocks?.[template.contentSlot], "template contentSlot must name a declared block");
  assert(template.blocks[template.contentSlot].slot === null, "template contentSlot must be a leaf");
  new RegExp(template.classList.tokenPattern);
  new RegExp(theme.assetNamePattern);
  new RegExp(theme.slugPattern);
  new RegExp(theme.tokens.namePattern);
  new RegExp(theme.tokens.modNamePattern);
  new RegExp(theme.tokens.valuePattern);
  new RegExp(theme.tokens.forbiddenFunctionPattern, "i");
  unique(theme.tokens.forbiddenSubstrings, "theme.tokens.forbiddenSubstrings");
  new RegExp(contract.security.style.unsafeValuePattern, "i");
  new RegExp(contract.security.style.urlBearingPropertyPattern);
  new RegExp(contract.security.url.stripControlsPattern, "g");

  const propKinds = new Set([
    "string", "number", "boolean", "enum", "classlist", "partname",
    "wrapper-tag", "template-part-area", "href", "slot",
  ]);
  for (const [surface, blocks] of [["template", template.blocks], ["chrome", chrome.blocks]]) {
    assert(blocks && Object.keys(blocks).length > 0, `${surface}.blocks must not be empty`);
    for (const [type, block] of Object.entries(blocks)) {
      assert(/^[A-Z][A-Za-z0-9]{0,63}$/.test(type), `${surface} block ${JSON.stringify(type)} is not a safe serialized identifier`);
      assert(block && block.props && !Array.isArray(block.props), `${surface}.${type}.props must be an object`);
      for (const [prop, spec] of Object.entries(block.props)) {
        assert(/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(prop), `${surface}.${type} prop ${JSON.stringify(prop)} is not a safe identifier`);
        assert(propKinds.has(spec.kind), `${surface}.${type}.${prop} has unknown kind ${spec.kind}`);
        if (spec.kind === "enum") {
          unique(spec.values, `${surface}.${type}.${prop}.values`);
          assert(spec.values.length > 0 && spec.values.every((value) => typeof value === "string"), `${surface}.${type}.${prop}.values must contain strings`);
        }
      }
      for (const required of block.required || []) {
        assert(block.props[required], `${surface}.${type} requires undeclared prop ${required}`);
      }
      if (surface === "template" && block.slot !== null) {
        assert(typeof block.slot === "string" && /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(block.slot), `template.${type}.slot must be a safe string or null`);
      }
    }
  }

  unique(theme.templateParts.areas, "theme.templateParts.areas");
  unique(theme.templateParts.keys, "theme.templateParts.keys");
  assert(
    JSON.stringify([...theme.templateParts.areas].sort()) === JSON.stringify(Object.keys(theme.templateParts.areaWrappers).sort()),
    "theme.templateParts.areaWrappers must cover every area exactly",
  );
  const editorTypes = contract.editor.blocks.map((block) => block.type);
  unique(editorTypes, "editor.blocks.type");
  const editorCategories = [...new Set(contract.editor.blocks.map((block) => block.category))];
  assert(editorCategories.length > 0, "editor.blocks must declare at least one category");
  for (const block of contract.editor.blocks) {
    assert(/^[A-Z][A-Za-z0-9]{0,63}$/.test(block.type), `editor block ${JSON.stringify(block.type)} is not a safe serialized identifier`);
    assert(block.renderer === block.type, `editor.${block.type}.renderer must preserve the serialized type`);
    assert(typeof block.category === "string" && /^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(block.category), `editor.${block.type}.category must be a safe identifier`);
    unique(block.slots, `editor.${block.type}.slots`);
    for (const slot of block.slots) assert(/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(slot), `editor.${block.type} has an invalid slot`);
  }
  for (const type of Object.keys(template.blocks)) {
    if (type !== template.contentSlot && type !== "TemplatePart") {
      assert(editorTypes.includes(type), `template block ${type} has no editor/renderer contract`);
    }
  }
  for (const [label, values] of Object.entries(contract.security.propertySanitizers)) unique(values, `security.propertySanitizers.${label}`);
  for (const [label, schemes] of Object.entries({
    navigationSchemes: contract.security.url.navigationSchemes,
    contentSchemes: contract.security.url.contentSchemes,
    mediaSchemes: contract.security.url.mediaSchemes,
    blockedPuckSchemes: contract.security.url.blockedPuckSchemes,
  })) {
    unique(schemes, `security.url.${label}`);
    for (const scheme of schemes) assert(/^[a-z][a-z0-9+.-]*$/.test(scheme), `security.url.${label} contains an invalid scheme`);
  }
  for (const label of ["iframeHosts"]) {
    const hosts = contract.security.html[label];
    unique(hosts, `security.html.${label}`);
    for (const host of hosts) assert(/^[a-z0-9.-]+$/.test(host) && !host.includes(".."), `security.html.${label} contains an invalid host`);
  }
  const providers = contract.security.html.videoProviders;
  assert(providers?.youtube && providers?.vimeo, "security.html.videoProviders must declare youtube and vimeo");
  for (const [provider, fields] of Object.entries(providers)) {
    for (const [field, value] of Object.entries(fields)) {
      if (!field.toLowerCase().includes("host")) continue;
      const hosts = Array.isArray(value) ? value : [value];
      unique(hosts, `security.html.videoProviders.${provider}.${field}`);
      for (const host of hosts) assert(/^[a-z0-9.-]+$/.test(host) && !host.includes(".."), `security.html.videoProviders.${provider}.${field} contains an invalid host`);
    }
  }
  for (const host of [providers.youtube.outputHost, providers.youtube.noCookieOutputHost, providers.vimeo.outputHost]) {
    assert(contract.security.html.iframeHosts.includes(host), `video provider output ${host} is absent from iframeHosts`);
  }
  assert(
    contract.security.url.navigationSchemes.every((scheme) => contract.security.url.contentSchemes.includes(scheme)),
    "security.url.navigationSchemes must be a subset of contentSchemes",
  );
  for (const [label, values] of Object.entries(contract.security.html)) {
    if (Array.isArray(values)) unique(values, `security.html.${label}`);
  }
  const inlineProperties = [...contract.security.html.inlineStyleProperties].sort();
  const inlinePatterns = Object.keys(contract.security.html.inlineStyleValuePatterns).sort();
  assert(JSON.stringify(inlineProperties) === JSON.stringify(inlinePatterns), "every inline style property needs exactly one value-pattern entry");
  for (const [property, patterns] of Object.entries(contract.security.html.inlineStyleValuePatterns)) {
    unique(patterns, `security.html.inlineStyleValuePatterns.${property}`);
    for (const pattern of patterns) new RegExp(pattern);
  }
  for (const [label, values] of Object.entries(contract.security.style)) {
    if (Array.isArray(values)) unique(values, `security.style.${label}`);
  }
}

const contract = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
validateContract(contract);

const banner = (label) => `/**\n * GENERATED ${label} from ${SOURCE_REL}.\n * Do not edit. Run: npm run generate:f5\n */\n`;
const literal = (value) => JSON.stringify(value, null, 2);
const quotedUnion = (values) => values.map((value) => JSON.stringify(value)).join(" | ") || "never";

function propertyType(spec, recursiveType) {
  switch (spec.kind) {
    case "number": return "number";
    case "boolean": return "boolean";
    case "enum": return quotedUnion(spec.values);
    case "slot": return `${recursiveType}[]`;
    default: return "string";
  }
}

function propsMapSource(blocks, recursiveType, requiredFromBlock) {
  return Object.entries(blocks).map(([type, block]) => {
    const required = new Set(requiredFromBlock(block));
    const properties = ["readonly id?: string;"];
    for (const [name, spec] of Object.entries(block.props)) {
      properties.push(`readonly ${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${propertyType(spec, recursiveType)};`);
    }
    if (block.slot) properties.push(`readonly ${JSON.stringify(block.slot)}?: ${recursiveType}[];`);
    return `  readonly ${JSON.stringify(type)}: { ${properties.join(" ")} };`;
  }).join("\n");
}

function runtimeSource(label) {
  const { template, chrome, theme } = contract.formats;
  const { html, propertySanitizers, style, url } = contract.security;
  return `${banner(label)}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export const VISUAL_CONTRACT_VERSION = ${contract.version} as const;
export const TEMPLATE_CONTRACT = deepFreeze(${literal(template)} as const);
export const CHROME_CONTRACT = deepFreeze(${literal(chrome)} as const);
export const THEME_CONTRACT = deepFreeze(${literal(theme)} as const);
export const PROPERTY_SANITIZERS = deepFreeze(${literal(propertySanitizers)} as const);
export const HTML_SANITIZATION = deepFreeze(${literal(html)} as const);
export const URL_SANITIZATION = deepFreeze(${literal(url)} as const);
export const STYLE_SECURITY = deepFreeze(${literal(style)} as const);
`;
}

function typesSource() {
  const templateTypes = Object.keys(contract.formats.template.blocks);
  const chromeTypes = Object.keys(contract.formats.chrome.blocks);
  const coreTypes = contract.editor.blocks.map((block) => block.type);
  const coreCategories = [...new Set(contract.editor.blocks.map((block) => block.category))];
  const areas = contract.formats.theme.templateParts.areas;
  const templateProps = propsMapSource(
    contract.formats.template.blocks,
    "GeneratedTemplateBlock",
    (block) => block.required || [],
  );
  const chromeProps = propsMapSource(
    contract.formats.chrome.blocks,
    "GeneratedChromeBlock",
    (block) => Object.entries(block.props).filter(([, spec]) => spec.required).map(([name]) => name),
  );
  return `${banner("TypeScript types")}
export type VisualContractVersion = ${contract.version};
export type TemplateBlockType = ${quotedUnion(templateTypes)};
export type ChromeBlockType = ${quotedUnion(chromeTypes)};
export type CoreBlockType = ${quotedUnion(coreTypes)};
export type CoreBlockCategory = ${quotedUnion(coreCategories)};
export type TemplatePartArea = ${quotedUnion(areas)};

export interface GeneratedTemplatePropsByType {
${templateProps}
}

export type GeneratedTemplateBlock = {
  readonly [Type in TemplateBlockType]: {
    readonly type: Type;
    readonly props: GeneratedTemplatePropsByType[Type];
  }
}[TemplateBlockType];

export interface GeneratedTemplateTree {
  readonly content: GeneratedTemplateBlock[];
}

export interface GeneratedChromePropsByType {
${chromeProps}
}

export type GeneratedChromeBlock = {
  readonly [Type in ChromeBlockType]: {
    readonly type: Type;
    readonly props: GeneratedChromePropsByType[Type];
  }
}[ChromeBlockType];
`;
}

function editorSource() {
  const blocks = contract.editor.blocks;
  return `${banner("Verso editor registry")}
import type { CoreBlockCategory, CoreBlockType } from "./visual-contract.types.generated";

export interface GeneratedCoreBlockRegistration {
  readonly type: CoreBlockType;
  readonly category: CoreBlockCategory;
  readonly renderer: CoreBlockType;
  readonly slots: readonly string[];
}

export const GENERATED_CORE_BLOCK_REGISTRY = ${literal(blocks)} as const satisfies readonly GeneratedCoreBlockRegistration[];
export const CORE_BLOCK_TYPES = GENERATED_CORE_BLOCK_REGISTRY.map((block) => block.type) as readonly CoreBlockType[];
export const CORE_BLOCK_SLOTS: Readonly<Record<CoreBlockType, readonly string[]>> = Object.freeze(
  Object.fromEntries(GENERATED_CORE_BLOCK_REGISTRY.map((block) => [block.type, block.slots])) as unknown as Record<CoreBlockType, readonly string[]>,
);
`;
}

function docsSource() {
  const templateRows = Object.entries(contract.formats.template.blocks).map(([type, block]) => {
    const required = new Set(block.required || []);
    const props = Object.entries(block.props).map(([name, spec]) => `${name}: ${spec.kind}${required.has(name) ? " (required)" : ""}`).join("<br>") || "—";
    return `| \`${type}\` | ${block.slot ? `\`${block.slot}\`` : "—"} | ${props} |`;
  }).join("\n");
  const chromeRows = Object.entries(contract.formats.chrome.blocks).map(([type, block]) => {
    const props = Object.entries(block.props).map(([name, spec]) => `${name}: ${spec.kind}${spec.required ? " (required)" : ""}`).join("<br>") || "—";
    return `| \`${type}\` | ${props} |`;
  }).join("\n");
  const editorRows = contract.editor.blocks.map((block) => `| \`${block.type}\` | ${block.category} | ${block.slots.length ? block.slots.map((slot) => `\`${slot}\``).join(", ") : "—"} |`).join("\n");
  return `<!-- GENERATED from ${SOURCE_REL}; do not edit. -->
# Contrato visual para plugins (v${contract.version})

El backend es la autoridad de seguridad. Backend, frontend, Verso y esta documentación se generan desde
\`${SOURCE_REL}\`; ningún plugin debe importar módulos internos del backend ni copiar sus límites.

## Templates de tema

Límites: ${contract.formats.template.limits.maxBytes} bytes, ${contract.formats.template.limits.maxBlocks} bloques y profundidad ${contract.formats.template.limits.maxDepth}. Debe existir exactamente un \`${contract.formats.template.contentSlot}\`.

| Bloque | Slot de hijos | Propiedades |
| --- | --- | --- |
${templateRows}

## Chrome

Límites: ${contract.formats.chrome.limits.maxBytes} bytes, ${contract.formats.chrome.limits.maxBlocks} bloques y profundidad ${contract.formats.chrome.limits.maxDepth}.

| Bloque | Propiedades |
| --- | --- |
${chromeRows}

## Registro core de Verso

| Tipo serializado/renderizado | Categoría | Slots |
| --- | --- | --- |
${editorRows}

## Reglas de seguridad

- HTML enriquecido: solo las propiedades \`${contract.security.propertySanitizers.richText.join("`, `")}\` activan el saneador autoritativo.
- URL: solo esquemas de contenido \`${contract.security.url.contentSchemes.join("`, `")}\`; navegación estructural limitada a \`${contract.security.url.navigationSchemes.join("`, `")}\` y rutas del sitio.
- Estilos: ${contract.security.style.authorProperties.length} propiedades CSS y ${contract.security.style.authorCustomProperties.length} variables personalizadas están permitidas por nombre; valores con sintaxis de inyección son eliminados.
- Clases estructurales: máximo ${contract.formats.template.classList.maxTokens} tokens que casen \`${contract.formats.template.classList.tokenPattern}\`, además del filtro contra clases que sacan contenido del flujo.

Para añadir un bloque, cambie la definición canónica, regenere y proporcione su implementación de render. El gate F5 comprueba que el editor y el renderer cubran exactamente el registro generado.
`;
}

const outputs = new Map([
  ["backend/src/generated/visual-contract.generated.ts", runtimeSource("backend validator data")],
  ["frontend/src/generated/visual-contract.generated.ts", runtimeSource("frontend parser data")],
  ["frontend/src/generated/visual-contract.types.generated.ts", typesSource()],
  ["frontend/src/generated/verso-registry.generated.ts", editorSource()],
  ["documentation/generated/plugin-visual-contract.md", docsSource()],
]);

for (const [relative, content] of outputs) {
  const target = path.join(ROOT, relative);
  const normalized = content.replace(/\r\n/g, "\n");
  if (CHECK) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n") : null;
    if (current !== normalized) fail(`${relative} is stale; run npm run generate:f5`);
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, normalized, "utf8");
  process.stdout.write(`[visual-contract] wrote ${relative}\n`);
}

if (!process.exitCode) process.stdout.write(`[visual-contract] ${CHECK ? "all artifacts are current" : "generation complete"}\n`);
