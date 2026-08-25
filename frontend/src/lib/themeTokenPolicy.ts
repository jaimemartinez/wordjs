/** Pure frontend consumer of the generated theme-token security contract. */
import { THEME_CONTRACT } from "@/generated/visual-contract.generated";

const POLICY = THEME_CONTRACT.tokens;
export const THEME_TOKEN_MOD_NAME = new RegExp(POLICY.modNamePattern);
export const THEME_TOKEN_VALUE = new RegExp(POLICY.valuePattern);
export const THEME_TOKEN_MAX_VALUE_LENGTH = POLICY.maxValueLength;
const FORBIDDEN_FUNCTION = new RegExp(POLICY.forbiddenFunctionPattern, "i");

export function isForbiddenThemeTokenValue(value: string): boolean {
    return FORBIDDEN_FUNCTION.test(value)
        || POLICY.forbiddenSubstrings.some((substring) => value.includes(substring));
}

export function isValidThemeMod(key: unknown, value: unknown): value is string {
    return typeof key === "string"
        && THEME_TOKEN_MOD_NAME.test(key)
        && typeof value === "string"
        && value.length > 0
        && value.length <= THEME_TOKEN_MAX_VALUE_LENGTH
        && THEME_TOKEN_VALUE.test(value)
        && !isForbiddenThemeTokenValue(value);
}

export function sanitizeThemeMods(input: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(Object.entries(input).filter(([key, value]) => isValidThemeMod(key, value))) as Record<string, string>;
}
