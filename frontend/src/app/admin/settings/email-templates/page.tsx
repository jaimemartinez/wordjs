"use client";
/**
 * Settings → Emails: the words of every message the site sends and the layout around them (backend
 * routes/email-templates.ts, core/email-templates.ts).
 *
 * Each message is edited per language (subject, body, button text) with Verso's text surface, never raw
 * HTML. The button's link — a reset or verification link holds a single-use token — is added by the site
 * when the message is sent and is not part of the text, so no edit can remove it or copy it elsewhere.
 * Sign-in and site-address messages ask for the administrator's password before a change (the backend
 * re-authenticates and audits it). The preview renders the unsaved draft in the real layout.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
    emailTemplatesApi,
    EmailLang,
    EmailLayoutSettings,
    EmailRendered,
    EmailTemplateDetail,
    EmailTemplateSummary,
    EmailTemplateText,
} from "@/lib/api";
import { useToast } from "@/contexts/ToastContext";
import { useI18n } from "@/contexts/I18nContext";
import { useModal } from "@/contexts/ModalContext";
import { PageHeader, Button, Card, Field, Input, ColorInput, Switch, SegmentedControl, Tabs, UnstyledButton } from "@/components/ui";
import { LABEL_CLASS, HELP_CLASS } from "@/components/ui/Field";
import EmailBodyEditor, { type InsertAtCaret } from "./EmailBodyEditor";

const GROUPS: Array<EmailTemplateSummary["group"]> = ["account", "site", "comments", "plugin"];
const LANGS: EmailLang[] = ["es", "en", "pt"];
/** The layout's background when none is chosen (core/email-templates DEFAULT_BACKGROUND). */
const DEFAULT_BACKGROUND = "#f4f5f7";

export default function EmailTemplatesPage() {
    const { t, language } = useI18n();
    const { addToast } = useToast();
    const { confirm } = useModal();
    const uiLang: EmailLang = (LANGS as string[]).includes(language) ? (language as EmailLang) : "en";

    const [templates, setTemplates] = useState<EmailTemplateSummary[]>([]);
    const [layout, setLayout] = useState<EmailLayoutSettings | null>(null);
    const [layoutDraft, setLayoutDraft] = useState<EmailLayoutSettings | null>(null);
    const [selected, setSelected] = useState<string>("");
    const [detail, setDetail] = useState<EmailTemplateDetail | null>(null);
    const [lang, setLang] = useState<EmailLang>("en");
    const [draft, setDraft] = useState<EmailTemplateText>({ subject: "", body: "", actionLabel: "" });
    const [editorKey, setEditorKey] = useState(0);
    const [currentPassword, setCurrentPassword] = useState("");
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [savingLayout, setSavingLayout] = useState(false);
    const [preview, setPreview] = useState<EmailRendered | null>(null);
    const [previewView, setPreviewView] = useState<"html" | "text">("html");
    const [previewWidth, setPreviewWidth] = useState<"desktop" | "mobile">("desktop");
    const [previewScheme, setPreviewScheme] = useState<"light" | "dark">("light");
    const insertRef = useRef<InsertAtCaret | null>(null);
    const subjectRef = useRef<HTMLInputElement | null>(null);
    const lastFocus = useRef<"subject" | "body">("body");
    const editorTop = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        emailTemplatesApi.list().then((r) => {
            setTemplates(r.templates);
            setLayout(r.layout);
            setLayoutDraft(r.layout);
            setLang(r.siteLanguage);
            if (r.templates.length) setSelected(r.templates[0].id);
        }).catch((e: any) => addToast(e?.message || t("emails.loadFailed"), "error"));
    }, []);

    const loadDraft = useCallback((d: EmailTemplateDetail, l: EmailLang) => {
        const v = d.languages[l];
        setDraft({ subject: v.subject, body: v.body, actionLabel: v.actionLabel });
        setEditorKey((k) => k + 1);
    }, []);

    useEffect(() => {
        if (!selected) return;
        let alive = true;
        emailTemplatesApi.get(selected).then((d) => {
            if (!alive) return;
            setDetail(d);
            loadDraft(d, lang);
        }).catch((e: any) => addToast(e?.message || t("emails.loadFailed"), "error"));
        return () => { alive = false; };
    }, [selected]);

    const switchLang = (l: EmailLang) => {
        setLang(l);
        if (detail) loadDraft(detail, l);
    };

    // The live preview: the unsaved draft and layout, rendered by the server in the real layout.
    useEffect(() => {
        if (!detail || !layoutDraft) return;
        const timer = setTimeout(() => {
            emailTemplatesApi.preview(detail.id, lang, draft, layoutDraft).then(setPreview).catch(() => { /* keep the last preview */ });
        }, 400);
        return () => clearTimeout(timer);
    }, [detail, lang, draft, layoutDraft]);

    const current = detail ? detail.languages[lang] : null;
    const dirty = !!current && (draft.subject !== current.subject || draft.body !== current.body || draft.actionLabel !== current.actionLabel);

    const updateSummary = (d: EmailTemplateDetail) => {
        setDetail(d);
        setTemplates((list) => list.map((x) => (x.id === d.id ? { ...x, customized: d.customized } : x)));
    };

    const needPassword = () => {
        if (!detail?.security || currentPassword) return false;
        addToast(t("emails.currentPasswordRequired"), "error");
        return true;
    };

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!detail || needPassword()) return;
        setSaving(true);
        try {
            const d = await emailTemplatesApi.save(detail.id, lang, { ...draft, currentPassword: detail.security ? currentPassword : undefined });
            updateSummary(d);
            loadDraft(d, lang);
            setCurrentPassword("");
            addToast(t("emails.saved"), "success");
        } catch (err: any) {
            addToast(err?.message || t("emails.saveFailed"), "error");
        } finally {
            setSaving(false);
        }
    };

    const resetToDefault = async () => {
        if (!detail || needPassword()) return;
        if (!(await confirm(t("emails.resetConfirm").replace("{lang}", t(`emails.lang.${lang}`)), t("emails.reset"), true))) return;
        try {
            const d = await emailTemplatesApi.reset(detail.id, lang, detail.security ? currentPassword : undefined);
            updateSummary(d);
            loadDraft(d, lang);
            setCurrentPassword("");
            addToast(t("emails.resetDone"), "success");
        } catch (err: any) {
            addToast(err?.message || t("emails.saveFailed"), "error");
        }
    };

    const sendTest = async () => {
        if (!detail) return;
        setTesting(true);
        try {
            const r = await emailTemplatesApi.test(detail.id, lang, draft);
            addToast(t("emails.testSent").replace("{to}", r.to), "success");
        } catch (err: any) {
            addToast(err?.message || t("emails.testFailed"), "error");
        } finally {
            setTesting(false);
        }
    };

    const insertPlaceholder = (key: string) => {
        const token = `{${key}}`;
        if (lastFocus.current === "subject" && subjectRef.current) {
            const el = subjectRef.current;
            const start = el.selectionStart ?? draft.subject.length;
            const end = el.selectionEnd ?? start;
            const next = draft.subject.slice(0, start) + token + draft.subject.slice(end);
            setDraft((d) => ({ ...d, subject: next }));
            requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length); });
            return;
        }
        if (insertRef.current && insertRef.current(token)) return;
        addToast(t("emails.placeholderPlaceCaret"), "info");
    };

    const saveLayout = async () => {
        if (!layoutDraft) return;
        setSavingLayout(true);
        try {
            const l = await emailTemplatesApi.saveLayout(layoutDraft);
            setLayout(l);
            setLayoutDraft(l);
            addToast(t("emails.layoutSaved"), "success");
        } catch (err: any) {
            addToast(err?.message || t("emails.saveFailed"), "error");
        } finally {
            setSavingLayout(false);
        }
    };

    const grouped = useMemo(() => GROUPS.map((g) => ({ group: g, items: templates.filter((x) => x.group === g) })).filter((g) => g.items.length), [templates]);
    const layoutDirty = !!layout && !!layoutDraft && JSON.stringify({ ...layout, themeAccent: undefined }) !== JSON.stringify({ ...layoutDraft, themeAccent: undefined });

    return (
        <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader title={t("emails.title")} subtitle={t("emails.subtitle")} icon="fa-envelope-open-text" />

            <div className="grid grid-cols-1 xl:grid-cols-[18rem_minmax(0,1fr)] gap-6">
                <Card variant="default" padding="md" className="self-start">
                    <nav aria-label={t("emails.messages")}>
                        {grouped.map(({ group, items }) => (
                            <div key={group} className="mb-4 last:mb-0">
                                <h2 className="px-2 mb-1 text-xs font-black uppercase tracking-widest text-gray-400">{t(`emails.group.${group}`)}</h2>
                                <ul className="space-y-1">
                                    {items.map((x) => (
                                        <li key={x.id}>
                                            <UnstyledButton
                                                onClick={() => {
                                                    setSelected(x.id);
                                                    // Below xl the list sits above the editor: bring the editor into view.
                                                    if (!window.matchMedia("(min-width: 1280px)").matches) {
                                                        requestAnimationFrame(() => editorTop.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
                                                    }
                                                }}
                                                aria-current={x.id === selected ? "true" : undefined}
                                                className={`w-full rounded-xl px-3 py-2 text-left transition-colors ${x.id === selected ? "bg-blue-50 text-blue-900" : "hover:bg-gray-50 text-gray-800"}`}
                                            >
                                                <span className="flex items-center gap-2 text-sm font-semibold">
                                                    {x.security && <i className="fa-solid fa-lock text-[11px] text-gray-400" aria-label={t("emails.securityBadge")}></i>}
                                                    <span className="min-w-0 flex-1 truncate">{x.name[uiLang]}</span>
                                                    {x.customized.length > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">{t("emails.edited")}</span>}
                                                </span>
                                                <span className="mt-0.5 block text-xs text-gray-500 line-clamp-2">{x.description[uiLang]}</span>
                                            </UnstyledButton>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </nav>
                </Card>

                <div ref={editorTop} className="space-y-6 min-w-0 scroll-mt-4">
                    {detail && current && (
                        <Card variant="default" padding="lg">
                            <form onSubmit={save} className="space-y-5">
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                    <div className="min-w-0">
                                        <h2 className="text-lg font-bold text-gray-900">{detail.name[uiLang]}</h2>
                                        <p className="text-sm text-gray-500 mt-1">{detail.description[uiLang]}</p>
                                    </div>
                                    <SegmentedControl
                                        aria-label={t("emails.language")}
                                        options={LANGS.map((l) => ({ value: l, label: `${t(`emails.lang.${l}`)}${detail.customized.includes(l) ? " •" : ""}` }))}
                                        value={lang}
                                        onChange={switchLang}
                                    />
                                </div>

                                <Input
                                    ref={subjectRef}
                                    label={t("emails.subject")}
                                    value={draft.subject}
                                    maxLength={200}
                                    required
                                    onFocus={() => { lastFocus.current = "subject"; }}
                                    onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
                                />

                                <div onFocus={() => { lastFocus.current = "body"; }}>
                                    <Field
                                        label={t("emails.body")}
                                        help={detail.noLinks ? t("emails.noLinksHelp") : t("emails.bodyHelp")}
                                        controlId="email-body"
                                        labelId="email-body-label"
                                        helpId="email-body-help"
                                    >
                                        <EmailBodyEditor
                                            key={`${detail.id}-${lang}-${editorKey}`}
                                            id={`${detail.id}-${lang}`}
                                            initialValue={draft.body}
                                            insertRef={insertRef}
                                            labelledBy="email-body-label"
                                            describedBy="email-body-help"
                                            onChange={(html) => setDraft((d) => ({ ...d, body: html }))}
                                        />
                                    </Field>
                                </div>

                                <div>
                                    <span className={LABEL_CLASS}>{t("emails.placeholders")}</span>
                                    <div className="flex flex-wrap gap-2">
                                        {detail.placeholders.map((p) => (
                                            <Button
                                                key={p.key}
                                                size="sm"
                                                variant="secondary"
                                                className="!normal-case !tracking-normal"
                                                title={p.label[uiLang]}
                                                // Keep the caret where it is: the chip inserts at the last place written in.
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => insertPlaceholder(p.key)}
                                            >
                                                <code className="text-xs font-semibold text-blue-700">{`{${p.key}}`}</code>
                                                <span className="ml-1.5 text-xs font-medium text-gray-500">{p.label[uiLang]}</span>
                                            </Button>
                                        ))}
                                    </div>
                                    <p className={HELP_CLASS}>{t("emails.placeholdersHelp")}</p>
                                </div>

                                {detail.hasAction && (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
                                        <Input
                                            label={t("emails.actionLabel")}
                                            value={draft.actionLabel}
                                            maxLength={80}
                                            required
                                            onChange={(e) => setDraft((d) => ({ ...d, actionLabel: e.target.value }))}
                                        />
                                        <p className="flex items-start gap-2 rounded-xl bg-gray-50 px-3 py-2.5 text-xs text-gray-600 md:mt-7">
                                            <i className="fa-solid fa-lock mt-0.5 text-gray-400" aria-hidden="true"></i>
                                            <span>{t("emails.actionLocked")}</span>
                                        </p>
                                    </div>
                                )}

                                {detail.security && (
                                    <Input
                                        type="password"
                                        autoComplete="current-password"
                                        label={t("emails.currentPassword")}
                                        help={t("emails.currentPasswordHelp")}
                                        value={currentPassword}
                                        onChange={(e) => setCurrentPassword(e.target.value)}
                                    />
                                )}

                                <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-gray-100">
                                    <Button type="submit" variant="primary" size="md" pending={saving} pendingLabel={t("emails.saving")} disabled={!dirty}>
                                        {t("emails.save")}
                                    </Button>
                                    <Button variant="secondary" size="md" icon="fa-paper-plane" pending={testing} pendingLabel={t("emails.testing")} onClick={sendTest}>
                                        {t("emails.sendTest")}
                                    </Button>
                                    <Button variant="ghost" size="md" icon="fa-rotate-left" disabled={!current.customized} onClick={resetToDefault}>
                                        {t("emails.reset")}
                                    </Button>
                                    {dirty && <span className="text-xs text-amber-700">{t("emails.unsaved")}</span>}
                                </div>
                            </form>
                        </Card>
                    )}

                    {detail && (
                        <Card variant="default" padding="lg">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
                                <h2 className="text-xs font-black uppercase tracking-widest text-gray-400">{t("emails.preview")}</h2>
                                <div className="flex flex-wrap gap-2">
                                    <SegmentedControl
                                        size="sm"
                                        aria-label={t("emails.previewWidth")}
                                        options={[{ value: "desktop", label: t("emails.previewDesktop"), icon: "fa-desktop" }, { value: "mobile", label: t("emails.previewMobile"), icon: "fa-mobile-screen" }]}
                                        value={previewWidth}
                                        onChange={setPreviewWidth}
                                    />
                                    <SegmentedControl
                                        size="sm"
                                        aria-label={t("emails.previewScheme")}
                                        options={[{ value: "light", label: t("emails.previewLight"), icon: "fa-sun" }, { value: "dark", label: t("emails.previewDark"), icon: "fa-moon" }]}
                                        value={previewScheme}
                                        onChange={setPreviewScheme}
                                    />
                                </div>
                            </div>
                            <Tabs
                                aria-label={t("emails.preview")}
                                listClassName="overflow-y-hidden"
                                tabs={[{ value: "html", label: t("emails.previewHtml") }, { value: "text", label: t("emails.previewText") }]}
                                value={previewView}
                                onChange={setPreviewView}
                            >
                                {preview && (
                                    <div className="pt-4">
                                        <p className="mb-3 text-sm"><span className="text-gray-500">{t("emails.subject")}:</span> <strong className="text-gray-900">{preview.subject}</strong></p>
                                        {previewView === "html" ? (
                                            <div className="flex justify-center rounded-xl bg-gray-100 p-2 sm:p-4">
                                                {/* The height sits on the wrapper: the admin stylesheet makes every iframe 100% tall. */}
                                                <div className="transition-all" style={{ width: previewWidth === "mobile" ? 375 : "100%", maxWidth: "100%", height: 600 }}>
                                                    <iframe
                                                        title={t("emails.preview")}
                                                        // No scripts, no same-origin: the message is shown, never run.
                                                        sandbox=""
                                                        srcDoc={preview.html}
                                                        className="h-full w-full rounded-lg border border-gray-200"
                                                        // A frame's prefers-color-scheme follows the colour scheme of its element:
                                                        // this is how the message looks in a mail app set to dark.
                                                        style={{ colorScheme: previewScheme }}
                                                    />
                                                </div>
                                            </div>
                                        ) : (
                                            <pre className="whitespace-pre-wrap break-words rounded-xl bg-gray-900 p-4 text-sm leading-relaxed text-gray-100">{preview.text}</pre>
                                        )}
                                    </div>
                                )}
                            </Tabs>
                        </Card>
                    )}

                    {layoutDraft && (
                        <Card variant="default" padding="lg">
                            <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-1">{t("emails.layout")}</h2>
                            <p className="text-sm text-gray-500 mb-5">{t("emails.layoutHelp")}</p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                <ColorInput
                                    label={t("emails.accentColor")}
                                    help={t("emails.accentColorHelp").replace("{color}", layoutDraft.themeAccent || "")}
                                    // Empty means "the theme's colour": the swatch shows that colour, and picking it again keeps it empty.
                                    value={layoutDraft.accentColor || layoutDraft.themeAccent || ""}
                                    onChange={(v) => setLayoutDraft((l) => (l ? { ...l, accentColor: v === l.themeAccent ? "" : v } : l))}
                                />
                                <ColorInput
                                    label={t("emails.backgroundColor")}
                                    help={t("emails.backgroundColorHelp")}
                                    value={layoutDraft.backgroundColor || DEFAULT_BACKGROUND}
                                    onChange={(v) => setLayoutDraft((l) => (l ? { ...l, backgroundColor: v === DEFAULT_BACKGROUND ? "" : v } : l))}
                                />
                                <Input
                                    label={t("emails.footerText")}
                                    help={t("emails.footerTextHelp")}
                                    value={layoutDraft.footerText}
                                    maxLength={200}
                                    onChange={(e) => setLayoutDraft((l) => (l ? { ...l, footerText: e.target.value } : l))}
                                />
                                <Switch
                                    label={t("emails.showLogo")}
                                    help={t("emails.showLogoHelp")}
                                    checked={layoutDraft.showLogo}
                                    onChange={(v) => setLayoutDraft((l) => (l ? { ...l, showLogo: v } : l))}
                                />
                            </div>
                            <div className="mt-5 flex flex-wrap items-center gap-3">
                                <Button variant="primary" size="md" pending={savingLayout} pendingLabel={t("emails.saving")} disabled={!layoutDirty} onClick={saveLayout}>
                                    {t("emails.saveLayout")}
                                </Button>
                                {(layoutDraft.accentColor || layoutDraft.backgroundColor) && (
                                    <Button variant="ghost" size="md" onClick={() => setLayoutDraft((l) => (l ? { ...l, accentColor: "", backgroundColor: "" } : l))}>
                                        {t("emails.useThemeColors")}
                                    </Button>
                                )}
                                <Link href="/admin/settings/email" className="text-sm font-semibold text-blue-600 hover:underline">{t("emails.deliveryLink")}</Link>
                            </div>
                        </Card>
                    )}
                </div>
            </div>
        </div>
    );
}
