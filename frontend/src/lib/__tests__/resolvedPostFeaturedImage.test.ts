/**
 * La miniatura de los bloques dinámicos (PostsGrid / CategoryPosts / PostsList).
 *
 * El mapper leía `raw.featuredImage`, una clave que la API NUNCA emite: backend Post.toJSON
 * serializa la imagen destacada como `featuredMedia: {id, url, title}`. Resultado: ni un solo post
 * con imagen destacada llegaba con miniatura, ni en el lienzo del editor ni en la página pública
 * (mismo mapper para los dos, que es justamente el motivo de que este módulo exista).
 */
import { describe, it, expect } from "vitest";
import type { Post } from "@/lib/api";
import { featuredImageUrl, toResolved } from "../resolvedPost";

const base = { id: 1, title: "T", slug: "t", excerpt: "E" } as unknown as Post;

describe("featuredImageUrl — la clave que la API manda de verdad", () => {
    it("lee featuredMedia.url", () => {
        expect(featuredImageUrl({ featuredMedia: { id: 3, url: "/uploads/a.jpg", title: "A" } })).toBe("/uploads/a.jpg");
    });

    it("sigue tolerando la clave vieja `featuredImage`, como string o como objeto", () => {
        expect(featuredImageUrl({ featuredImage: "/uploads/legacy.jpg" })).toBe("/uploads/legacy.jpg");
        expect(featuredImageUrl({ featuredImage: { url: "/uploads/legacy2.jpg" } })).toBe("/uploads/legacy2.jpg");
    });

    it("featuredMedia gana cuando vienen las dos", () => {
        expect(
            featuredImageUrl({ featuredMedia: { url: "/uploads/nueva.jpg" }, featuredImage: "/uploads/vieja.jpg" }),
        ).toBe("/uploads/nueva.jpg");
    });

    it("sin imagen (o con formas vacías/rotas) devuelve undefined, nunca una cadena vacía", () => {
        expect(featuredImageUrl({})).toBeUndefined();
        expect(featuredImageUrl({ featuredMedia: null })).toBeUndefined();
        expect(featuredImageUrl({ featuredMedia: { id: 3 } })).toBeUndefined();
        expect(featuredImageUrl({ featuredImage: "   " })).toBeUndefined();
    });
});

describe("toResolved — el post mapeado que consumen los bloques", () => {
    it("rellena `image` desde featuredMedia (antes salía siempre undefined)", () => {
        const p = { ...base, featuredMedia: { id: 3, url: "/uploads/a.jpg", title: "A" } } as unknown as Post;
        expect(toResolved(p).image).toBe("/uploads/a.jpg");
    });

    it("un post sin imagen destacada sigue sin `image`", () => {
        expect(toResolved(base).image).toBeUndefined();
    });
});
