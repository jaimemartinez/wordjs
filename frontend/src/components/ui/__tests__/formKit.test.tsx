/**
 * The admin form kit (components/ui): one field contract for every control, and buttons that never submit
 * a form by accident. Rendered on the server (this suite has no DOM): the markup is what assistive tech
 * reads, so the wiring is checked there.
 */
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    Button, ButtonLink, Checkbox, ColorInput, IconButton, Input, Radio, RadioGroup, SegmentedControl, Select, Slider, Switch,
    Tabs, Textarea, UnstyledButton,
} from "..";
import ModernSelect from "../../ModernSelect";
import { normalizeHex } from "../ColorInput";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
/** The value of attribute `name` on the first element whose tag is `tag`. */
const attr = (markup: string, tag: string, name: string) => {
    const el = new RegExp(`<${tag}\\b[^>]*>`).exec(markup)?.[0] ?? "";
    return new RegExp(`\\s${name}="([^"]*)"`).exec(el)?.[1];
};

describe("the field contract: label, help, error, required — wired the same on every control", () => {
    it("Input: label for the input, help and error described, invalid and required announced", () => {
        const m = html(<Input id="title" label="Title" help="Shown in the tab" error="Required" required value="" onChange={() => {}} />);
        expect(m).toContain('<label for="title"');
        expect(attr(m, "input", "aria-describedby")).toBe("title-help title-error");
        expect(attr(m, "input", "aria-invalid")).toBe("true");
        expect(attr(m, "input", "aria-required")).toBe("true");
        expect(m).toContain('id="title-help"');
        expect(m).toMatch(/id="title-error" role="alert"/);
    });

    it("without help or error, nothing is described and an aria-invalid the caller set is kept", () => {
        const m = html(<Input aria-label="Search" aria-invalid="true" value="" onChange={() => {}} />);
        expect(attr(m, "input", "aria-describedby")).toBeUndefined();
        expect(attr(m, "input", "aria-invalid")).toBe("true");
        expect(m).not.toContain("<label");
    });

    it("a caller's own aria-describedby is kept, before help and error", () => {
        const m = html(<Input id="x" aria-describedby="hint" help="h" value="" onChange={() => {}} aria-label="x" />);
        expect(attr(m, "input", "aria-describedby")).toBe("hint x-help");
    });

    it("a password field can reveal what was typed, with a named toggle", () => {
        const m = html(<Input type="password" label="Password" revealable value="" onChange={() => {}} />);
        expect(attr(m, "input", "type")).toBe("password");
        expect(m).toMatch(/<button type="button" aria-label="Show password" aria-pressed="false"/);
    });

    it("Textarea: same wiring, and a counter when asked", () => {
        const m = html(<Textarea id="bio" label="Bio" error="Too long" maxLength={10} showCount value="abc" onChange={() => {}} />);
        expect(m).toContain('<label for="bio"');
        expect(attr(m, "textarea", "aria-invalid")).toBe("true");
        expect(attr(m, "textarea", "aria-describedby")).toBe("bio-error");
        expect(m).toContain("3 / 10");
    });

    it("Select: the label names the trigger button, which opens a listbox; error and help wired", () => {
        const m = html(<Select id="lang" label="Language" help="h" error="e" options={[{ value: "es", label: "Español" }]} value="es" onChange={() => {}} />);
        expect(m).toContain('<label for="lang"');
        expect(attr(m, "button", "id")).toBe("lang");
        expect(attr(m, "button", "aria-haspopup")).toBe("listbox");
        expect(attr(m, "button", "aria-describedby")).toBe("lang-help lang-error");
        expect(attr(m, "button", "aria-invalid")).toBe("true");
        // The resting-border rule (admin-globals.css) targets the trigger by this attribute.
        expect(m).toContain('data-modern-select=""');
        expect(m).toContain("Español");
    });

    it("Select shows the placeholder in the admin language when nothing is chosen", () => {
        const m = html(<Select aria-label="Role" options={[{ value: "a", label: "A" }]} value="" onChange={() => {}} />);
        expect(m).toContain("Select an option");
        expect(attr(m, "button", "aria-label")).toBe("Role");
    });

    it("Checkbox and Switch: the label is clickable and names the control", () => {
        const c = html(<Checkbox id="ok" label="I agree" checked={false} onChange={() => {}} />);
        expect(c).toContain('<label for="ok"');
        expect(attr(c, "input", "type")).toBe("checkbox");
        const s = html(<Switch id="dark" label="Dark mode" checked onChange={() => {}} help="Uses the editor palette" />);
        expect(attr(s, "button", "role")).toBe("switch");
        expect(attr(s, "button", "aria-checked")).toBe("true");
        expect(attr(s, "button", "aria-labelledby")).toBe("dark-label");
        expect(attr(s, "button", "type")).toBe("button");
        expect(attr(s, "button", "aria-describedby")).toBe("dark-help");
    });

    it("RadioGroup: a fieldset named by its legend; the group's value checks one radio", () => {
        const m = html(
            <RadioGroup label="Mode" value="b" onChange={() => {}} error="Pick one">
                <Radio value="a" label="A" />
                <Radio value="b" label="B" description="Recommended" />
            </RadioGroup>,
        );
        expect(m).toMatch(/<fieldset[^>]*role="radiogroup"/);
        expect(m).toContain("<legend");
        expect(attr(m, "fieldset", "aria-invalid")).toBe("true");
        expect(m.match(/type="radio"/g)).toHaveLength(2);
        expect(m).toMatch(/<input(?=[^>]*value="b")(?=[^>]*checked="")[^>]*>/);
        expect(m).not.toMatch(/<input(?=[^>]*value="a")(?=[^>]*checked="")[^>]*>/);
        const names = [...m.matchAll(/name="([^"]+)"/g)].map((x) => x[1]);
        expect(new Set(names).size).toBe(1);
    });

    it("ColorInput keeps #rrggbb: short and bare hex normalise, anything else is refused", () => {
        expect(normalizeHex("#ABC")).toBe("#aabbcc");
        expect(normalizeHex("1A2B3C")).toBe("#1a2b3c");
        expect(normalizeHex("red")).toBeNull();
        const m = html(<ColorInput label="Accent" value="#1a2b3c" onChange={() => {}} />);
        expect(m).toContain('type="color"');
        expect(m).toContain('value="#1a2b3c"');
    });

    it("Slider: a named range with its value read out", () => {
        const m = html(<Slider label="Opacity" value={40} onChange={() => {}} unit="%" />);
        expect(attr(m, "input", "type")).toBe("range");
        expect(attr(m, "input", "aria-valuetext")).toBe("40 %");
        expect(m).toContain("<output");
    });
});

describe("buttons never submit a form by accident", () => {
    it("Button, IconButton and UnstyledButton default to type=button; a submit is explicit", () => {
        expect(attr(html(<Button>Save</Button>), "button", "type")).toBe("button");
        expect(attr(html(<Button type="submit">Save</Button>), "button", "type")).toBe("submit");
        expect(attr(html(<IconButton icon="fa-trash" label="Delete" />), "button", "type")).toBe("button");
        expect(attr(html(<UnstyledButton>Row</UnstyledButton>), "button", "type")).toBe("button");
    });

    it("a pending Button is busy and disabled, and says what it is doing", () => {
        const m = html(<Button pending pendingLabel="Saving…">Save</Button>);
        expect(attr(m, "button", "aria-busy")).toBe("true");
        expect(m).toMatch(/<button[^>]*disabled=""/);
        expect(m).toContain("Saving…");
        expect(m).not.toContain(">Save<");
        expect(m).toContain("fa-spinner");
    });

    it("IconButton's name is required by its type and becomes aria-label and tooltip", () => {
        const m = html(<IconButton icon="fa-trash" label="Delete post" variant="danger" />);
        expect(attr(m, "button", "aria-label")).toBe("Delete post");
        expect(attr(m, "button", "title")).toBe("Delete post");
    });

    it("ButtonLink is a real link styled as a button", () => {
        const m = html(<ButtonLink href="/admin/posts" icon="fa-plus">New post</ButtonLink>);
        expect(m).toMatch(/^<a [^>]*href="\/admin\/posts"/);
        expect(m).not.toContain("<button");
    });
});

describe("choice strips: one tab stop, named", () => {
    it("SegmentedControl is a radiogroup; only the checked option is in the tab order", () => {
        const m = html(<SegmentedControl aria-label="View" value="grid" onChange={() => {}} options={[{ value: "grid", label: "Grid" }, { value: "list", label: "List" }]} />);
        expect(m).toMatch(/role="radiogroup" aria-label="View"/);
        expect(m.match(/role="radio"/g)).toHaveLength(2);
        expect(m.match(/tabindex="0"/g)).toHaveLength(1);
        expect(m).toMatch(/aria-checked="true" tabindex="0"/);
    });

    it("Tabs: tablist, tabs pointing at the selected panel, panel labelled by its tab", () => {
        const m = html(<Tabs aria-label="Settings" value="general" onChange={() => {}} tabs={[{ value: "general", label: "General" }, { value: "media", label: "Media", badge: 3 }]}><p>panel</p></Tabs>);
        expect(m).toMatch(/role="tablist" aria-label="Settings"/);
        expect(m.match(/role="tab"/g)).toHaveLength(2);
        const tabId = /id="([^"]+-tab-general)"/.exec(m)![1];
        const panel = /<div role="tabpanel" id="([^"]+)" aria-labelledby="([^"]+)"/.exec(m)!;
        expect(panel[2]).toBe(tabId);
        expect(m).toMatch(new RegExp(`aria-controls="${panel[1]}"`));
    });
});

describe("ModernSelect is a shim over the one Select", () => {
    it("its event-style onChange receives { target: { value } } from the value-based Select", () => {
        const spy = vi.fn();
        const el = (ModernSelect as unknown as (p: object) => React.ReactElement<{ onChange: (v: string) => void }>)({ options: [], onChange: spy, "aria-label": "x" });
        expect(el.type).toBe(Select);
        el.props.onChange("draft");
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ target: { value: "draft" } }));
    });
});
