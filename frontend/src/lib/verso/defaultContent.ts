/**
 * Starter content of a freshly inserted block, in the admin's language.
 *
 * The core block definitions (coreBlocks.tsx / versoConfig.tsx) keep ONE source copy of their
 * `defaultProps` — mixed Spanish and English, compared byte for byte by the anti-drift tests. A new
 * block used to start with that literal text whatever the admin language was ("Un titular que
 * atrapa", "Empezar" in an English admin). `localizedDefaults` clones the defaults and replaces every
 * string that is EXACTLY one of the starter texts below with its version in `lang`.
 *
 * Only insertion uses it: blocks already on a page keep their text (it is content now), and the
 * editor-chrome dictionary (editorI18n.ts) stays separate — a field label and a starter text that
 * happen to share a word must not translate each other.
 */

import type { Language } from "@/lib/i18n";
import type { Tri } from "@/lib/editorI18n";

const STARTER_CONTENT: Tri[] = [
    // Heading / Text
    { es: "Título", en: "Heading", pt: "Título" },
    { es: "Escribe aquí...", en: "Write here...", pt: "Escreva aqui..." },
    // Card
    { es: "Título de la tarjeta", en: "Card Title", pt: "Título do cartão" },
    {
        es: "Esta es la descripción de una tarjeta. Úsala para destacar funciones o servicios.",
        en: "This is a card description. You can use it to highlight features or services.",
        pt: "Esta é a descrição de um cartão. Use-a para destacar recursos ou serviços.",
    },
    // Button
    { es: "Haz clic", en: "Click Me", pt: "Clique aqui" },
    // Accordion / Tabs
    { es: "Sección 1", en: "Section 1", pt: "Seção 1" },
    { es: "Contenido de la sección 1", en: "Content for section 1", pt: "Conteúdo da seção 1" },
    { es: "Sección 2", en: "Section 2", pt: "Seção 2" },
    { es: "Contenido de la sección 2", en: "Content for section 2", pt: "Conteúdo da seção 2" },
    { es: "Pestaña 1", en: "Tab 1", pt: "Aba 1" },
    { es: "Contenido de la pestaña 1", en: "Content for Tab 1", pt: "Conteúdo da aba 1" },
    { es: "Pestaña 2", en: "Tab 2", pt: "Aba 2" },
    { es: "Contenido de la pestaña 2", en: "Content for Tab 2", pt: "Conteúdo da aba 2" },
    { es: "Pestaña 3", en: "Tab 3", pt: "Aba 3" },
    { es: "Contenido de la pestaña 3", en: "Content for Tab 3", pt: "Conteúdo da aba 3" },
    // Audio
    { es: "Pista de audio", en: "Audio Track", pt: "Faixa de áudio" },
    // Pricing table
    { es: "Básico", en: "Basic", pt: "Básico" },
    { es: "Función 1\nFunción 2\nFunción 3", en: "Feature 1\nFeature 2\nFeature 3", pt: "Recurso 1\nRecurso 2\nRecurso 3" },
    { es: "Empezar", en: "Get Started", pt: "Começar" },
    {
        es: "Todo lo de Básico\nFunción 4\nFunción 5\nSoporte prioritario",
        en: "Everything in Basic\nFeature 4\nFeature 5\nPriority Support",
        pt: "Tudo do Básico\nRecurso 4\nRecurso 5\nSuporte prioritário",
    },
    { es: "Empresa", en: "Enterprise", pt: "Empresarial" },
    {
        es: "Todo lo de Pro\nFunciones a medida\nSoporte dedicado\nSLA",
        en: "Everything in Pro\nCustom Features\nDedicated Support\nSLA",
        pt: "Tudo do Pro\nRecursos sob medida\nSuporte dedicado\nSLA",
    },
    { es: "Contáctanos", en: "Contact Us", pt: "Fale conosco" },
    // Testimonial
    {
        es: "Este producto ha cambiado por completo nuestra forma de trabajar. No me imagino volver a lo de antes.",
        en: "This product has completely transformed how we work. I can't imagine going back to the old way.",
        pt: "Este produto transformou completamente a forma como trabalhamos. Não consigo imaginar voltar ao jeito antigo.",
    },
    { es: "Directora general, Acme Inc.", en: "CEO, Acme Inc.", pt: "CEO, Acme Inc." },
    // CTA banner
    { es: "¿Listo para empezar?", en: "Ready to get started?", pt: "Pronto para começar?" },
    { es: "Únete hoy a miles de clientes satisfechos.", en: "Join thousands of satisfied customers today.", pt: "Junte-se hoje a milhares de clientes satisfeitos." },
    { es: "Empieza gratis", en: "Get Started Free", pt: "Comece grátis" },
    // Search bar
    { es: "Buscar...", en: "Search...", pt: "Pesquisar..." },
    { es: "Buscar", en: "Search", pt: "Pesquisar" },
    // Hero
    { es: "Un titular que atrapa", en: "A headline that grabs attention", pt: "Um título que prende a atenção" },
    {
        es: "Explica en una frase el valor de tu sitio. Cambia la imagen, la altura y la capa oscura desde el panel.",
        en: "Explain your site's value in one sentence. Change the image, the height and the dark overlay from the panel.",
        pt: "Explique em uma frase o valor do seu site. Mude a imagem, a altura e a camada escura no painel.",
    },
    // Quote
    {
        es: "El mejor momento para plantar un árbol fue hace veinte años. El segundo mejor momento es ahora.",
        en: "The best time to plant a tree was twenty years ago. The second best time is now.",
        pt: "O melhor momento para plantar uma árvore foi há vinte anos. O segundo melhor momento é agora.",
    },
    { es: "Proverbio", en: "Proverb", pt: "Provérbio" },
    // Table
    { es: "Plan | Precio | Soporte", en: "Plan | Price | Support", pt: "Plano | Preço | Suporte" },
    { es: "Básico | 9 € | Email", en: "Basic | €9 | Email", pt: "Básico | 9 € | E-mail" },
    { es: "Pro | 29 € | Prioritario", en: "Pro | €29 | Priority", pt: "Pro | 29 € | Prioritário" },
    // Features / stats
    { es: "Rápido", en: "Fast", pt: "Rápido" },
    { es: "Describe una ventaja clave en una frase.", en: "Describe a key benefit in one sentence.", pt: "Descreva uma vantagem-chave em uma frase." },
    { es: "Seguro", en: "Secure", pt: "Seguro" },
    { es: "Cuidado", en: "Polished", pt: "Caprichado" },
    { es: "Clientes", en: "Customers", pt: "Clientes" },
    { es: "Satisfacción", en: "Satisfaction", pt: "Satisfação" },
    { es: "Soporte", en: "Support", pt: "Suporte" },
    // HTML embed
    {
        es: "<p>Pega aquí tu HTML. Se limpia automáticamente (sin scripts).</p>",
        en: "<p>Paste your HTML here. It is sanitized automatically (no scripts).</p>",
        pt: "<p>Cole seu HTML aqui. Ele é higienizado automaticamente (sem scripts).</p>",
    },
    // Navigation blocks
    { es: "Arriba", en: "Top", pt: "Topo" },
    { es: "Menú", en: "Menu", pt: "Menu" },
    { es: "Inicio", en: "Home", pt: "Início" },
    { es: "En esta página", en: "On this page", pt: "Nesta página" },
    // Form
    { es: "Contacto", en: "Contact", pt: "Contato" },
    { es: "Nombre", en: "Name", pt: "Nome" },
    { es: "Tu nombre", en: "Your name", pt: "Seu nome" },
    { es: "tu@email.com", en: "you@email.com", pt: "voce@email.com" },
    { es: "Mensaje", en: "Message", pt: "Mensagem" },
    { es: "¿En qué podemos ayudarte?", en: "How can we help you?", pt: "Como podemos ajudar?" },
    { es: "Enviar", en: "Send", pt: "Enviar" },
    { es: "¡Gracias! Hemos recibido tu mensaje.", en: "Thank you! We have received your message.", pt: "Obrigado! Recebemos sua mensagem." },
    {
        es: "No se pudo enviar el formulario. Inténtalo de nuevo.",
        en: "The form could not be sent. Please try again.",
        pt: "Não foi possível enviar o formulário. Tente novamente.",
    },
    // Built-in patterns (lib/blockPatterns.ts)
    { es: "Un título que engancha", en: "A heading that hooks", pt: "Um título que engaja" },
    {
        es: "Acompaña tu título con una frase breve que explique el valor de lo que ofreces a tus visitantes.",
        en: "Follow your heading with a short sentence that explains the value of what you offer your visitors.",
        pt: "Acompanhe seu título com uma frase curta que explique o valor do que você oferece aos visitantes.",
    },
    { es: "Saber más", en: "Learn more", pt: "Saiba mais" },
    { es: "Por qué elegirnos", en: "Why choose us", pt: "Por que nos escolher" },
    { es: "Lo que ofrecemos", en: "What we offer", pt: "O que oferecemos" },
    { es: "Servicio uno", en: "Service one", pt: "Serviço um" },
    { es: "Servicio dos", en: "Service two", pt: "Serviço dois" },
    { es: "Servicio tres", en: "Service three", pt: "Serviço três" },
    {
        es: "Describe brevemente este servicio o característica destacada.",
        en: "Briefly describe this service or standout feature.",
        pt: "Descreva brevemente este serviço ou recurso de destaque.",
    },
    { es: "En números", en: "By the numbers", pt: "Em números" },
    { es: "Planes y precios", en: "Plans and pricing", pt: "Planos e preços" },
    { es: "Elige el plan que mejor se adapta a ti.", en: "Choose the plan that suits you best.", pt: "Escolha o plano que melhor se adapta a você." },
    { es: "Lo que dicen de nosotros", en: "What people say about us", pt: "O que dizem sobre nós" },
    { es: "Preguntas frecuentes", en: "Frequently asked questions", pt: "Perguntas frequentes" },
];

let LOOKUP: Map<string, Tri> | null = null;
function lookup(): Map<string, Tri> {
    if (LOOKUP) return LOOKUP;
    const map = new Map<string, Tri>();
    for (const t of STARTER_CONTENT) for (const v of [t.es, t.en, t.pt]) if (!map.has(v)) map.set(v, t);
    LOOKUP = map;
    return map;
}

/** The starter text `s` in `lang`, or `s` unchanged when it is not a known starter text. */
export function starterText(s: string, lang: Language): string {
    const hit = lookup().get(s);
    return hit ? hit[lang] || s : s;
}

/** Every starter entry that contains `s` in any language (tests: coverage of the core defaults). */
export function starterTextMatches(s: string): Tri[] {
    return STARTER_CONTENT.filter((t) => t.es === s || t.en === s || t.pt === s);
}

function localize(value: unknown, lang: Language): unknown {
    if (typeof value === "string") return starterText(value, lang);
    if (Array.isArray(value)) return value.map((v) => localize(v, lang));
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = k === "id" ? v : localize(v, lang);
        return out;
    }
    return value;
}

/**
 * A fresh copy of a block's `defaultProps` with its starter texts in `lang`. Structure, ids and
 * every non-text value are kept; anything that is not a plain object/array/string is shared.
 */
export function localizedDefaults(defaultProps: Record<string, unknown> | undefined, lang: Language): Record<string, unknown> {
    return localize(defaultProps ?? {}, lang) as Record<string, unknown>;
}
