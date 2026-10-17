/**
 * "Suggest with AI" error wording: a provider failure with its own code (timeout, a model without vision,
 * an unknown model…) is shown in its own translated words; any other ai_provider_* code falls back to the
 * generic provider message. Every specific provider code the backend answers is translated in every locale.
 */
import { describe, it, expect } from "vitest";
import { aiErrorKey } from "../AiSuggest";
import { translations } from "@/lib/i18n";

const SPECIFIC = ["ai_provider_timeout", "ai_provider_no_vision", "ai_provider_model", "ai_provider_unreachable", "ai_provider_auth"];

describe("AiSuggest error keys", () => {
    const en = (key: string) => Object.prototype.hasOwnProperty.call(translations.en, key);

    it("uses the code's own wording when there is one", () => {
        for (const code of SPECIFIC) expect(aiErrorKey(code, en)).toBe(`ai.err.${code}`);
        expect(aiErrorKey("ai_refused", en)).toBe("ai.err.ai_refused");
    });

    it("falls back to the generic provider message for other provider codes, and to nothing without a code", () => {
        expect(aiErrorKey("ai_provider_unavailable", en)).toBe("ai.err.provider");
        expect(aiErrorKey("ai_provider_error", en)).toBe("ai.err.provider");
        expect(aiErrorKey("", en)).toBe("");
    });

    it("translates every specific provider code in every locale", () => {
        for (const [locale, table] of Object.entries(translations)) {
            for (const code of SPECIFIC) {
                expect(Object.prototype.hasOwnProperty.call(table, `ai.err.${code}`), `${locale}: ai.err.${code}`).toBe(true);
            }
        }
    });
});
