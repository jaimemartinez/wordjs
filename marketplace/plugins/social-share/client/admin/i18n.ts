// @ts-nocheck
"use client";

// The Social Share admin screen follows the admin's language (the host I18nProvider: 'es' | 'en' | 'pt').
// Strings live here, in one table per language; a key missing in a language falls back to English and
// then to the key itself, so a new string can never render as `undefined`.
import { useOptionalI18n } from "@/contexts/I18nContext";

const es = {
    // header
    'app.title': 'Compartir Social',
    'app.subtitle': 'Botones para compartir la página actual en redes sociales',
    // how to use
    'usage.title': 'Cómo usar',
    'usage.intro1': 'Agrega el bloque ',
    'usage.intro2': ' en el editor visual de cualquier página o entrada. Los botones comparten la URL y el título de la página donde se muestran — no necesitan configuración, claves ni llamadas al servidor.',
    'usage.step1': 'Abre el editor visual de la página o entrada donde quieras los botones.',
    'usage.step2a': 'Arrastra el bloque ',
    'usage.step2b': ' (categoría "Social") al contenido.',
    'usage.step3': 'Elige qué redes mostrar y ajusta el título, el tamaño (pequeño / mediano / grande), la forma (círculo / redondeado / cuadrado), las etiquetas y la alineación.',
    'usage.note': '"Copiar enlace" usa el portapapeles del navegador y confirma con "¡Copiado!" durante 2 segundos. "Email" abre el cliente de correo del visitante.',
    // networks
    'networks.title': 'Redes soportadas',
    'net.facebook.desc': 'Abre el diálogo para compartir de Facebook',
    'net.x.desc': 'Publica un post con el enlace y el título',
    'net.whatsapp.desc': 'Comparte por chat (wa.me)',
    'net.linkedin.desc': 'Comparte en tu red profesional',
    'net.telegram.desc': 'Comparte por Telegram (t.me)',
    'net.email.name': 'Email',
    'net.email.desc': 'Abre tu cliente de correo (mailto)',
    'net.copyLink.name': 'Copiar enlace',
    'net.copyLink.desc': 'Copia la URL al portapapeles',
    // preview
    'preview.title': 'Vista previa',
    'preview.help': 'Muestra estática de los tres tamaños y las tres formas — los botones reales se agregan con el bloque en el editor visual.',
    'preview.shapes': 'Formas',
    'size.small': 'Pequeño',
    'size.medium': 'Mediano',
    'size.large': 'Grande',
    'shape.circle': 'Círculo',
    'shape.rounded': 'Redondeado',
    'shape.square': 'Cuadrado',
};

const en = {
    // header
    'app.title': 'Social Share',
    'app.subtitle': 'Buttons to share the current page on social networks',
    // how to use
    'usage.title': 'How to use',
    'usage.intro1': 'Add the ',
    'usage.intro2': ' block in the visual editor of any page or post. The buttons share the URL and title of the page they appear on — no configuration, keys or server calls needed.',
    'usage.step1': 'Open the visual editor of the page or post where you want the buttons.',
    'usage.step2a': 'Drag the ',
    'usage.step2b': ' block ("Social" category) into the content.',
    'usage.step3': 'Choose which networks to show and adjust the title, size (small / medium / large), shape (circle / rounded / square), labels and alignment.',
    'usage.note': '"Copy link" uses the browser clipboard and shows a "Copied!" confirmation for 2 seconds. "Email" opens the visitor\'s email client.',
    // networks
    'networks.title': 'Supported networks',
    'net.facebook.desc': 'Opens the Facebook share dialog',
    'net.x.desc': 'Publishes a post with the link and the title',
    'net.whatsapp.desc': 'Shares via chat (wa.me)',
    'net.linkedin.desc': 'Shares with your professional network',
    'net.telegram.desc': 'Shares via Telegram (t.me)',
    'net.email.name': 'Email',
    'net.email.desc': 'Opens your email client (mailto)',
    'net.copyLink.name': 'Copy link',
    'net.copyLink.desc': 'Copies the URL to the clipboard',
    // preview
    'preview.title': 'Preview',
    'preview.help': 'Static sample of the three sizes and the three shapes — the real buttons are added with the block in the visual editor.',
    'preview.shapes': 'Shapes',
    'size.small': 'Small',
    'size.medium': 'Medium',
    'size.large': 'Large',
    'shape.circle': 'Circle',
    'shape.rounded': 'Rounded',
    'shape.square': 'Square',
};

const pt = {
    // header
    'app.title': 'Compartilhamento Social',
    'app.subtitle': 'Botões para compartilhar a página atual nas redes sociais',
    // how to use
    'usage.title': 'Como usar',
    'usage.intro1': 'Adicione o bloco ',
    'usage.intro2': ' no editor visual de qualquer página ou post. Os botões compartilham a URL e o título da página onde aparecem — não precisam de configuração, chaves nem chamadas ao servidor.',
    'usage.step1': 'Abra o editor visual da página ou post onde você quer os botões.',
    'usage.step2a': 'Arraste o bloco ',
    'usage.step2b': ' (categoria "Social") para o conteúdo.',
    'usage.step3': 'Escolha quais redes mostrar e ajuste o título, o tamanho (pequeno / médio / grande), o formato (círculo / arredondado / quadrado), os rótulos e o alinhamento.',
    'usage.note': '"Copiar link" usa a área de transferência do navegador e confirma com "Copiado!" durante 2 segundos. "E-mail" abre o cliente de e-mail do visitante.',
    // networks
    'networks.title': 'Redes suportadas',
    'net.facebook.desc': 'Abre a caixa de compartilhamento do Facebook',
    'net.x.desc': 'Publica um post com o link e o título',
    'net.whatsapp.desc': 'Compartilha por chat (wa.me)',
    'net.linkedin.desc': 'Compartilha na sua rede profissional',
    'net.telegram.desc': 'Compartilha pelo Telegram (t.me)',
    'net.email.name': 'E-mail',
    'net.email.desc': 'Abre o seu cliente de e-mail (mailto)',
    'net.copyLink.name': 'Copiar link',
    'net.copyLink.desc': 'Copia a URL para a área de transferência',
    // preview
    'preview.title': 'Pré-visualização',
    'preview.help': 'Amostra estática dos três tamanhos e dos três formatos — os botões reais são adicionados com o bloco no editor visual.',
    'preview.shapes': 'Formatos',
    'size.small': 'Pequeno',
    'size.medium': 'Médio',
    'size.large': 'Grande',
    'shape.circle': 'Círculo',
    'shape.rounded': 'Arredondado',
    'shape.square': 'Quadrado',
};

const TABLES = { es, en, pt };
const LOCALES = { es: 'es-ES', en: 'en-US', pt: 'pt-BR' };

export function translate(lang, key, vars) {
    const table = TABLES[lang] || es;
    let s = table[key] ?? en[key] ?? key;
    if (vars) for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
    return s;
}

/** The current admin language and a `t(key, vars)` bound to it. */
export function useT() {
    const ctx = useOptionalI18n ? useOptionalI18n() : null;
    let lang = ctx?.language;
    if (!lang && typeof document !== 'undefined') lang = document.documentElement.lang || '';
    lang = String(lang || '').slice(0, 2).toLowerCase();
    if (lang !== 'es' && lang !== 'en' && lang !== 'pt') lang = 'es';
    const t = (key, vars) => translate(lang, key, vars);
    return { t, lang, locale: LOCALES[lang] };
}
