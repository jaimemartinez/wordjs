/**
 * Verso — motor de texto inline PROPIO (F3.5). API pública del motor.
 *
 * Contrato: documentation/verso/inline-engine-spec.md + los 54 casos de
 * __fixtures__/text-cases.json. Todo es lógica pura (node, sin DOM); la capa
 * DOM vive en components/verso/inline/ (VersoTextSurface).
 */

export type {
    Atom,
    Block,
    DocPoint,
    DocSelection,
    InlineUnit,
    LinkAttrs,
    Marks,
    Para,
    ParaAddress,
    ParaRef,
    RichDoc,
} from "./model";
export {
    NO_MARKS,
    atomsToPara,
    cloneDoc,
    cloneMarks,
    collapsedAt,
    comparePoints,
    docIsEmpty,
    emptyDoc,
    emptyPara,
    getPara,
    isCollapsed,
    listParas,
    normalizeDoc,
    normalizePara,
    paraIndexOf,
    paraLength,
    paraText,
    paraToAtoms,
    sameLink,
    sameMarks,
} from "./model";

export { parseRichHtml, projectHtmlToBlocks, projectPastedHtml, tokenizeHtml } from "./parse";
export { docGuardText, inlineGuardLosesText, normalizeGuardText } from "./guard";
export { FILLER_BR_ATTR, serializeDoc, serializeDocForEditor, serializePara } from "./serialize";

export type { ActiveStates, MarkName, OpResult, PasteData } from "./ops";
export {
    activeStates,
    applyLink,
    caretMarks,
    clearFormat,
    deleteSelection,
    flattenToSingleLine,
    insertParagraphBreak,
    insertText,
    pasteRich,
    plainPasteText,
    plainReplaceRange,
    removeLink,
    setList,
    toggleMark,
    unlist,
} from "./ops";
