import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * DOBLE-DESESCAPADO en el bloque RelatedPosts (CodeQL js/double-escaping).
 *
 * `cleanText()` limpia el extracto que devuelve la API antes de pintarlo en la tarjeta. Cuando el
 * desescapado se hacía como una CADENA de `.replace()` con `&amp;` -> `&` en primer lugar, la propia
 * salida de esa sustitución volvía a leerse: `&amp;lt;` pasaba a `&lt;` y de ahí a `<`. Es decir, un
 * texto que sólo CITABA una entidad acababa convertido en el carácter que nombra.
 *
 * El test evalúa la función REAL extraída del fichero del plugin — no una copia reescrita aquí —
 * porque una copia se queda congelada y dejaría de vigilar el código que se envía. Si el fichero o
 * las declaraciones se renombran, la extracción lanza: es un fallo ruidoso, nunca un aprobado falso.
 */

const REPO = path.resolve(__dirname, '../../../..');
const BLOCK = path.join(REPO, 'marketplace/plugins/related-posts/client/verso/RelatedPostsVerso.tsx');

const SRC = fs.readFileSync(BLOCK, 'utf8');

/**
 * Recorta una declaración de nivel superior contando llaves desde su cabecera. `optional` existe para
 * que la tabla auxiliar no sea parte del contrato: lo que este test vigila es el COMPORTAMIENTO de
 * cleanText, así que una implementación sin tabla debe llegar igualmente a las aserciones y caer allí,
 * no morir antes en la extracción.
 */
function sliceDeclaration(header: string, optional = false): string {
    const start = SRC.indexOf(header);
    if (start < 0) {
        if (optional) return '';
        throw new Error(`No encuentro "${header}" en ${BLOCK} — ¿se renombró? Actualiza este test.`);
    }
    const from = SRC.indexOf('{', start);
    if (from < 0) throw new Error(`"${header}" no abre llave en ${BLOCK}.`);
    let depth = 0;
    for (let i = from; i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}') {
            depth--;
            if (depth === 0) return SRC.slice(start, i + 1);
        }
    }
    throw new Error(`"${header}" no cierra en ${BLOCK}.`);
}

const entities = sliceDeclaration('const ENTITIES =', true);
const cleanText = new Function(
    `${entities ? entities + ';\n' : ''}${sliceDeclaration('function cleanText(')}\nreturn cleanText;`,
)() as (s: unknown) => string;

describe('RelatedPosts cleanText — desescapado de entidades', () => {
    it('NO desescapa dos veces: una entidad citada sigue citada', () => {
        // Hoy fallaba: "&amp;lt;" -> "&lt;" -> "<".
        expect(cleanText('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
        expect(cleanText('&amp;quot;hola&amp;quot;')).toBe('&quot;hola&quot;');
        expect(cleanText('&amp;amp;')).toBe('&amp;');
        expect(cleanText('&amp;nbsp;')).toBe('&nbsp;');
        expect(cleanText('&amp;#39;')).toBe('&#39;');
    });

    it('desescapa UNA vez cada entidad que soporta', () => {
        expect(cleanText('Tom &amp; Jerry')).toBe('Tom & Jerry');
        expect(cleanText('&lt;b&gt;')).toBe('<b>');
        expect(cleanText('dijo &quot;sí&quot;')).toBe('dijo "sí"');
        expect(cleanText('l&#39;été')).toBe("l'été");
        expect(cleanText('a&nbsp;b')).toBe('a b');
    });

    it('quita etiquetas y normaliza el espacio en blanco', () => {
        expect(cleanText('<p>Hola   <b>mundo</b></p>')).toBe('Hola mundo');
        expect(cleanText('  \n texto \t ')).toBe('texto');
    });

    it('trata null/undefined como cadena vacía', () => {
        expect(cleanText(null)).toBe('');
        expect(cleanText(undefined)).toBe('');
    });

    it('las entidades desconocidas se dejan intactas (no inventa caracteres)', () => {
        expect(cleanText('&copy; 2026')).toBe('&copy; 2026');
        expect(cleanText('AT&T')).toBe('AT&T');
    });
});
