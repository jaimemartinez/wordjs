/**
 * El filtro por categoría de los bloques dinámicos (CategoryPosts, y el mismo camino en el lienzo).
 *
 * Era código muerto: `filterByCategory` mira `p.categories`, y el backend NO serializaba los términos
 * de un post, así que la clave nunca llegaba y un CategoryPosts con categoría elegida devolvía lista
 * vacía en la página pública y en la vista previa del editor. Con `Post.toJSON` emitiendo
 * `categories: [{id,name,slug}]` el filtro revive, y esto lo fija contra la FORMA REAL que manda la
 * API — no contra una inventada.
 */
import { describe, it, expect } from "vitest";
import type { Post } from "@/lib/api";
import { filterByCategory } from "../resolvedPost";

const post = (id: number, categories?: Array<{ id: number; name: string; slug: string }>): Post =>
    ({ id, title: `P${id}`, slug: `p${id}`, excerpt: "", categories } as unknown as Post);

const NOTICIAS = { id: 3, name: "Noticias", slug: "noticias" };
const GUIAS = { id: 7, name: "Guías", slug: "guias" };

describe("filterByCategory — con la forma que la API manda de verdad", () => {
    it("se queda con los posts de esa categoría", () => {
        const all = [post(1, [NOTICIAS]), post(2, [GUIAS]), post(3, [GUIAS, NOTICIAS])];
        expect(filterByCategory(all, "noticias").map((p) => p.id)).toEqual([1, 3]);
    });

    it("ignora mayúsculas y espacios sobrantes del slug pedido", () => {
        expect(filterByCategory([post(1, [NOTICIAS])], "  NOTICIAS ").map((p) => p.id)).toEqual([1]);
    });

    it("sin slug pedido devuelve TODO (el bloque sin categoría lista el sitio entero)", () => {
        const all = [post(1, [NOTICIAS]), post(2)];
        expect(filterByCategory(all, "")).toBe(all);
        expect(filterByCategory(all, undefined)).toBe(all);
    });

    it("un post sin la clave `categories` no casa con nada — y no revienta", () => {
        expect(filterByCategory([post(1), post(2, [])], "noticias")).toEqual([]);
    });

    it("tolera un caller que sintetiza categorías sin slug, casando por nombre", () => {
        const all = [post(1, [{ id: 9, name: "noticias", slug: "" }])];
        expect(filterByCategory(all, "noticias").map((p) => p.id)).toEqual([1]);
    });
});
