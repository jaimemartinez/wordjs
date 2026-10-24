/**
 * conference-manager 2.16.0 — the admin panel's pure helpers for the TEAM ROLE and the EDITABLE FORM
 * (marketplace/plugins/conference-manager/client/lib/{team,fields,lodgingView}.ts), plus the plugin's
 * translation catalogue for every string they and the edited screens name.
 *
 * Pinned: who may be added to the team and why not (only the WordJS role «Equipo de conferencia»); which
 * member is flagged; what the no-access screen says; that the «Añadir campo» templates mirror the server's
 * FIELD_TEMPLATES and grey out a field the form already has; what a deletion names as «dejará de
 * funcionar»; which price / assignment rules point at a deleted field; that the lodging hints read a gender
 * WORD (the options are editable now: «Mujer» starts with an M); and that es / en / pt carry every key.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
    FIELD_TEMPLATES, assignmentRuleFields, fieldDependents, hasGenderField, isMissingField, isNameFallbackField, isOrphanFeeRule,
    missingRuleFields, moveItem, templateField, templateStates,
} from "../../../../../../marketplace/plugins/conference-manager/client/lib/fields";
import { displayName as exportDisplayName } from "../../../../../../marketplace/plugins/conference-manager/client/lib/exports";
import { overlayZ } from "../../../../../../marketplace/plugins/conference-manager/client/lib/overlay";
import {
    NO_ACCESS_TEXT, TEAM_CAPABILITY, TEAM_ROLE, candidateBlock, memberLacksRole, noAccessReason, wordjsRoleText,
} from "../../../../../../marketplace/plugins/conference-manager/client/lib/team";
import { genderKey, genderMismatch, isNameFallbackField as lvIsNameFallbackField, personDisplayName } from "../../../../../../marketplace/plugins/conference-manager/client/lib/lodgingView";
import { translations } from "../../../../../../marketplace/plugins/conference-manager/client/lib/i18n";

const PLUGIN = path.resolve(__dirname, "../../../../../../marketplace/plugins/conference-manager");
const read = (rel: string) => fs.readFileSync(path.join(PLUGIN, rel), "utf8");

describe("team role (lib/team.ts)", () => {
    it("mirrors the manifest's declared role and capability", () => {
        const manifest = JSON.parse(read("manifest.json"));
        expect(manifest.roles.map((r: any) => r.slug)).toEqual([TEAM_ROLE]);
        expect(manifest.roles[0].capabilities).toEqual([TEAM_CAPABILITY]);
        expect(read("index.js")).toContain(`const TEAM_ROLE = '${TEAM_ROLE}';`);
        expect(read("index.js")).toContain(`const TEAM_CAPABILITY = '${TEAM_CAPABILITY}';`);
    });

    it("only the team role may be added; administrators need nothing; the server's flag wins", () => {
        expect(candidateBlock({ role: TEAM_ROLE })).toBeNull();
        expect(candidateBlock({ role: "administrator" })).toBe("admin");
        expect(candidateBlock({ role: "Administrator", team_role: false })).toBe("admin");
        for (const role of ["editor", "author", "contributor", "subscriber", "custom_role", "", null]) {
            expect(candidateBlock({ role })).toBe("not_team_role");
        }
        expect(candidateBlock({ role: "editor", team_role: true })).toBeNull();
        expect(candidateBlock({ role: TEAM_ROLE, team_role: false })).toBe("not_team_role");
        expect(candidateBlock(null)).toBe("not_team_role");
    });

    it("flags a member only when the server says the account lacks the role (unknown is not a flag)", () => {
        expect(memberLacksRole({ team_role: false })).toBe(true);
        expect(memberLacksRole({ team_role: true })).toBe(false);
        expect(memberLacksRole({ team_role: null })).toBe(false);
        expect(memberLacksRole({})).toBe(false);
        expect(memberLacksRole(null)).toBe(false);
    });

    it("the no-access screen says why", () => {
        expect(noAccessReason({ isAdmin: true }, false)).toBeNull();
        expect(noAccessReason({ isStaff: true, teamRole: true, member: true }, true)).toBeNull();
        expect(noAccessReason({ isStaff: true, teamRole: true, member: true }, false)).toBe("no_sections");
        expect(noAccessReason({ isStaff: false, teamRole: false, member: true }, false)).toBe("not_team_role");
        expect(noAccessReason({ isStaff: false, teamRole: false, member: false }, false)).toBe("not_team_role");
        expect(noAccessReason({ isStaff: false, teamRole: true, member: true }, false)).toBe("inactive");
        expect(noAccessReason({ isStaff: false, teamRole: true, member: false }, false)).toBe("not_member");
        // A backend older than 2.16.0 sends neither flag: the old sentence.
        expect(noAccessReason({ isStaff: false }, false)).toBe("not_member");
        expect(NO_ACCESS_TEXT.not_member.key).toBe("perm.noaccess");
    });

    it("names the WordJS roles (custom ones by their slug)", () => {
        expect(wordjsRoleText(TEAM_ROLE)).toEqual({ key: "staff.wprole.team", fallback: "Equipo de conferencia" });
        expect(wordjsRoleText("subscriber").key).toBe("staff.wprole.subscriber");
        expect(wordjsRoleText("tesoreria")).toEqual({ key: null, fallback: "tesoreria" });
        expect(wordjsRoleText(null)).toEqual({ key: null, fallback: "—" });
    });
});

describe("field templates (lib/fields.ts)", () => {
    it("mirror the server's FIELD_TEMPLATES (same keys, same columns)", () => {
        const src = read("index.js");
        const block = src.slice(src.indexOf("const FIELD_TEMPLATES = Object.freeze({"), src.indexOf("});", src.indexOf("const FIELD_TEMPLATES = Object.freeze({")));
        const server = [...block.matchAll(/^\s+([a-z_]+): \{ name: '([a-z_]+)'/gm)].map(m => [m[1], m[2]]);
        expect(server.length).toBe(9); // 2.32.0: + age, health
        expect(FIELD_TEMPLATES.map(t => [t.key, t.name])).toEqual(server);
        expect(server.some(([k]) => k === "location")).toBe(false);
    });

    it("grey out a template the form already covers — by column or by role", () => {
        const fields = [
            { name: "first_name", label: "Nombre", role: "first_name" },
            { name: "f_cel", label: "Celular", role: "phone" },
            { name: "f_x", label: "Talla" },
        ];
        const states = Object.fromEntries(templateStates(fields).map(s => [s.template.key, s.existing?.label ?? null]));
        expect(states).toEqual({ first_name: "Nombre", last_name: null, email: null, phone: "Celular", gender: null, family_group: null, lodging: null, age: null, health: null });
        expect(templateStates([]).every(s => !s.existing)).toBe(true);
        expect(templateField(null, FIELD_TEMPLATES[0])).toBeUndefined();
    });

    it("know whether the form collects gender", () => {
        expect(hasGenderField([{ name: "gender" }])).toBe(true);
        expect(hasGenderField([{ name: "f_sexo", label: "Sexo" }])).toBe(false);
        expect(hasGenderField([])).toBe(false);
        expect(hasGenderField(undefined)).toBe(false);
    });
});

describe("rules on a deleted field", () => {
    const fields = [{ name: "gender" }, { name: "f_edad" }];
    it("price rules: only a CONDITIONED rule on a missing field is an orphan", () => {
        expect(isOrphanFeeRule({ field_name: "f_beca", operator: "eq" }, fields)).toBe(true);
        expect(isOrphanFeeRule({ field_name: "f_beca", operator: "any" }, fields)).toBe(false);
        expect(isOrphanFeeRule({ field_name: "", operator: "eq" }, fields)).toBe(false);
        expect(isOrphanFeeRule({ field_name: "gender", operator: "neq" }, fields)).toBe(false);
    });
    it("assignment rules: the main field and every condition's field; the location is always there", () => {
        const rule = { config: "family_group", params: JSON.stringify({ when: [{ field: "f_edad", op: "lt", value: "18" }], needs: [{ field: "f_tutor", op: "filled" }] }) };
        expect(assignmentRuleFields(rule).sort()).toEqual(["f_edad", "f_tutor", "family_group"]);
        expect(missingRuleFields(rule, fields).sort()).toEqual(["f_tutor", "family_group"]);
        expect(missingRuleFields({ config: "location" }, [])).toEqual([]);
        expect(missingRuleFields({ config: "gender", params: { subject: [{ field: "gender", op: "eq", value: "F" }] } }, fields)).toEqual([]);
        expect(assignmentRuleFields({ config: "", params: "{not json" })).toEqual([]);
        expect(isMissingField("", [])).toBe(false);
    });
});

describe("what a deletion switches off (fieldDependents)", () => {
    it("names the display name, the gender hints, the groups and the duplicate check", () => {
        expect(fieldDependents({ name: "first_name", role: "first_name" }).map(d => d.key)).toEqual(["fields.dep.name"]);
        expect(fieldDependents({ name: "f_nombre", role: "last_name" }).map(d => d.key)).toEqual(["fields.dep.name"]);
        expect(fieldDependents({ name: "gender", role: "gender" }).map(d => d.key)).toEqual(["fields.dep.gender"]);
        expect(fieldDependents({ name: "family_group", is_group: 1 }).map(d => d.key)).toEqual(["fields.dep.group"]);
        expect(fieldDependents({ name: "f_doc", is_unique: 1 }).map(d => d.key)).toEqual(["fields.dep.unique"]);
        expect(fieldDependents({ name: "f_talla" })).toEqual([]);
        expect(fieldDependents({ name: "email", role: "email" })).toEqual([]);
    });

    it("names the price and assignment rules that read the field, singular and plural", () => {
        const feeRules = [
            { id: 1, label: "Varones", field_name: "gender", operator: "neq" },
            { id: 2, label: "Siempre", field_name: "gender", operator: "any" },
            { id: 3, label: "Mujeres", field_name: "gender", operator: "eq" },
            { id: 4, label: "Otro", field_name: "f_edad", operator: "gt" },
        ];
        const assignmentRules = [{ id: 7, name: "Separar por género", config: "gender" }, { id: 8, name: "Familias", config: "family_group" }];
        const deps = fieldDependents({ name: "gender", role: "gender" }, { feeRules, assignmentRules });
        expect(deps.map(d => d.key)).toEqual(["fields.dep.gender", "fields.dep.fee", "fields.dep.rules.one"]);
        expect(deps[1].vars).toEqual({ n: 2, names: "Varones, Mujeres" });
        expect(deps[2].vars).toEqual({ n: 1, names: "Separar por género" });
        expect(fieldDependents({ name: "f_edad" }, { feeRules }).map(d => [d.key, d.vars?.n])).toEqual([["fields.dep.fee.one", 1]]);
    });
});

describe("lodging gender hints read the word (lib/lodgingView.ts)", () => {
    const room = (gender: string) => ({ id: 1, gender } as any);
    it("«Mujer» is F, «Hombre» is M, unknown is no hint", () => {
        expect(genderKey("Mujer")).toBe("F");
        expect(genderKey("mujeres")).toBe("F");
        expect(genderKey("Femenino")).toBe("F");
        expect(genderKey("F")).toBe("F");
        expect(genderKey("Hombre")).toBe("M");
        expect(genderKey("Masculino")).toBe("M");
        expect(genderKey("M")).toBe("M");
        expect(genderKey("Otro")).toBe("");
        expect(genderKey(null)).toBe("");
    });
    it("a single-gender room flags only a known other gender", () => {
        expect(genderMismatch(room("M"), { id: 1, gender: "Mujer" } as any)).toBe(true);
        expect(genderMismatch(room("F"), { id: 1, gender: "Mujer" } as any)).toBe(false);
        expect(genderMismatch(room("F"), { id: 1, gender: "Hombre" } as any)).toBe(true);
        expect(genderMismatch(room("M"), { id: 1, gender: null } as any)).toBe(false);
        expect(genderMismatch(room("Mixed"), { id: 1, gender: "Mujer" } as any)).toBe(false);
    });
});

describe("a person's name never falls back to an ID document, a contact or notes — on any screen", () => {
    // The form may have no Nombre / Apellido (2.16.0). The server's meals screens, the admin lists, the
    // exports and the portal must name people the same way, and never by a unique identifier, an e-mail,
    // a phone or free text (the kitchen may not read the roster).
    const FIELDS = [
        { name: "f_doc", label: "Documento", type: "text", is_unique: 1 },
        { name: "email", label: "Email", type: "text", role: "email" },
        { name: "f_tel", label: "Teléfono", type: "tel" },
        { name: "f_notes", label: "Notas", type: "textarea" },
        { name: "f_full", label: "Nombre completo", type: "text" },
        { name: "f_city", label: "Ciudad", type: "text" },
    ];
    const person = { id: 7, f_doc: "12.345", email: "a@b.c", f_tel: "300", f_notes: "maní", f_full: "Ana Ruiz", f_city: "Cali" };

    it("the predicate (and its import-free copy in lodgingView) keep only fields fit for a name", () => {
        expect(FIELDS.map((f) => isNameFallbackField(f))).toEqual([false, false, false, false, true, true]);
        expect(FIELDS.map((f) => lvIsNameFallbackField(f))).toEqual(FIELDS.map((f) => isNameFallbackField(f)));
        expect(isNameFallbackField({ name: "first_name" })).toBe(false);
    });

    it("admin lists and exports name the person from the fit fields only", () => {
        expect(personDisplayName(person, FIELDS)).toBe("Ana Ruiz Cali");
        expect(exportDisplayName(person, FIELDS)).toBe("Ana Ruiz Cali");
        const onlyUnfit = { id: 9, f_doc: "12.345", email: "a@b.c" };
        expect(personDisplayName(onlyUnfit, FIELDS)).toBe("#9");
        expect(exportDisplayName(onlyUnfit, FIELDS)).toBe("#9");
    });

    it("the fields tagged Nombre / Apellido win wherever they sit (exports included)", () => {
        const tagged = [{ name: "f_doc", is_unique: 1 }, { name: "f_n", role: "first_name" }, { name: "f_a", role: "last_name" }];
        expect(exportDisplayName({ id: 1, f_doc: "12.345", f_n: "Ana", f_a: "Ruiz" }, tagged)).toBe("Ana Ruiz");
        expect(personDisplayName({ id: 1, f_doc: "12.345", f_n: "Ana", f_a: "Ruiz" }, tagged)).toBe("Ana Ruiz");
    });

    it("the server's rule is the same rule (index.js isNameFallbackField)", () => {
        const src = read("index.js");
        expect(src).toMatch(/const NAME_UNFIT_ROLES = new Set\(\['email', 'phone'\]\);/);
        expect(src).toMatch(/const NAME_UNFIT_TYPES = new Set\(\['textarea', 'notes', 'email', 'tel'\]\);/);
        expect(src).toMatch(/!Number\(f\.is_unique\)/);
    });
});

describe("the delete confirmation names the coordinators' rules too", () => {
    it("a location's own rule that reads the field is counted and named with its location", () => {
        const deps = fieldDependents({ name: "edad" }, {
            assignmentRules: [{ id: 1, name: "Niños con adulto", config: "", params: { subject: [{ field: "edad", op: "lt", value: "12" }] } },
                { id: 2, name: "Juntos", config: "edad", location_name: "Norte" }],
        });
        const rules = deps.find((d) => d.key === "fields.dep.rules");
        expect(rules?.vars).toEqual({ n: 2, names: "Niños con adulto, Juntos (Norte)" });
    });

    it("the page asks the server for every location's rules, not only the conference's", () => {
        expect(read("client/admin/page.tsx")).toContain("conferenceApi.getAssignmentRules(conferenceId, { all: true })");
        expect(read("client/lib/conference.ts")).toMatch(/opts\.all \? '&all=1' : ''/);
    });
});

describe("phones: every field can be edited, deleted and reordered without a mouse", () => {
    // A phone has no hover: a control shown only on `group-hover` stays at opacity 0 there (Tailwind v4
    // puts group-hover inside @media (hover: hover)) — the «Editar» / «Eliminar» of each field were
    // invisible on every phone. Controls must be visible by default and hidden only on hover-capable
    // screens (`[@media(hover:hover)]:opacity-0`); only decorative layers (pointer-events-none) may stay
    // hover-only.
    const ADMIN_FILES = fs.readdirSync(path.join(PLUGIN, "client/admin")).filter((f) => f.endsWith(".tsx"));
    const classStrings = (src: string) => Array.from(src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`)/g)).map((m) => m[1] ?? m[2]);

    it("no control of the plugin's admin screens is revealed only by hovering", () => {
        const offenders: string[] = [];
        for (const f of ADMIN_FILES) {
            for (const cls of classStrings(read(`client/admin/${f}`))) {
                const tokens = cls.split(/\s+/);
                if (tokens.includes("opacity-0") && tokens.includes("group-hover:opacity-100") && !tokens.includes("pointer-events-none")) {
                    offenders.push(`${f}: ${cls.trim().slice(0, 120)}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it("the field row's actions are visible by default, hover-revealed only where there is hover, and include ↑ / ↓", () => {
        const page = read("client/admin/page.tsx");
        const actions = classStrings(page).find((c) => /\[@media\(hover:hover\)\]:opacity-0/.test(c) && /focus-within:opacity-100/.test(c));
        expect(actions, "the field row's action container").toBeTruthy();
        const tokens = actions!.split(/\s+/);
        expect(tokens).toContain("opacity-100");
        expect(tokens).not.toContain("opacity-0");
        expect(page).toMatch(/data-field-actions=\{field\.name\}/);
        expect(page).toMatch(/onClick=\{\(\) => moveField\(idx, -1\)\}/);
        expect(page).toMatch(/onClick=\{\(\) => moveField\(idx, 1\)\}/);
    });

    it("moveItem moves one field, and leaves the list alone out of range", () => {
        const list = ["a", "b", "c"];
        expect(moveItem(list, 0, 1)).toEqual(["b", "a", "c"]);
        expect(moveItem(list, 2, 1)).toEqual(["a", "c", "b"]);
        expect(list).toEqual(["a", "b", "c"]);
        expect(moveItem(list, 0, -1)).toBe(list);
        expect(moveItem(list, 2, 3)).toBe(list);
        expect(moveItem(list, 1, 1)).toBe(list);
    });

    it("«Nuevo campo» (with its templates) opens above the admin's phone header: in the portalled Overlay", () => {
        const page = read("client/admin/page.tsx");
        const fields = page.slice(page.indexOf("function FieldsPage("), page.indexOf("function AssignmentPage("));
        expect(fields).toMatch(/showModal && \(\s*<Overlay layer=\{1\}/);
        expect(fields).not.toMatch(/fixed inset-0[^"]*z-\[100\]/);
        // The admin's phone header is z-5000 (DashboardLayoutClient); the sidebar 5002, its toggle 5003.
        expect(overlayZ(1)).toBeGreaterThan(5003);
    });
});

describe("translations (lib/i18n.ts)", () => {
    const langs = Object.keys(translations) as (keyof typeof translations)[];
    it("es / en / pt carry the same keys, none blank", () => {
        expect(langs.sort()).toEqual(["en", "es", "pt"]);
        const es = Object.keys(translations.es).sort();
        for (const l of langs) {
            expect(Object.keys(translations[l]).sort()).toEqual(es);
            expect(Object.entries(translations[l]).filter(([, v]) => !String(v).trim())).toEqual([]);
        }
    });
    it("every key the helpers and the edited screens name exists", () => {
        const keys = new Set<string>([
            ...FIELD_TEMPLATES.flatMap(t => [t.labelKey, t.hintKey]),
            ...Object.values(NO_ACCESS_TEXT).map(t => t.key),
            ...["administrator", "editor", "author", "contributor", "subscriber", TEAM_ROLE].map(r => wordjsRoleText(r).key as string),
            ...fieldDependents({ name: "gender", role: "first_name", is_group: 1, is_unique: 1 }, {
                feeRules: [{ field_name: "gender", operator: "eq" }], assignmentRules: [{ config: "gender" }],
            }).map(d => d.key),
            ...fieldDependents({ name: "x" }, {
                feeRules: [{ field_name: "x", operator: "eq" }, { field_name: "x", operator: "eq" }],
                assignmentRules: [{ config: "x" }, { config: "x" }],
            }).map(d => d.key),
        ]);
        for (const f of ["client/admin/page.tsx", "client/admin/StaffPage.tsx", "client/admin/LodgingExplorer.tsx", "client/admin/perms.tsx"]) {
            for (const m of read(f).matchAll(/\btx\(\s*'([^']+)'/g)) keys.add(m[1]);
        }
        const missing = [...keys].filter(k => !(k in translations.es));
        expect(missing).toEqual([]);
        for (const k of keys) {
            expect(translations.en[k], `en ${k}`).toBeTruthy();
            expect(translations.pt[k], `pt ${k}`).toBeTruthy();
        }
    });
});

describe("the price-rule builder (2.36.4): the value input follows the field, the old rules open as they were", () => {
    const fields = [
        { name: "first_name", label: "Nombre", type: "text" },
        { name: "gender", label: "Género", type: "select", options: "M, F" },
        { name: "age", label: "Edad", type: "number" },
        { name: "f_llegada", label: "Llegada", type: "date" },
        { name: "f_beca", label: "Becado", type: "switch" },
        { name: "notes", label: "Notas", type: "notes" },
    ];
    it("each field gets its kind of input and its conditions", async () => {
        const L = await import("../../../../../../marketplace/plugins/conference-manager/client/lib/feeRules");
        expect(["", "__person", "location", "gender", "first_name", "age", "f_llegada", "f_beca", "notes"].map((f) => L.kindOf(f, fields)))
            .toEqual(["always", "person", "enum", "enum", "enum", "number", "date", "switch", "text"]);
        expect(L.OPS_BY_KIND.person).toEqual(["in", "not_in"]);
        expect(L.OPS_BY_KIND.number.slice(0, 3)).toEqual(["between", "gte", "lte"]);
        expect(L.OPS_BY_KIND.date.slice(0, 3)).toEqual(["between", "after", "before"]);
        expect(L.OPS_BY_KIND.switch).toEqual(["eq"]);
        // A rule keeps its own condition in the list even when its kind would not offer it.
        expect(L.opsFor("number", "neq")).toContain("neq");
        expect(L.draftForField("f_beca", fields)).toMatchObject({ kind: "switch", op: "eq", value: "Sí" });
    });
    it("drafts round-trip to what the server stores: lists and ranges as arrays, the rest as text", async () => {
        const L = await import("../../../../../../marketplace/plugins/conference-manager/client/lib/feeRules");
        expect(L.fromDraft({ ...L.draftForField("location", fields), list: ["Norte", "Sur"] })).toEqual({ field_name: "location", operator: "in", value: ["Norte", "Sur"] });
        expect(L.fromDraft({ ...L.draftForField("age", fields), range: ["18", ""] })).toEqual({ field_name: "age", operator: "between", value: ["18", ""] });
        expect(L.fromDraft({ ...L.draftForField("f_llegada", fields), op: "after", value: "2030-01-10" })).toEqual({ field_name: "f_llegada", operator: "after", value: "2030-01-10" });
        expect(L.fromDraft(L.draftForField("", fields))).toEqual({ field_name: "", operator: "any", value: "" });
        // A saved list / range opens back as one.
        expect(L.toDraft({ field_name: "location", operator: "in", value: '["Norte","Sur"]' }, fields)).toMatchObject({ op: "in", list: ["Norte", "Sur"] });
        expect(L.toDraft({ field_name: "age", operator: "between", value: '["","17"]' }, fields)).toMatchObject({ op: "between", range: ["", "17"] });
        expect(L.draftReady({ ...L.draftForField("location", fields) })).toBe(false);
        expect(L.draftReady({ ...L.draftForField("age", fields), range: ["", "17"] })).toBe(true);
    });
    it("rules saved before 2.36.4 open with the same meaning: «es igual a X» on a list field is «es uno de [X]»", async () => {
        const L = await import("../../../../../../marketplace/plugins/conference-manager/client/lib/feeRules");
        expect(L.toDraft({ field_name: "gender", operator: "eq", value: "F" }, fields)).toMatchObject({ kind: "enum", op: "in", list: ["F"] });
        expect(L.toDraft({ field_name: "location", operator: "neq", value: "Norte" }, fields)).toMatchObject({ op: "not_in", list: ["Norte"] });
        expect(L.toDraft({ field_name: "gender", operator: "contains", value: "x" }, fields)).toMatchObject({ op: "contains", value: "x" });
        expect(L.toDraft({ field_name: "age", operator: "gte", value: "18" }, fields)).toMatchObject({ kind: "number", op: "gte", value: "18" });
        expect(L.toDraft({ field_name: "notes", operator: "filled", value: "" }, fields)).toMatchObject({ kind: "text", op: "filled" });
        expect(L.toDraft({ field_name: "", operator: "any" }, fields)).toMatchObject({ kind: "always", op: "any" });
        // «Personas» and the locality are never flagged as a deleted field.
        expect(isOrphanFeeRule({ field_name: "__person", operator: "in" }, fields)).toBe(false);
    });
    it("the rule list says the condition in words", async () => {
        const L = await import("../../../../../../marketplace/plugins/conference-manager/client/lib/feeRules");
        const tx = (k: string, f: string, v: Record<string, any> = {}) => Object.entries(v).reduce((s, [a, b]) => s.split(`{${a}}`).join(String(b)), translations.es[k] || f);
        const label = (n: string) => fields.find((f) => f.name === n)?.label || (n === "location" ? "Localidad" : n);
        expect(L.describeCondition({ field_name: "location", operator: "in", value: '["Norte","Sur"]' }, label, tx)).toBe("Localidad es: Norte, Sur");
        expect(L.describeCondition({ field_name: "age", operator: "between", value: '["18","65"]' }, label, tx)).toBe("Edad entre 18 y 65");
        expect(L.describeCondition({ field_name: "age", operator: "between", value: '["","17"]' }, label, tx)).toBe("Edad hasta 17");
        expect(L.describeCondition({ field_name: "__person", operator: "in", value: '["1","2","3","4","5","6"]' }, label, tx, (id) => `P${id}`)).toBe("Para: P1, P2, P3, P4 y 2 más");
        expect(L.describeCondition({ field_name: "__person", operator: "not_in", value: '["1"]' }, label, tx, (id) => `P${id}`)).toBe("Todos menos: P1");
        expect(L.describeCondition({ field_name: "gender", operator: "eq", value: "F" }, label, tx)).toBe("Género es igual a F");
        expect(L.describeCondition({ field_name: "", operator: "any" }, label, tx)).toBe("Siempre");
    });
    it("people are searched by name, document or locality, accents aside, and filtered by locality", async () => {
        const L = await import("../../../../../../marketplace/plugins/conference-manager/client/lib/feeRules");
        const people = [{ id: 1, name: "Ana Pérez", document: "1001", location: "Norte" }, { id: 2, name: "Beto Gómez", document: "2002", location: "Sur" }];
        expect(L.searchPeople(people, "perez").map((p) => p.id)).toEqual([1]);
        expect(L.searchPeople(people, "2002").map((p) => p.id)).toEqual([2]);
        expect(L.searchPeople(people, "", "Sur").map((p) => p.id)).toEqual([2]);
        expect(L.toggleIn(["a"], "b", true)).toEqual(["a", "b"]);
        expect(L.toggleIn(["a", "b"], "a", false)).toEqual(["b"]);
    });
    it("the builder: the pickers, the live preview, the styled Select, the calendar, no native dialog; every string in three languages", () => {
        const b = read("client/admin/FeeRuleBuilder.tsx");
        expect(b).toContain("conferenceApi.feeRuleValues(conferenceId, f)");
        expect(b).toContain("conferenceApi.previewFeeRule(");
        expect(b).toContain("<DateField ");
        expect(b).toContain("<Select ");
        expect(b).not.toMatch(/<select\b/);
        expect(b).not.toMatch(/\b(alert|confirm|prompt)\s*\(/);
        expect(b).not.toMatch(/\brequired\b/);
        const page = read("client/admin/page.tsx");
        expect(page).toContain("<FeeRuleBuilder conferenceId={conferenceId} fields={fields} draft={draft}");
        expect(page).toContain("...fromDraft(draft)");
        expect(page).toContain("if (body.field === 'value') setDraftErr(");
        const used = new Set([...b.matchAll(/tx\('(fee\.[a-z_.]+)'/g)].map((m) => m[1]));
        for (const op of ["any", "eq", "neq", "contains", "gt", "gte", "lt", "lte", "filled", "empty", "in", "not_in", "between", "before", "after"]) used.add(`fee.op.${op}`);
        for (const k of used) for (const l of ["es", "en", "pt"] as const) expect((translations as any)[l][k], `${l} ${k}`).toBeTruthy();
    });
});
