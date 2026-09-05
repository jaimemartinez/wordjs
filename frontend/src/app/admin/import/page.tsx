"use client";

import { useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { importApi, type WxrAnalysis, type ImportSummary, type ImportMediaMode } from "@/lib/api";

type Phase = "idle" | "analyzing" | "ready" | "importing" | "done";

/**
 * The three media modes, with the copy an operator needs BEFORE ticking the box.
 *
 * The toggle here used to read "Create attachment records — Metadata only, media files are not
 * downloaded from the old site" while the option it sent already meant `download`: the admin was
 * agreeing to up to a gigabyte of host-side fetches against third-party URLs under a label that denied
 * they happened. The single most consequential thing this screen can do has to say so.
 */
const MEDIA_MODES: { value: ImportMediaMode; label: string; hint: string }[] = [
    {
        value: "download",
        label: "Download the files",
        hint: "The server fetches every attachment from the old site and stores it here (https only, up to 50 MB per file and 1 GB per run). In-content image URLs are rewritten to point at this install.",
    },
    {
        value: "link",
        label: "Link to the old site",
        hint: "Create the media-library entries but download nothing: the files keep loading from the old site, so they break if it goes away.",
    },
    {
        value: "skip",
        label: "Skip attachments",
        hint: "Import no media at all. Choose this if you are copying wp-content/uploads across by hand.",
    },
];

export default function ImportPage() {
    const { user } = useAuth();
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
            setError(e instanceof Error ? e.message : "Failed to read the file");
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
            setError(e instanceof Error ? e.message : "Import failed");
            setPhase("ready");
        }
    };

    const fmtBytes = (n: number) => n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
    const c = analysis?.counts;

    return (
        <div className="max-w-4xl mx-auto px-4 py-8 space-y-8 h-full overflow-y-auto">
            {/* Header */}
            <div className="flex items-start gap-4">
                <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/30 shrink-0">
                    <i className="fa-brands fa-wordpress text-white text-xl"></i>
                </div>
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Import from WordPress</h1>
                    <p className="text-gray-500 mt-1">
                        Upload a WordPress export file (<code className="text-sm bg-gray-100 px-1.5 py-0.5 rounded">.xml</code> /
                        WXR, from <span className="font-medium">Tools → Export</span> in WP) to bring over posts, pages,
                        categories, tags, authors and comments.
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
                aria-label="Upload a WordPress WXR export file, or drop it here"
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
                        <p className="text-sm text-gray-500">{fmtBytes(file.size)} · click to choose a different file</p>
                    </div>
                ) : (
                    <div>
                        <p className="font-semibold text-gray-700">Drop your WXR file here, or click to browse</p>
                        <p className="text-sm text-gray-400 mt-1">WordPress eXtended RSS (.xml), up to 100 MB</p>
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
                    Reading export…
                </div>
            )}

            {/* Analysis preview + options */}
            {c && phase !== "done" && (
                <div className="space-y-6">
                    <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-6">
                        <h2 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                            <i className="fa-solid fa-magnifying-glass-chart text-blue-500"></i>
                            Found in <span className="text-blue-600">{analysis?.site.title || "this export"}</span>
                        </h2>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                            <Stat label="Posts" value={c.posts} icon="fa-pen-to-square" />
                            <Stat label="Pages" value={c.pages} icon="fa-file-lines" />
                            <Stat label="Categories" value={c.categories} icon="fa-folder" />
                            <Stat label="Tags" value={c.tags} icon="fa-tag" />
                            <Stat label="Authors" value={c.authors} icon="fa-user" />
                            <Stat label="Comments" value={c.comments} icon="fa-comments" />
                            <Stat label="Attachments" value={c.attachments} icon="fa-paperclip" />
                            <Stat label="Menu items" value={c.navItems} icon="fa-bars" />
                        </div>
                        <p className="text-xs text-gray-400 mt-4">
                            WXR v{analysis?.wxrVersion}. Re-running is safe — existing posts, terms, users, media and
                            menu items are matched, not duplicated, and an attachment that already downloaded is never
                            fetched twice.
                        </p>
                    </div>

                    <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-6 space-y-4">
                        <h3 className="font-semibold text-gray-900">Options</h3>
                        <Toggle checked={importComments} onChange={setImportComments}
                            label="Import comments" hint="Bring over approved and pending comments (threading preserved)." />

                        <fieldset className="space-y-2">
                            <legend className="font-medium text-gray-800">Import media</legend>
                            <p className="text-sm text-gray-500">
                                A WordPress export lists your uploads by <span className="font-medium">URL</span>, not as
                                files — so bringing them over means fetching them from the old site.
                            </p>
                            <div className="space-y-2 pt-1">
                                {MEDIA_MODES.map((m) => (
                                    <label key={m.value} className="flex items-start gap-3 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="media-mode"
                                            className="mt-1 h-4 w-4 accent-blue-600"
                                            value={m.value}
                                            checked={media === m.value}
                                            onChange={() => setMedia(m.value)}
                                        />
                                        <span>
                                            <span className="font-medium text-gray-800">{m.label}</span>
                                            <span className="block text-sm text-gray-500">{m.hint}</span>
                                        </span>
                                    </label>
                                ))}
                            </div>
                        </fieldset>

                        {media === "download" && (
                            <Toggle checked={allowHttp} onChange={setAllowHttp}
                                label="Allow http:// sources"
                                hint="Only if the old site has no HTTPS. Private and loopback addresses stay refused either way." />
                        )}

                        <div className="text-sm text-gray-500 bg-gray-50 rounded-lg px-4 py-3">
                            <i className="fa-solid fa-circle-info text-blue-400 mr-2"></i>
                            Posts whose WordPress author isn&apos;t found are assigned to
                            <span className="font-medium text-gray-700"> {user?.displayName || user?.username || "you"}</span>.
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <button
                            onClick={runImport}
                            disabled={phase === "importing"}
                            className="px-6 py-3 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white font-semibold shadow-lg shadow-blue-500/30 hover:opacity-95 disabled:opacity-60 flex items-center gap-2"
                        >
                            {phase === "importing" ? (
                                <><div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div> Importing…</>
                            ) : (
                                <><i className="fa-solid fa-download"></i> Start import</>
                            )}
                        </button>
                        <button onClick={reset} className="px-4 py-3 rounded-xl text-gray-500 hover:bg-gray-100 font-medium">Cancel</button>
                    </div>
                </div>
            )}

            {/* Result */}
            {summary && phase === "done" && (
                <div className="space-y-6">
                    <div className="rounded-2xl bg-green-50 border border-green-200 p-6">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="h-10 w-10 rounded-full bg-green-500 flex items-center justify-center text-white">
                                <i className="fa-solid fa-check"></i>
                            </div>
                            <div>
                                <h2 className="font-bold text-green-900">Import complete</h2>
                                <p className="text-sm text-green-700">Content from {summary.site.title || "the export"} is now in your site.</p>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                            <Stat label="Posts" value={summary.posts.created} sub={`${summary.posts.skipped} skipped`} icon="fa-pen-to-square" />
                            <Stat label="Pages" value={summary.pages.created} sub={`${summary.pages.skipped} skipped`} icon="fa-file-lines" />
                            <Stat label="Categories" value={summary.terms.categories} icon="fa-folder" />
                            <Stat label="Tags" value={summary.terms.tags} icon="fa-tag" />
                            <Stat label="Authors" value={summary.authors.created} sub={`${summary.authors.matched} matched`} icon="fa-user" />
                            <Stat label="Comments" value={summary.comments.created} sub={`${summary.comments.skipped} skipped`} icon="fa-comments" />
                        </div>
                    </div>

                    {/* The media pass. Per-file download failures are the ONLY place an operator learns
                        that an image did not come over — the run itself keeps going past them. */}
                    {summary.media && (
                        <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-6">
                            <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                                <i className="fa-solid fa-photo-film text-blue-500"></i>
                                Media <span className="text-sm font-normal text-gray-400">({summary.media.mode})</span>
                            </h3>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                                <Stat label="Downloaded" value={summary.media.downloaded} sub={fmtBytes(summary.media.bytes)} icon="fa-cloud-arrow-down" />
                                <Stat label="Linked" value={summary.media.linked} icon="fa-link" muted={summary.media.linked === 0} />
                                <Stat label="Skipped" value={summary.media.skipped} sub="already imported" icon="fa-forward" muted={summary.media.skipped === 0} />
                                <Stat label="Failed" value={summary.media.failed} icon="fa-triangle-exclamation" muted={summary.media.failed === 0} />
                            </div>
                            {summary.media.failures.length > 0 && (
                                <details className="mt-4 rounded-xl bg-amber-50 border border-amber-200 p-4">
                                    <summary className="cursor-pointer font-medium text-amber-800">
                                        {summary.media.failures.length} file(s) could not be imported
                                    </summary>
                                    <ul className="mt-3 space-y-1 text-sm text-amber-700 max-h-60 overflow-auto">
                                        {summary.media.failures.map((f, i) => (
                                            <li key={i} className="font-mono text-xs break-all">• {f.url} — {f.reason}</li>
                                        ))}
                                    </ul>
                                    <p className="text-xs text-amber-700 mt-3">
                                        Re-run this import to retry exactly these files — the ones that already landed cost nothing.
                                    </p>
                                </details>
                            )}
                        </div>
                    )}

                    {summary.menus && (
                        <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-6">
                            <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                                <i className="fa-solid fa-bars text-blue-500"></i> Menus
                            </h3>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                                <Stat label="Menus" value={summary.menus.created} sub={`${summary.menus.matched} matched`} icon="fa-list" />
                                <Stat label="Menu items" value={summary.menus.items.created} sub={`${summary.menus.items.skipped} skipped`} icon="fa-link" />
                                <Stat label="Locations set" value={summary.menus.locations.assigned} icon="fa-map-pin" muted={summary.menus.locations.assigned === 0} />
                                <Stat label="Unassigned" value={summary.menus.locations.unassigned} icon="fa-map-pin" muted={summary.menus.locations.unassigned === 0} />
                            </div>
                            {summary.menus.locations.unassigned > 0 && (
                                <p className="text-sm text-gray-500 mt-4">
                                    {summary.menus.locations.reason || "No theme location was named by the export."} Assign
                                    them under <span className="font-medium text-gray-700">Appearance → Menus</span>.
                                </p>
                            )}
                        </div>
                    )}

                    {summary.errors.length > 0 && (
                        <details className="rounded-xl bg-amber-50 border border-amber-200 p-4">
                            <summary className="cursor-pointer font-medium text-amber-800">
                                {summary.errors.length} item(s) had issues (import continued)
                            </summary>
                            <ul className="mt-3 space-y-1 text-sm text-amber-700 max-h-60 overflow-auto">
                                {summary.errors.map((e, i) => <li key={i} className="font-mono text-xs">• {e}</li>)}
                            </ul>
                        </details>
                    )}

                    <div className="flex gap-3">
                        <a href="/admin/posts" className="px-6 py-3 rounded-xl bg-gray-900 text-white font-semibold hover:bg-gray-800 flex items-center gap-2">
                            <i className="fa-solid fa-arrow-right"></i> View posts
                        </a>
                        <button onClick={reset} className="px-4 py-3 rounded-xl text-gray-500 hover:bg-gray-100 font-medium">Import another file</button>
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
