/**
 * The shared responsive table (components/ui/DataTable.tsx) every core admin list renders through.
 *
 * What it promises, checked on the rendered markup (node environment, no jsdom — the project convention):
 *   · one semantic table whose elements keep their ARIA roles, because the phone layout turns them into
 *     blocks and a browser then drops the implicit table semantics;
 *   · a card layout below its breakpoint: the primary column as the title, every other column with a
 *     visible label, the header row only visually hidden;
 *   · row actions that are never hover-only on a touch screen, carry an accessible name, and are 44px;
 *   · `menu: true` actions as buttons in the card and behind "More actions" in the table;
 *   · priority columns that wait for room in the table layout only.
 * And that no core admin screen still draws its own <table>.
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DataTable, Pagination } from "@/components/ui";

vi.mock("@/contexts/I18nContext", () => ({ useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: () => undefined }) }));
import type { DataTableColumn } from "@/components/ui";

type Row = { id: number; name: string; email: string };
const rows: Row[] = [{ id: 1, name: "Ada", email: "ada@example.test" }, { id: 2, name: "Linus", email: "linus@example.test" }];
const columns: DataTableColumn<Row>[] = [
    { key: "name", header: "Name", primary: true, cell: (r) => r.name },
    { key: "email", header: "Email", showFrom: "lg", cell: (r) => r.email },
];

const render = (extra: Partial<React.ComponentProps<typeof DataTable<Row, number>>> = {}) => renderToStaticMarkup(
    <DataTable<Row, number>
        rows={rows}
        rowKey={(r) => r.id}
        columns={columns}
        caption="People"
        rowLabel={(r) => r.name}
        actions={(r) => [
            { key: "edit", label: "Edit", icon: "fa-pen", href: `/admin/users/${r.id}` },
            { key: "delete", label: "Delete", icon: "fa-trash", onClick: () => undefined, tone: "danger", menu: true },
        ]}
        {...extra}
    />,
);

const classOf = (html: string, marker: RegExp) => (marker.exec(html)?.[1] ?? "").split(/\s+/);

describe("DataTable", () => {
    it("keeps explicit table roles and a caption, so the card layout still reads as a table", () => {
        const html = render();
        expect(html).toMatch(/<table role="table"/);
        expect(html).toContain('<caption class="sr-only">People</caption>');
        expect(html).toMatch(/<thead role="rowgroup"/);
        expect((html.match(/role="columnheader"/g) || []).length).toBe(3); // name, email, actions
        expect((html.match(/<tr role="row"/g) || []).length).toBe(3);
        expect((html.match(/<td role="cell"/g) || []).length).toBe(6);
    });

    it("stacks below md by default: headers visually hidden (not removed), every non-primary cell labelled", () => {
        const html = render();
        expect(classOf(html, /<thead role="rowgroup" class="([^"]*)"/)).toContain("max-md:sr-only");
        expect(classOf(html, /<table role="table" class="([^"]*)"/)).toContain("max-md:block");
        // The email cell carries its column label for the card; the primary (title) cell does not.
        expect(html).toMatch(/<span aria-hidden="true" class="[^"]*md:hidden[^"]*">Email<\/span>/);
        expect(html).not.toMatch(/<span aria-hidden="true"[^>]*>Name<\/span>/);
    });

    it("stacks below lg on request", () => {
        const html = render({ stackBelow: "lg" });
        expect(classOf(html, /<thead role="rowgroup" class="([^"]*)"/)).toContain("max-lg:sr-only");
        expect(html).not.toContain("max-md:sr-only");
    });

    it("lets a priority column wait for room in the table layout only", () => {
        const emailCell = /<td role="cell" class="([^"]*)"><span aria-hidden="true"[^>]*>Email/.exec(render())?.[1] ?? "";
        expect(emailCell.split(/\s+/)).toContain("md:max-lg:hidden");
        expect(emailCell).not.toMatch(/(^|\s)hidden(\s|$)/);
    });

    it("names every row action, makes it 44px, and never hides it on a screen that cannot hover", () => {
        const html = render();
        expect(html).toMatch(/<a(?=[^>]*href="\/admin\/users\/1")(?=[^>]*title="Edit")[^>]*>/);
        expect(html).toMatch(/class="[^"]*\bh-11\b[^"]*\bmin-w-11\b/);
        const group = classOf(html, /<div role="group" aria-label="Actions: Ada" class="([^"]*)"/);
        expect(group).toContain("opacity-100");
        expect(group).toContain("md:[@media(hover:hover)]:opacity-0");
        expect(group).toContain("group-focus-within:opacity-100");
    });

    it("puts `menu` actions behind More actions in the table, as buttons in the card", () => {
        const html = render();
        expect(html).toMatch(/<button type="button" class="md:hidden [^"]*"[^>]*title="Delete"/);
        expect(html).toMatch(/<span class="max-md:hidden"><button[^>]*aria-label="More actions: Ada"[^>]*aria-haspopup="menu"/);
    });

    it("names the row checkboxes after the row", () => {
        const html = render({
            selection: { selected: new Set([2]), onToggle: () => undefined, onToggleAll: () => undefined, allLabel: "Select all" },
            selectRowLabel: "Select {title}",
        });
        expect(html).toContain('aria-label="Select all"');
        expect(html).toContain('aria-label="Select Ada"');
        expect(html).toMatch(/aria-label="Select Linus"/);
    });
});

describe("Pagination", () => {
    it("is absent for a single page, unless it carries a range label", () => {
        expect(renderToStaticMarkup(<Pagination page={1} totalPages={1} onChange={() => undefined} />)).toBe("");
        expect(renderToStaticMarkup(<Pagination page={1} totalPages={1} onChange={() => undefined} label="1–3 of 3" />)).toContain("1–3 of 3");
    });

    it("works without a page count (hasNext) and keeps 44px, named buttons", () => {
        const html = renderToStaticMarkup(<Pagination page={2} hasNext onChange={() => undefined} />);
        expect(html).toMatch(/<nav aria-label="[^"]+"/);
        expect((html.match(/\bh-11\b/g) || []).length).toBe(2);
        expect((html.match(/<button[^>]*aria-label="[^"]+"/g) || []).length).toBe(2);
    });
});

describe("core admin lists", () => {
    const SRC = path.resolve(__dirname, "../..");
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? (e.name === "__tests__" || e.name === "plugin" ? [] : walk(path.join(dir, e.name)))
            : e.name.endsWith(".tsx") ? [path.join(dir, e.name)] : []);

    it("draw no table of their own: every core list goes through DataTable", () => {
        const own = [...walk(path.join(SRC, "app/admin")), path.join(SRC, "components/ContentTable.tsx")]
            .filter((f) => /<table\b/.test(fs.readFileSync(f, "utf8")))
            .map((f) => path.relative(SRC, f).replace(/\\/g, "/"));
        expect(own).toEqual([]);
    });
});
