"use client";
/**
 * Verso — renderers de los 10 tipos de VersoField (registry.ts) para el panel
 * de propiedades. <VersoFieldControl field value onChange label/> despacha por
 * field.type; toda la lógica interacción→valor vive en fieldHelpers.ts (pura,
 * testeada en node).
 *
 * Accesibilidad: cada input lleva id (useId) asociado a su <label htmlFor>;
 * radio usa fieldset/legend + name de grupo; array expone grupo etiquetado y
 * botones con aria-label posicional. Estilos: solo clases tailwind/tokens
 * --ed-* ya existentes en el admin (VisibilityField et al.), sin CSS nuevo.
 *
 * - `external` no se acopla a MediaPickerModal: el picker se INYECTA vía la
 *   prop renderExternalPicker; sin ella el botón queda deshabilitado.
 * - `custom` delega en field.render (contrato de Puck: {field,name,id,value,
 *   onChange,readOnly}).
 * - `slot` no se edita en el panel: los hijos de árbol se manipulan en el
 *   lienzo — se renderiza un aviso, jamás un input.
 */
import React, { useId, useState } from "react";
import type {
  ArrayVersoField,
  CustomVersoField,
  ExternalVersoField,
  NumberVersoField,
  ObjectVersoField,
  RadioVersoField,
  SelectVersoField,
  SlotVersoField,
  TextVersoField,
  TextareaVersoField,
  VersoField,
} from "@/lib/verso/registry";
import {
  arrayAppend,
  arrayMove,
  arrayPatchItem,
  arrayRemoveAt,
  asArrayItems,
  asObjectValue,
  canAddItem,
  canRemoveItem,
  objectSet,
  optionIndexOf,
  optionValueAt,
  parseNumberInput,
} from "./fieldHelpers";

/** Picker inyectable del campo `external` (p.ej. un modal de media). */
export type RenderExternalPicker = (args: {
  field: ExternalVersoField;
  value: unknown;
  /** Aplica field.mapProp (si existe), emite onChange y cierra el picker. */
  onSelect: (item: unknown) => void;
  close: () => void;
}) => React.ReactNode;

export interface VersoFieldControlProps {
  field: VersoField;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Etiqueta visible; si falta se usa field.label y, en último término, name. */
  label?: string;
  /** Nombre lógico del campo (la clave de props); requerido por `custom`. */
  name?: string;
  readOnly?: boolean;
  renderExternalPicker?: RenderExternalPicker;
}

const LABEL_CLS = "block text-xs font-medium text-[var(--ed-on-surface-variant)] mb-1";
const INPUT_CLS =
  "w-full rounded border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-high)] px-2 py-1.5 text-sm text-[var(--ed-on-surface)]";
const BTN_CLS =
  "rounded border border-[var(--ed-outline-variant)] px-2 py-1 text-xs text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)] disabled:opacity-40";

function labelTextOf(props: VersoFieldControlProps): string {
  return props.label ?? props.field.label ?? props.name ?? "";
}

function FieldShell({ id, label, children }: { id?: string; label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      {label && (
        <label htmlFor={id} className={LABEL_CLS}>
          {label}
        </label>
      )}
      {children}
    </div>
  );
}

const asInputString = (value: unknown): string =>
  typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);

/* ------------------------------------------------------------------ */
/* Controles por tipo.                                                 */
/* ------------------------------------------------------------------ */

interface ControlProps<F extends VersoField> extends Omit<VersoFieldControlProps, "field"> {
  field: F;
}

function TextControl(props: ControlProps<TextVersoField>) {
  const { field, value, onChange, readOnly } = props;
  const id = useId();
  return (
    <FieldShell id={id} label={labelTextOf(props)}>
      <input
        id={id}
        type="text"
        className={INPUT_CLS}
        value={asInputString(value)}
        placeholder={field.placeholder}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldShell>
  );
}

function TextareaControl(props: ControlProps<TextareaVersoField>) {
  const { field, value, onChange, readOnly } = props;
  const id = useId();
  return (
    <FieldShell id={id} label={labelTextOf(props)}>
      <textarea
        id={id}
        rows={4}
        className={INPUT_CLS}
        value={asInputString(value)}
        placeholder={field.placeholder}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldShell>
  );
}

function NumberControl(props: ControlProps<NumberVersoField>) {
  const { field, value, onChange, readOnly } = props;
  const id = useId();
  return (
    <FieldShell id={id} label={labelTextOf(props)}>
      <input
        id={id}
        type="number"
        className={INPUT_CLS}
        value={typeof value === "number" ? value : ""}
        placeholder={field.placeholder}
        min={field.min}
        max={field.max}
        step={field.step}
        readOnly={readOnly}
        onChange={(e) => onChange(parseNumberInput(e.target.value))}
      />
    </FieldShell>
  );
}

function SelectControl(props: ControlProps<SelectVersoField>) {
  const { field, value, onChange, readOnly } = props;
  const id = useId();
  const selected = optionIndexOf(field.options, value);
  return (
    <FieldShell id={id} label={labelTextOf(props)}>
      <select
        id={id}
        className={INPUT_CLS}
        value={selected === -1 ? "" : String(selected)}
        disabled={readOnly}
        onChange={(e) => onChange(optionValueAt(field.options, e.target.value))}
      >
        {selected === -1 && <option value="" disabled />}
        {field.options.map((option, i) => (
          <option key={i} value={String(i)}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

function RadioControl(props: ControlProps<RadioVersoField>) {
  const { field, value, onChange, readOnly } = props;
  const groupName = useId();
  const selected = optionIndexOf(field.options, value);
  return (
    <fieldset className="mb-3">
      <legend className={LABEL_CLS}>{labelTextOf(props)}</legend>
      <div
        role="radiogroup"
        aria-label={labelTextOf(props)}
        className="flex flex-wrap gap-1 rounded border border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-high)] p-0.5"
      >
        {field.options.map((option, i) => (
          <label
            key={i}
            className={`flex-1 cursor-pointer rounded px-2 py-1 text-center text-xs ${
              selected === i
                ? "bg-[var(--ed-primary)] text-white"
                : "text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container)]"
            }`}
          >
            <input
              type="radio"
              name={groupName}
              className="sr-only"
              checked={selected === i}
              disabled={readOnly}
              onChange={() => onChange(optionValueAt(field.options, String(i)))}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ArrayControl(props: ControlProps<ArrayVersoField>) {
  const { field, value, onChange, readOnly, renderExternalPicker } = props;
  const labelText = labelTextOf(props);
  const items = asArrayItems(value);
  return (
    <div className="mb-3" role="group" aria-label={labelText}>
      {labelText && <span className={LABEL_CLS}>{labelText}</span>}
      <ul className="space-y-2">
        {items.map((item, i) => {
          const summary = field.getItemSummary?.(item, i) ?? `${labelText || "Elemento"} ${i + 1}`;
          return (
            <li key={i} className="rounded border border-[var(--ed-outline-variant)] p-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-[var(--ed-on-surface)]">{summary}</span>
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    className={BTN_CLS}
                    aria-label={`Subir elemento ${i + 1}`}
                    disabled={readOnly || i === 0}
                    onClick={() => onChange(arrayMove(items, i, i - 1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={BTN_CLS}
                    aria-label={`Bajar elemento ${i + 1}`}
                    disabled={readOnly || i === items.length - 1}
                    onClick={() => onChange(arrayMove(items, i, i + 1))}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className={BTN_CLS}
                    aria-label={`Quitar elemento ${i + 1}`}
                    disabled={readOnly || !canRemoveItem(field, items)}
                    onClick={() => onChange(arrayRemoveAt(field, items, i))}
                  >
                    ×
                  </button>
                </span>
              </div>
              {Object.entries(field.arrayFields).map(([key, subField]) => (
                <VersoFieldControl
                  key={key}
                  field={subField}
                  name={key}
                  value={item[key]}
                  readOnly={readOnly}
                  renderExternalPicker={renderExternalPicker}
                  onChange={(v) => onChange(arrayPatchItem(items, i, key, v))}
                />
              ))}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className={`${BTN_CLS} mt-2 w-full`}
        aria-label={`Añadir elemento a ${labelText || "la lista"}`}
        disabled={readOnly || !canAddItem(field, items)}
        onClick={() => onChange(arrayAppend(field, items))}
      >
        + Añadir
      </button>
    </div>
  );
}

function ObjectControl(props: ControlProps<ObjectVersoField>) {
  const { field, value, onChange, readOnly, renderExternalPicker } = props;
  const labelText = labelTextOf(props);
  const obj = asObjectValue(value);
  return (
    <fieldset className="mb-3 rounded border border-[var(--ed-outline-variant)] p-2">
      {labelText && <legend className={LABEL_CLS}>{labelText}</legend>}
      {Object.entries(field.objectFields).map(([key, subField]) => (
        <VersoFieldControl
          key={key}
          field={subField}
          name={key}
          value={obj[key]}
          readOnly={readOnly}
          renderExternalPicker={renderExternalPicker}
          onChange={(v) => onChange(objectSet(value, key, v))}
        />
      ))}
    </fieldset>
  );
}

function ExternalControl(props: ControlProps<ExternalVersoField>) {
  const { field, value, onChange, readOnly, renderExternalPicker } = props;
  const id = useId();
  const [open, setOpen] = useState(false);
  const hasValue = value !== undefined && value !== null;
  const summary = hasValue
    ? (field.getItemSummary?.(value) ?? "Seleccionado")
    : (field.placeholder ?? "Sin selección");
  return (
    <FieldShell id={id} label={labelTextOf(props)}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--ed-on-surface-variant)]">{summary}</span>
        <button
          type="button"
          id={id}
          className={BTN_CLS}
          disabled={readOnly || !renderExternalPicker}
          title={renderExternalPicker ? undefined : "Sin picker inyectado (renderExternalPicker)"}
          onClick={() => setOpen(true)}
        >
          Seleccionar…
        </button>
        {hasValue && (
          <button
            type="button"
            className={BTN_CLS}
            aria-label="Quitar selección"
            disabled={readOnly}
            onClick={() => onChange(undefined)}
          >
            ×
          </button>
        )}
      </div>
      {open &&
        renderExternalPicker &&
        renderExternalPicker({
          field,
          value,
          close: () => setOpen(false),
          onSelect: (item) => {
            onChange(field.mapProp ? field.mapProp(item) : item);
            setOpen(false);
          },
        })}
    </FieldShell>
  );
}

function CustomControl(props: ControlProps<CustomVersoField>) {
  const { field, value, onChange, name, readOnly } = props;
  const id = useId();
  return (
    <div className="mb-3">
      {field.render({ field, name: name ?? "", id, value, onChange, readOnly }) as React.ReactNode}
    </div>
  );
}

function SlotNotice(props: ControlProps<SlotVersoField>) {
  const labelText = labelTextOf(props);
  return (
    <div
      data-verso-slot-field=""
      role="note"
      className="mb-3 rounded border border-dashed border-[var(--ed-outline-variant)] px-2 py-1.5 text-xs text-[var(--ed-on-surface-variant)]"
    >
      Los bloques de «{labelText || "este slot"}» se editan arrastrando en el lienzo, no desde este panel.
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dispatch.                                                           */
/* ------------------------------------------------------------------ */

export default function VersoFieldControl(props: VersoFieldControlProps): React.ReactNode {
  const { field } = props;
  // `visible: false` oculta el control sin retirar el campo del contrato de datos.
  if (field.visible === false) return null;
  switch (field.type) {
    case "text":
      return <TextControl {...props} field={field} />;
    case "textarea":
      return <TextareaControl {...props} field={field} />;
    case "number":
      return <NumberControl {...props} field={field} />;
    case "select":
      return <SelectControl {...props} field={field} />;
    case "radio":
      return <RadioControl {...props} field={field} />;
    case "array":
      return <ArrayControl {...props} field={field} />;
    case "object":
      return <ObjectControl {...props} field={field} />;
    case "external":
      return <ExternalControl {...props} field={field} />;
    case "custom":
      return <CustomControl {...props} field={field} />;
    case "slot":
      return <SlotNotice {...props} field={field} />;
  }
}
