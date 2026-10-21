"use client";

import { Fragment, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useAuth } from "@/contexts/AuthContext";
import { useI18n } from "@/contexts/I18nContext";
import { PageHeader } from "@/components/ui";
import { registerTranslations } from "@/lib/i18n";
import { importApi, type WxrAnalysis, type ImportSummary, type ImportMediaMode } from "@/lib/api";

type Phase = "idle" | "analyzing" | "ready" | "importing" | "done";

// The core catalogue (lib/i18n.ts) has no wpImport.* keys: this screen registers its own, the same way
// /admin/tags and /admin/audit do. Sentences with inline markup keep it whole through {placeholders}.
registerTranslations({
    es: {
        "wpImport.title": "Importar desde WordPress",
        "wpImport.intro": "Sube un archivo de exportación de WordPress ({xml} / WXR, desde {tools} en WP) para traer entradas, páginas, categorías, etiquetas, autores y comentarios.",
        "wpImport.intro.tools": "Herramientas → Exportar",
        "wpImport.dropzone.aria": "Sube un archivo de exportación WXR de WordPress o suéltalo aquí",
        "wpImport.dropzone.chosen": "{size} · haz clic para elegir otro archivo",
        "wpImport.dropzone.empty": "Suelta aquí tu archivo WXR o haz clic para buscarlo",
        "wpImport.dropzone.limits": "WordPress eXtended RSS (.xml), hasta 100 MB",
        "wpImport.readFailed": "No se pudo leer el archivo",
        "wpImport.importFailed": "La importación ha fallado",
        "wpImport.reading": "Leyendo la exportación…",
        "wpImport.foundIn": "Encontrado en {site}",
        "wpImport.thisExport": "esta exportación",
        "wpImport.stat.posts": "Entradas",
        "wpImport.stat.pages": "Páginas",
        "wpImport.stat.categories": "Categorías",
        "wpImport.stat.tags": "Etiquetas",
        "wpImport.stat.authors": "Autores",
        "wpImport.stat.comments": "Comentarios",
        "wpImport.stat.attachments": "Adjuntos",
        "wpImport.stat.menuItems": "Elementos de menú",
        "wpImport.stat.downloaded": "Descargados",
        "wpImport.stat.linked": "Enlazados",
        "wpImport.stat.skipped": "Omitidos",
        "wpImport.stat.failed": "Fallidos",
        "wpImport.stat.menus": "Menús",
        "wpImport.stat.locationsSet": "Ubicaciones asignadas",
        "wpImport.stat.unassigned": "Sin asignar",
        "wpImport.sub.skipped": "{n} omitidos",
        "wpImport.sub.matched": "{n} coincidentes",
        "wpImport.sub.alreadyImported": "ya importados",
        "wpImport.rerunNote": "WXR v{version}. Volver a ejecutarlo es seguro: las entradas, términos, usuarios, medios y elementos de menú existentes se reconocen, no se duplican, y un adjunto que ya se descargó nunca se vuelve a descargar.",
        "wpImport.options": "Opciones",
        "wpImport.comments.label": "Importar comentarios",
        "wpImport.comments.hint": "Trae los comentarios aprobados y pendientes (con sus hilos).",
        "wpImport.media.legend": "Importar medios",
        "wpImport.media.help": "Una exportación de WordPress enumera tus subidas por {url}, no como archivos, así que traerlas significa descargarlas del sitio antiguo.",
        "wpImport.media.download.label": "Descargar los archivos",
        "wpImport.media.download.hint": "El servidor descarga cada adjunto del sitio antiguo y lo guarda aquí (solo https, hasta 50 MB por archivo y 1 GB por ejecución). Las URL de imágenes dentro del contenido se reescriben para apuntar a esta instalación.",
        "wpImport.media.link.label": "Enlazar al sitio antiguo",
        "wpImport.media.link.hint": "Crea las entradas de la biblioteca de medios pero no descarga nada: los archivos se siguen cargando desde el sitio antiguo, así que se rompen si este desaparece.",
        "wpImport.media.skip.label": "Omitir adjuntos",
        "wpImport.media.skip.hint": "No importa ningún medio. Elige esto si vas a copiar wp-content/uploads a mano.",
        "wpImport.allowHttp.label": "Permitir orígenes http://",
        "wpImport.allowHttp.hint": "Solo si el sitio antiguo no tiene HTTPS. Las direcciones privadas y de loopback se siguen rechazando en cualquier caso.",
        "wpImport.authorFallback": "Las entradas cuyo autor de WordPress no se encuentre se asignan a {user}.",
        "wpImport.you": "ti",
        "wpImport.importing": "Importando…",
        "wpImport.start": "Iniciar importación",
        "wpImport.cancel": "Cancelar",
        "wpImport.done.title": "Importación completada",
        "wpImport.done.body": "El contenido de {site} ya está en tu sitio.",
        "wpImport.theExport": "la exportación",
        "wpImport.media.title": "Medios",
        "wpImport.mode.download": "descargar",
        "wpImport.mode.link": "enlazar",
        "wpImport.mode.skip": "omitir",
        "wpImport.media.failures": "{n} archivo(s) no se pudieron importar",
        "wpImport.media.retry": "Vuelve a ejecutar esta importación para reintentar exactamente estos archivos: los que ya llegaron no cuestan nada.",
        "wpImport.menus.title": "Menús",
        "wpImport.menus.noLocation": "La exportación no indicaba ninguna ubicación del tema.",
        "wpImport.menus.assign": "Asígnalos en {menus}.",
        "wpImport.menus.link": "Menús",
        "wpImport.errors": "{n} elemento(s) tuvieron problemas (la importación continuó)",
        "wpImport.viewPosts": "Ver entradas",
        "wpImport.another": "Importar otro archivo",
    },
    en: {
        "wpImport.title": "Import from WordPress",
        "wpImport.intro": "Upload a WordPress export file ({xml} / WXR, from {tools} in WP) to bring over posts, pages, categories, tags, authors and comments.",
        "wpImport.intro.tools": "Tools → Export",
        "wpImport.dropzone.aria": "Upload a WordPress WXR export file, or drop it here",
        "wpImport.dropzone.chosen": "{size} · click to choose a different file",
        "wpImport.dropzone.empty": "Drop your WXR file here, or click to browse",
        "wpImport.dropzone.limits": "WordPress eXtended RSS (.xml), up to 100 MB",
        "wpImport.readFailed": "Failed to read the file",
        "wpImport.importFailed": "Import failed",
        "wpImport.reading": "Reading export…",
        "wpImport.foundIn": "Found in {site}",
        "wpImport.thisExport": "this export",
        "wpImport.stat.posts": "Posts",
        "wpImport.stat.pages": "Pages",
        "wpImport.stat.categories": "Categories",
        "wpImport.stat.tags": "Tags",
        "wpImport.stat.authors": "Authors",
        "wpImport.stat.comments": "Comments",
        "wpImport.stat.attachments": "Attachments",
        "wpImport.stat.menuItems": "Menu items",
        "wpImport.stat.downloaded": "Downloaded",
        "wpImport.stat.linked": "Linked",
        "wpImport.stat.skipped": "Skipped",
        "wpImport.stat.failed": "Failed",
        "wpImport.stat.menus": "Menus",
        "wpImport.stat.locationsSet": "Locations set",
        "wpImport.stat.unassigned": "Unassigned",
        "wpImport.sub.skipped": "{n} skipped",
        "wpImport.sub.matched": "{n} matched",
        "wpImport.sub.alreadyImported": "already imported",
        "wpImport.rerunNote": "WXR v{version}. Re-running is safe — existing posts, terms, users, media and menu items are matched, not duplicated, and an attachment that already downloaded is never fetched twice.",
        "wpImport.options": "Options",
        "wpImport.comments.label": "Import comments",
        "wpImport.comments.hint": "Bring over approved and pending comments (threading preserved).",
        "wpImport.media.legend": "Import media",
        "wpImport.media.help": "A WordPress export lists your uploads by {url}, not as files — so bringing them over means fetching them from the old site.",
        "wpImport.media.download.label": "Download the files",
        "wpImport.media.download.hint": "The server fetches every attachment from the old site and stores it here (https only, up to 50 MB per file and 1 GB per run). In-content image URLs are rewritten to point at this install.",
        "wpImport.media.link.label": "Link to the old site",
        "wpImport.media.link.hint": "Create the media-library entries but download nothing: the files keep loading from the old site, so they break if it goes away.",
        "wpImport.media.skip.label": "Skip attachments",
        "wpImport.media.skip.hint": "Import no media at all. Choose this if you are copying wp-content/uploads across by hand.",
        "wpImport.allowHttp.label": "Allow http:// sources",
        "wpImport.allowHttp.hint": "Only if the old site has no HTTPS. Private and loopback addresses stay refused either way.",
        "wpImport.authorFallback": "Posts whose WordPress author isn't found are assigned to {user}.",
        "wpImport.you": "you",
        "wpImport.importing": "Importing…",
        "wpImport.start": "Start import",
        "wpImport.cancel": "Cancel",
        "wpImport.done.title": "Import complete",
        "wpImport.done.body": "Content from {site} is now in your site.",
        "wpImport.theExport": "the export",
        "wpImport.media.title": "Media",
        "wpImport.mode.download": "download",
        "wpImport.mode.link": "link",
        "wpImport.mode.skip": "skip",
        "wpImport.media.failures": "{n} file(s) could not be imported",
        "wpImport.media.retry": "Re-run this import to retry exactly these files — the ones that already landed cost nothing.",
        "wpImport.menus.title": "Menus",
        "wpImport.menus.noLocation": "No theme location was named by the export.",
        "wpImport.menus.assign": "Assign them under {menus}.",
        "wpImport.menus.link": "Menus",
        "wpImport.errors": "{n} item(s) had issues (import continued)",
        "wpImport.viewPosts": "View posts",
        "wpImport.another": "Import another file",
    },
    pt: {
        "wpImport.title": "Importar do WordPress",
        "wpImport.intro": "Envie um arquivo de exportação do WordPress ({xml} / WXR, em {tools} no WP) para trazer posts, páginas, categorias, tags, autores e comentários.",
        "wpImport.intro.tools": "Ferramentas → Exportar",
        "wpImport.dropzone.aria": "Envie um arquivo de exportação WXR do WordPress ou solte-o aqui",
        "wpImport.dropzone.chosen": "{size} · clique para escolher outro arquivo",
        "wpImport.dropzone.empty": "Solte seu arquivo WXR aqui ou clique para procurar",
        "wpImport.dropzone.limits": "WordPress eXtended RSS (.xml), até 100 MB",
        "wpImport.readFailed": "Não foi possível ler o arquivo",
        "wpImport.importFailed": "A importação falhou",
        "wpImport.reading": "Lendo a exportação…",
        "wpImport.foundIn": "Encontrado em {site}",
        "wpImport.thisExport": "esta exportação",
        "wpImport.stat.posts": "Posts",
        "wpImport.stat.pages": "Páginas",
        "wpImport.stat.categories": "Categorias",
        "wpImport.stat.tags": "Tags",
        "wpImport.stat.authors": "Autores",
        "wpImport.stat.comments": "Comentários",
        "wpImport.stat.attachments": "Anexos",
        "wpImport.stat.menuItems": "Itens de menu",
        "wpImport.stat.downloaded": "Baixados",
        "wpImport.stat.linked": "Vinculados",
        "wpImport.stat.skipped": "Ignorados",
        "wpImport.stat.failed": "Com falha",
        "wpImport.stat.menus": "Menus",
        "wpImport.stat.locationsSet": "Locais definidos",
        "wpImport.stat.unassigned": "Sem local",
        "wpImport.sub.skipped": "{n} ignorados",
        "wpImport.sub.matched": "{n} correspondentes",
        "wpImport.sub.alreadyImported": "já importados",
        "wpImport.rerunNote": "WXR v{version}. Executar de novo é seguro: posts, termos, usuários, mídias e itens de menu existentes são reconhecidos, não duplicados, e um anexo que já foi baixado nunca é buscado duas vezes.",
        "wpImport.options": "Opções",
        "wpImport.comments.label": "Importar comentários",
        "wpImport.comments.hint": "Traz os comentários aprovados e pendentes (com as respostas encadeadas).",
        "wpImport.media.legend": "Importar mídia",
        "wpImport.media.help": "Uma exportação do WordPress lista seus uploads por {url}, não como arquivos, então trazê-los significa baixá-los do site antigo.",
        "wpImport.media.download.label": "Baixar os arquivos",
        "wpImport.media.download.hint": "O servidor baixa cada anexo do site antigo e o guarda aqui (somente https, até 50 MB por arquivo e 1 GB por execução). As URLs de imagens no conteúdo são reescritas para apontar para esta instalação.",
        "wpImport.media.link.label": "Vincular ao site antigo",
        "wpImport.media.link.hint": "Cria as entradas da biblioteca de mídia, mas não baixa nada: os arquivos continuam carregando do site antigo, então quebram se ele sair do ar.",
        "wpImport.media.skip.label": "Ignorar anexos",
        "wpImport.media.skip.hint": "Não importa nenhuma mídia. Escolha isto se você vai copiar wp-content/uploads manualmente.",
        "wpImport.allowHttp.label": "Permitir origens http://",
        "wpImport.allowHttp.hint": "Só se o site antigo não tiver HTTPS. Endereços privados e de loopback continuam recusados de qualquer forma.",
        "wpImport.authorFallback": "Posts cujo autor do WordPress não for encontrado são atribuídos a {user}.",
        "wpImport.you": "você",
        "wpImport.importing": "Importando…",
        "wpImport.start": "Iniciar importação",
        "wpImport.cancel": "Cancelar",
        "wpImport.done.title": "Importação concluída",
        "wpImport.done.body": "O conteúdo de {site} já está no seu site.",
        "wpImport.theExport": "a exportação",
        "wpImport.media.title": "Mídia",
        "wpImport.mode.download": "baixar",
        "wpImport.mode.link": "vincular",
        "wpImport.mode.skip": "ignorar",
        "wpImport.media.failures": "{n} arquivo(s) não puderam ser importados",
        "wpImport.media.retry": "Execute esta importação de novo para tentar exatamente estes arquivos outra vez: os que já chegaram não custam nada.",
        "wpImport.menus.title": "Menus",
        "wpImport.menus.noLocation": "A exportação não indicou nenhum local do tema.",
        "wpImport.menus.assign": "Atribua-os em {menus}.",
        "wpImport.menus.link": "Menus",
        "wpImport.errors": "{n} item(ns) tiveram problemas (a importação continuou)",
        "wpImport.viewPosts": "Ver posts",
        "wpImport.another": "Importar outro arquivo",
    },
});

/**
 * The three media modes, with the copy an operator needs BEFORE ticking the box (wpImport.media.<mode>.*).
 *
 * The toggle here used to read "Create attachment records — Metadata only, media files are not
 * downloaded from the old site" while the option it sent already meant `download`: the admin was
 * agreeing to up to a gigabyte of host-side fetches against third-party URLs under a label that denied
 * they happened. The single most consequential thing this screen can do has to say so.
 */
const MEDIA_MODES: ImportMediaMode[] = ["download", "link", "skip"];

/** A translated sentence with its {placeholders} replaced by elements (inline markup stays in one string). */
function fill(text: string, parts: Record<string, ReactNode>): ReactNode {
    return text.split(/\{(\w+)\}/).map((piece, i) => (
        <Fragment key={i}>{i % 2 ? (parts[piece] ?? `{${piece}}`) : piece}</Fragment>
    ));
}

export default function ImportPage() {
    const { user } = useAuth();
    const { t } = useI18n();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [file, setFile] = useState<File | null>(null);
    const [phase, setPhase] = useState<Phase>("idle");
    const [analysis, setAnalysis] = useState<WxrAnalysis | null>(null);
    const [summary, setSummary] = useState<ImportSummary | null>(null);
    const [error, setError] = useState<string>("");
    const [dragOver, setDragOver] = useState(false);

    // Options
    const [importComments, setImportComments] = useState(true);
    const [media, setMedia] = useState<ImportMediaMode>("download");
    const [allowHttp, setAllowHttp] = useState(false);

    const reset = () => {
        setFile(null); setAnalysis(null); setSummary(null); setError(""); setPhase("idle");
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const onPick = async (f: File | null) => {
        if (!f) return;
        setFile(f); setAnalysis(null); setSummary(null); setError(""); setPhase("analyzing");
        try {
            const res = await importApi.analyze(f);
            setAnalysis(res.analysis);
            setPhase("ready");
        } catch (e) {
            setError(e instanceof Error ? e.message : t("wpImport.readFailed"));
            setPhase("idle");
        }
    };

    const runImport = async () => {
        if (!file) return;
        setPhase("importing"); setError("");
        try {
            const res = await importApi.wordpress(file, {
                defaultAuthorId: user?.id,
                importComments,
                media,
                allowHttp: media === "download" ? allowHttp : false,
            });
            setSummary(res.summary);
            setPhase("done");
        } catch (e) {
            setError(e instanceof Error ? e.message : t("wpImport.importFailed"));
            setPhase("ready");
        }
    };

    const fmtBytes = (n: number) => n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
    const n = (key: string, value: number) => t(key).replace("{n}", String(value));
    const modeName = (mode: string) => { const key = `wpImport.mode.${mode}`; const s = t(key); return s === key ? mode : s; };
    const c = analysis?.counts;

    return (
        <div className="max-w-4xl mx-auto px-4 py-8 space-y-8 h-full overflow-y-auto">
            {/* Header — the shared one (QA M1-12); the intro keeps its inline markup below it. */}
            <div>
                <PageHeader title={t("wpImport.title")} icon="fa-file-import" />
                <div className="-mt-4 md:-mt-8">
                    <p className="text-gray-500">
                        {fill(t("wpImport.intro"), {
                            xml: <code className="text-sm bg-gray-100 px-1.5 py-0.5 rounded">.xml</code>,
                            tools: <span className="font-medium">{t("wpImport.intro.tools")}</span>,
                        })}
                    </p>
                </div>
            </div>

            {/* Dropzone */}
            <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); onPick(e.dataTransfer.files?.[0] || null); }}
                className={`rounded-2xl border-2 border-dashed transition-all p-8 text-center cursor-pointer
                    ${dragOver ? "border-blue-500 bg-blue-50" : "border-gray-200 bg-white hover:border-blue-300 hover:bg-gray-50"}`}
                role="button"
                tabIndex={0}
                aria-label={t("wpImport.dropzone.aria")}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}
            >
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xml,.wxr,text/xml,application/xml"
                    className="hidden"
                    onChange={(e) => onPick(e.target.files?.[0] || null)}
                />
                <div className="text-4xl text-blue-500 mb-3"><i className="fa-solid fa-file-arrow-up"></i></div>
                {file ? (
                    <div>
                        <p className="font-semibold text-gray-800 break-words">{file.name}</p>
                        <p className="text-sm text-gray-500">{t("wpImport.dropzone.chosen").replace("{size}", fmtBytes(file.size))}</p>
                    </div>
                ) : (
                    <div>
                        <p className="font-semibold text-gray-700">{t("wpImport.dropzone.empty")}</p>
                        <p className="text-sm text-gray-400 mt-1">{t("wpImport.dropzone.limits")}</p>
                    </div>
                )}
            </div>

            {error && (
                <div className="rounded-xl bg-red-50 border border-red-200 text-red-700 px-4 py-3 flex items-center gap-3">
                    <i className="fa-solid fa-triangle-exclamation"></i>
                    <span className="text-sm">{error}</span>
                </div>
            )}

            {phase === "analyzing" && (
                <div className="flex items-center gap-3 text-gray-500">
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-blue-500 border-t-transparent"></div>
                    {t("wpImport.reading")}
                </div>
            )}

            {/* Analysis preview + options */}
            {c && phase !== "done" && (
                <div className="space-y-6">
                    <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-6">
                        <h2 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                            <i className="fa-solid fa-magnifying-glass-chart text-blue-500"></i>
                            {fill(t("wpImport.foundIn"), {
                                site: <span className="text-blue-600">{analysis?.site.title || t("wpImport.thisExport")}</span>,
                            })}
                        </h2>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                            <Stat label={t("wpImport.stat.posts")} value={c.posts} icon="fa-pen-to-square" />
                            <Stat label={t("wpImport.stat.pages")} value={c.pages} icon="fa-file-lines" />
                            <Stat label={t("wpImport.stat.categories")} value={c.categories} icon="fa-folder" />
                            <Stat label={t("wpImport.stat.tags")} value={c.tags} icon="fa-tag" />
                            <Stat label={t("wpImport.stat.authors")} value={c.authors} icon="fa-user" />
                            <Stat label={t("wpImport.stat.comments")} value={c.comments} icon="fa-comments" />
                            <Stat label={t("wpImport.stat.attachments")} value={c.attachments} icon="fa-paperclip" />
                            <Stat label={t("wpImport.stat.menuItems")} value={c.navItems} icon="fa-bars" />
                        </div>
                        <p className="text-xs text-gray-400 mt-4">
                            {t("wpImport.rerunNote").replace("{version}", String(analysis?.wxrVersion ?? ""))}
                        </p>
                    </div>

                    <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-6 space-y-4">
                        <h3 className="font-semibold text-gray-900">{t("wpImport.options")}</h3>
                        <Toggle checked={importComments} onChange={setImportComments}
                            label={t("wpImport.comments.label")} hint={t("wpImport.comments.hint")} />

                        <fieldset className="space-y-2">
                            <legend className="font-medium text-gray-800">{t("wpImport.media.legend")}</legend>
                            <p className="text-sm text-gray-500">
                                {fill(t("wpImport.media.help"), { url: <span className="font-medium">URL</span> })}
                            </p>
                            <div className="space-y-2 pt-1">
                                {MEDIA_MODES.map((m) => (
                                    <label key={m} className="flex items-start gap-3 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="media-mode"
                                            className="mt-1 h-4 w-4 accent-blue-600"
                                            value={m}
                                            checked={media === m}
                                            onChange={() => setMedia(m)}
                                        />
                                        <span>
                                            <span className="font-medium text-gray-800">{t(`wpImport.media.${m}.label`)}</span>
                                            <span className="block text-sm text-gray-500">{t(`wpImport.media.${m}.hint`)}</span>
                                        </span>
                                    </label>
                                ))}
                            </div>
                        </fieldset>

                        {media === "download" && (
                            <Toggle checked={allowHttp} onChange={setAllowHttp}
                                label={t("wpImport.allowHttp.label")}
                                hint={t("wpImport.allowHttp.hint")} />
                        )}

                        <div className="text-sm text-gray-500 bg-gray-50 rounded-lg px-4 py-3">
                            <i className="fa-solid fa-circle-info text-blue-400 mr-2"></i>
                            {fill(t("wpImport.authorFallback"), {
                                user: <span className="font-medium text-gray-700">{user?.displayName || user?.username || t("wpImport.you")}</span>,
                            })}
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <button
                            onClick={runImport}
                            disabled={phase === "importing"}
                            className="px-6 py-3 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white font-semibold shadow-lg shadow-blue-500/30 hover:opacity-95 disabled:opacity-60 flex items-center gap-2"
                        >
                            {phase === "importing" ? (
                                <><div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div> {t("wpImport.importing")}</>
                            ) : (
                                <><i className="fa-solid fa-download"></i> {t("wpImport.start")}</>
                            )}
                        </button>
                        <button onClick={reset} className="px-4 py-3 rounded-xl text-gray-500 hover:bg-gray-100 font-medium">{t("wpImport.cancel")}</button>
                    </div>
                </div>
            )}

            {/* Result */}
            {summary && phase === "done" && (
                <div className="space-y-6">
                    <div className="rounded-2xl bg-green-50 border border-green-200 p-6">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="h-10 w-10 shrink-0 rounded-full bg-green-500 flex items-center justify-center text-white">
                                <i className="fa-solid fa-check"></i>
                            </div>
                            <div>
                                <h2 className="font-bold text-green-900">{t("wpImport.done.title")}</h2>
                                <p className="text-sm text-green-700">{t("wpImport.done.body").replace("{site}", summary.site.title || t("wpImport.theExport"))}</p>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                            <Stat label={t("wpImport.stat.posts")} value={summary.posts.created} sub={n("wpImport.sub.skipped", summary.posts.skipped)} icon="fa-pen-to-square" />
                            <Stat label={t("wpImport.stat.pages")} value={summary.pages.created} sub={n("wpImport.sub.skipped", summary.pages.skipped)} icon="fa-file-lines" />
                            <Stat label={t("wpImport.stat.categories")} value={summary.terms.categories} icon="fa-folder" />
                            <Stat label={t("wpImport.stat.tags")} value={summary.terms.tags} icon="fa-tag" />
                            <Stat label={t("wpImport.stat.authors")} value={summary.authors.created} sub={n("wpImport.sub.matched", summary.authors.matched)} icon="fa-user" />
                            <Stat label={t("wpImport.stat.comments")} value={summary.comments.created} sub={n("wpImport.sub.skipped", summary.comments.skipped)} icon="fa-comments" />
                        </div>
                    </div>

                    {/* The media pass. Per-file download failures are the ONLY place an operator learns
                        that an image did not come over — the run itself keeps going past them. */}
                    {summary.media && (
                        <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-6">
                            <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                                <i className="fa-solid fa-photo-film text-blue-500"></i>
                                {t("wpImport.media.title")} <span className="text-sm font-normal text-gray-400">({modeName(summary.media.mode)})</span>
                            </h3>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                                <Stat label={t("wpImport.stat.downloaded")} value={summary.media.downloaded} sub={fmtBytes(summary.media.bytes)} icon="fa-cloud-arrow-down" />
                                <Stat label={t("wpImport.stat.linked")} value={summary.media.linked} icon="fa-link" muted={summary.media.linked === 0} />
                                <Stat label={t("wpImport.stat.skipped")} value={summary.media.skipped} sub={t("wpImport.sub.alreadyImported")} icon="fa-forward" muted={summary.media.skipped === 0} />
                                <Stat label={t("wpImport.stat.failed")} value={summary.media.failed} icon="fa-triangle-exclamation" muted={summary.media.failed === 0} />
                            </div>
                            {summary.media.failures.length > 0 && (
                                <details className="mt-4 rounded-xl bg-amber-50 border border-amber-200 p-4">
                                    <summary className="cursor-pointer font-medium text-amber-800">
                                        {n("wpImport.media.failures", summary.media.failures.length)}
                                    </summary>
                                    <ul className="mt-3 space-y-1 text-sm text-amber-700 max-h-60 overflow-auto">
                                        {summary.media.failures.map((f, i) => (
                                            <li key={i} className="font-mono text-xs break-all">• {f.url} — {f.reason}</li>
                                        ))}
                                    </ul>
                                    <p className="text-xs text-amber-700 mt-3">
                                        {t("wpImport.media.retry")}
                                    </p>
                                </details>
                            )}
                        </div>
                    )}

                    {summary.menus && (
                        <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-6">
                            <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                                <i className="fa-solid fa-bars text-blue-500"></i> {t("wpImport.menus.title")}
                            </h3>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                                <Stat label={t("wpImport.stat.menus")} value={summary.menus.created} sub={n("wpImport.sub.matched", summary.menus.matched)} icon="fa-list" />
                                <Stat label={t("wpImport.stat.menuItems")} value={summary.menus.items.created} sub={n("wpImport.sub.skipped", summary.menus.items.skipped)} icon="fa-link" />
                                <Stat label={t("wpImport.stat.locationsSet")} value={summary.menus.locations.assigned} icon="fa-map-pin" muted={summary.menus.locations.assigned === 0} />
                                <Stat label={t("wpImport.stat.unassigned")} value={summary.menus.locations.unassigned} icon="fa-map-pin" muted={summary.menus.locations.unassigned === 0} />
                            </div>
                            {summary.menus.locations.unassigned > 0 && (
                                <p className="text-sm text-gray-500 mt-4">
                                    {summary.menus.locations.reason || t("wpImport.menus.noLocation")}{" "}
                                    {fill(t("wpImport.menus.assign"), {
                                        menus: <Link href="/admin/menus" className="font-medium text-gray-700 underline">{t("wpImport.menus.link")}</Link>,
                                    })}
                                </p>
                            )}
                        </div>
                    )}

                    {summary.errors.length > 0 && (
                        <details className="rounded-xl bg-amber-50 border border-amber-200 p-4">
                            <summary className="cursor-pointer font-medium text-amber-800">
                                {n("wpImport.errors", summary.errors.length)}
                            </summary>
                            <ul className="mt-3 space-y-1 text-sm text-amber-700 max-h-60 overflow-auto">
                                {summary.errors.map((e, i) => <li key={i} className="font-mono text-xs">• {e}</li>)}
                            </ul>
                        </details>
                    )}

                    <div className="flex gap-3">
                        <a href="/admin/posts" className="px-6 py-3 rounded-xl bg-gray-900 text-white font-semibold hover:bg-gray-800 flex items-center gap-2">
                            <i className="fa-solid fa-arrow-right"></i> {t("wpImport.viewPosts")}
                        </a>
                        <button onClick={reset} className="px-4 py-3 rounded-xl text-gray-500 hover:bg-gray-100 font-medium">{t("wpImport.another")}</button>
                    </div>
                </div>
            )}
        </div>
    );
}

function Stat({ label, value, sub, icon, muted }: { label: string; value: number; sub?: string; icon: string; muted?: boolean }) {
    return (
        <div className={`rounded-xl p-4 ${muted ? "bg-gray-50" : "bg-gray-50/80"} border border-gray-100`}>
            <div className="flex items-center gap-2 text-gray-400 text-xs uppercase tracking-wide font-semibold">
                <i className={`fa-solid ${icon}`}></i> {label}
            </div>
            <div className={`text-2xl font-bold mt-1 ${muted ? "text-gray-400" : "text-gray-900"}`}>{value}</div>
            {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
        </div>
    );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
    return (
        <label className="flex items-start gap-3 cursor-pointer">
            <button
                type="button"
                role="switch"
                aria-checked={checked}
                onClick={() => onChange(!checked)}
                className={`mt-0.5 relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-blue-600" : "bg-gray-300"}`}
            >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
            </button>
            <div>
                <div className="font-medium text-gray-800">{label}</div>
                <div className="text-sm text-gray-500">{hint}</div>
            </div>
        </label>
    );
}
