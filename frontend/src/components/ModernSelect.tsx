/**
 * ModernSelect — a shim over THE admin select, components/ui/Select (the form kit's one select).
 *
 * It keeps the event-style API the screens that import it still use: `onChange` receives
 * `{ target: { value } }` like a native <select>'s change event. New code imports `Select` from
 * "@/components/ui" (value-based `onChange(value)`); this file goes when its last importer moves.
 */
import React from "react";
import { Select, type SelectOption, type SelectProps } from "./ui/Select";

export { OPTION_LABEL_CLASS, GROUP_HEADING_CLASS, EMPTY_LIST_CLASS, PLACEHOLDER_CLASS } from "./ui/Select";

export interface ModernSelectProps extends Omit<SelectProps, "onChange" | "options"> {
    options: SelectOption[];
    onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
}

const ModernSelect: React.FC<ModernSelectProps> = ({ onChange, ...props }) => (
    <Select
        {...props}
        onChange={onChange ? (value) => onChange({ target: { value }, currentTarget: { value } } as React.ChangeEvent<HTMLSelectElement>) : undefined}
    />
);

export default ModernSelect;
