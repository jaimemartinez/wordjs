/**
 * Verso — motor de interacciones (F9-A: modelo + compilador + runtime mínimo).
 *
 * Superficie pública del módulo. Todo lo de aquí es PURO salvo `runtime/*`, que es el único código
 * que toca el DOM y que se carga aparte (ver `runtime/host.ts`).
 *
 * Resumen en una frase: una interacción es una PROP del bloque que un COMPILADOR PURO convierte en
 * CSS nativo con nombres deterministas; el JS solo aparece para lo que el CSS no puede expresar
 * —clic, latch de "una sola vez", objetivo externo— o para el navegador que aún no lo soporta.
 */
export type {
  IxBody,
  IxBreakpoint,
  IxClipDir,
  IxColorPropKey,
  IxColorToken,
  IxEase,
  IxEdge,
  IxEdgeName,
  IxKeyframe,
  IxOrigin,
  IxNeedsRuntime,
  IxPage,
  IxPreset,
  IxPropKey,
  IxProps,
  IxRange,
  IxRuntimeTrack,
  IxRuntimeUnit,
  IxSpec,
  IxStagger,
  IxStaggerFrom,
  IxStep,
  IxTarget,
  IxTrack,
  IxTrigger,
  IxUnit,
} from "./types";

export {
  canonicalJson,
  fnv1a32,
  ixHash,
  round4,
  IX_NUM_PRECISION,
} from "./canonical";

export {
  normalizeIxSpec,
  normalizeIxPreset,
  normProps,
  normTracks,
  normTrigger,
  IX_AMT_MAX,
  IX_AMT_MIN,
  IX_BEZ_Y_MAX,
  IX_BREAKPOINTS,
  IX_CLIP_DIRS,
  IX_COLOR_PROP_KEYS,
  IX_COLOR_TOKENS,
  IX_DELAY_MAX,
  IX_DELAY_MIN,
  IX_DUR_MAX,
  IX_DUR_MIN,
  IX_EASINGS,
  IX_EDGE_NAMES,
  IX_EVENT_NAME_RE,
  IX_EVENT_PREFIX,
  IX_ORIGINS,
  IX_PERSP_DEFAULT,
  IX_PERSP_MAX,
  IX_PERSP_MIN,
  IX_POINTER_SMOOTH_DEFAULT,
  IX_POINTER_SMOOTH_MAX,
  IX_MAX_CHILDREN,
  IX_MAX_STEPS,
  IX_MAX_TRACKS,
  IX_MAX_UNITS_PER_PAGE,
  IX_MAX_WORDS,
  IX_PROP_KEYS,
  IX_PROP_NEUTRAL,
  IX_REPEAT_MAX,
  IX_STAGGER_COLS_MAX,
  IX_STAGGER_COLS_MIN,
  IX_STAGGER_MAX,
  IX_STAGGER_TOTAL_FALLBACK_N,
} from "./normalize";
export type { IxNormalizeResult } from "./normalize";

export {
  compileIx,
  compileIxPage,
  emitUnit,
  ixClassFor,
  ixCss,
  ixKeyframes,
  ixMediaOf,
  resolveIxBody,
  toRuntimeUnit,
  IX_CLASS_PREFIX,
  IX_DEFAULT_RANGES,
  IX_MOTION_POLICIES,
  normalizeIxMotion,
  IX_DEFAULT_TRIGGER,
  IX_KEYFRAME_PREFIX,
  IX_WORD_COUNT_VAR,
  IX_WORD_INDEX_VAR,
} from "./compile";
export type { IxCompileCtx, IxMotionPolicy, IxResolved } from "./compile";

export { ixLayer, IX_STATE_ATTR, IX_SYS_CTX, IX_TRIGGER_ATTR } from "./shell";
export type { IxLayer } from "./shell";

export { ixSplitWords, ixTargetsWords, IX_WORD_CLASS } from "./words";
export type { IxSplitOptions, IxWordSplit } from "./words";

export { SYS_IX_PRESETS, SYS_IX_PRESET_IDS } from "./presets";

export { collectIxSpecs, IX_COLLECT_MAX_DEPTH, IX_COLLECT_MAX_NODES } from "./collect";

export {
  ixFreePresetId,
  ixPresetDelete,
  ixPresetDuplicate,
  ixPresetSave,
  ixPresetSlug,
  ixPresetToSpec,
  ixPresetUsage,
  ixSpecToBody,
  IX_PRESET_NAME_MAX,
  IX_SYS_PREFIX,
} from "./presetsAdmin";
export type { IxCatalog, IxCatalogResult, IxPresetDraft } from "./presetsAdmin";

export {
  ixCtxFromSetting,
  ixCtxFromSite,
  parseSiteIxPresets,
  serializeSiteIxPresets,
  IX_MAX_SITE_PRESETS,
  IX_PRESETS_MAX_BYTES,
  IX_PRESETS_SETTING,
} from "./sitePresets";
