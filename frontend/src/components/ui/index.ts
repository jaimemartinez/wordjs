/**
 * WordJS Design System - UI Components
 *
 * THE admin form kit: every field, choice and action of the core admin comes from here (the
 * formControlsGate test and ESLint refuse a raw <input>/<select>/<textarea>/<button> elsewhere in the
 * admin). Fields share one contract — label, help, error, required — wired in ./Field.
 */

export { PageHeader } from "./PageHeader";
export { Card } from "./Card";
export { StatCard } from "./StatCard";
export { StatusBadge } from "./StatusBadge";
export { EmptyState } from "./EmptyState";
export { ActionCard } from "./ActionCard";

// Fields
export { Field, useFieldA11y } from "./Field";
export type { FieldProps } from "./Field";
export { Input } from "./Input";
export type { InputProps } from "./Input";
export { Textarea } from "./Textarea";
export type { TextareaProps } from "./Textarea";
export { Select } from "./Select";
export type { SelectProps, SelectOption } from "./Select";
export { Checkbox } from "./Checkbox";
export { Radio, RadioGroup } from "./Radio";
export { Switch } from "./Switch";
export { ColorInput } from "./ColorInput";
export { Slider } from "./Slider";
export { TimePicker } from "./TimePicker";
export { DatePicker, DateTimePicker } from "./DatePicker";

// Actions
export { Button } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./Button";
export { IconButton } from "./IconButton";
export { ButtonLink } from "./ButtonLink";
export { UnstyledButton } from "./UnstyledButton";
export { FileButton } from "./FileButton";
export { SegmentedControl } from "./SegmentedControl";
export { Tabs } from "./Tabs";

export { DataTable, RowActionButton } from "./DataTable";
export type { DataTableColumn, DataTableAction, DataTableSelection } from "./DataTable";
export { Pagination } from "./Pagination";
export { RowActionsMenu } from "./RowActionsMenu";
