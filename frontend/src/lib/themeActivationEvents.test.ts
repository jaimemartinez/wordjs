import { afterEach, describe, expect, it, vi } from "vitest";
import {
    parseThemeActivationSignal,
    publishThemeActivation,
    subscribeToThemeActivation,
    THEME_ACTIVATION_STORAGE_KEY,
} from "./themeActivationEvents";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("theme activation events", () => {
    it("publishes a same-document signal and persists the cross-tab fallback", () => {
        const stored = new Map<string, string>();
        const fakeWindow = Object.assign(new EventTarget(), {
            BroadcastChannel: undefined,
            localStorage: {
                setItem: (key: string, value: string) => stored.set(key, value),
            },
        });
        vi.stubGlobal("window", fakeWindow);

        const received: string[] = [];
        const unsubscribe = subscribeToThemeActivation((signal) => received.push(signal.slug));
        publishThemeActivation("artisan-craft");
        unsubscribe();

        expect(received).toEqual(["artisan-craft"]);
        expect(parseThemeActivationSignal(stored.get(THEME_ACTIVATION_STORAGE_KEY))).toMatchObject({
            type: "theme-activated",
            slug: "artisan-craft",
        });
    });

    it("rejects malformed and empty activation messages", () => {
        expect(parseThemeActivationSignal("not-json")).toBeNull();
        expect(parseThemeActivationSignal({ type: "theme-activated", slug: "", id: "1" })).toBeNull();
        expect(parseThemeActivationSignal({ type: "other", slug: "default", id: "1" })).toBeNull();
    });
});
