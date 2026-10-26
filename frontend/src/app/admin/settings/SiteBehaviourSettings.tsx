"use client";

/**
 * The settings the API accepted with no control in the panel (QA M2-06): the posts page, the feed size,
 * search-engine visibility, the date and time formats, the defaults for new entries, the comment
 * moderation rules and the image sizes. Each one now has a reader (see backend/src/routes/settings.ts and
 * the comment/post/seo routes), so what is set here changes what the site does.
 *
 * Rendered by the settings page, which owns the state and saves it with everything else.
 */
import { useEffect, useState } from "react";
import { categoriesApi, type Category, type Post } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import ModernSelect from "@/components/ModernSelect";

export interface SiteBehaviourValues {
    page_for_posts: string;
    posts_per_rss: string;
    blog_public: string;
    robots_txt_extra: string;
    date_format: string;
    time_format: string;
    default_category: string;
    default_comment_status: string;
    comment_moderation: string;
    comment_previously_approved: string;
    comment_max_links: string;
    require_name_email: string;
    thumbnail_size_w: string;
    thumbnail_size_h: string;
    medium_size_w: string;
    medium_size_h: string;
    large_size_w: string;
    large_size_h: string;
}

export const SITE_BEHAVIOUR_DEFAULTS: SiteBehaviourValues = {
    page_for_posts: "",
    posts_per_rss: "20",
    blog_public: "1",
    robots_txt_extra: "",
    date_format: "",
    time_format: "",
    default_category: "",
    default_comment_status: "open",
    comment_moderation: "1",
    comment_previously_approved: "1",
    comment_max_links: "2",
    require_name_email: "1",
    thumbnail_size_w: "150",
    thumbnail_size_h: "150",
    medium_size_w: "300",
    medium_size_h: "300",
    large_size_w: "1024",
    large_size_h: "1024",
};

/** The stored values, read the way the server normalizes them ("1"/"0" booleans, numbers as strings). */
export function siteBehaviourFrom(data: Record<string, unknown>): SiteBehaviourValues {
    const out = { ...SITE_BEHAVIOUR_DEFAULTS };
    for (const key of Object.keys(out) as Array<keyof SiteBehaviourValues>) {
        const v = data[key];
        if (v === undefined || v === null) continue;
        if (typeof v === "boolean") out[key] = v ? "1" : "0";
        else out[key] = String(v);
    }
    return out;
}

const DATE_FORMATS = ["F j, Y", "M j, Y", "j F Y", "Y-m-d", "m/d/Y", "d/m/Y"];
const TIME_FORMATS = ["g:i a", "H:i"];

/** How a WordPress date format renders today, for the option label. */
function sampleDate(format: string): string {
    const d = new Date();
    const months = d.toLocaleString("en", { month: "long" });
    const short = d.toLocaleString("en", { month: "short" });
    const pad = (n: number) => String(n).padStart(2, "0");
    return format.replace(/[FMjdmY]/g, (c) => ({ F: months, M: short, j: String(d.getDate()), d: pad(d.getDate()), m: pad(d.getMonth() + 1), Y: String(d.getFullYear()) } as Record<string, string>)[c]);
}

const inputCls = "w-full px-4 py-3.5 bg-gray-50/50 border border-gray-200 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none";
const cardCls = "bg-white rounded-3xl md:rounded-[40px] shadow-xl shadow-gray-100/50 border-2 border-gray-50 overflow-hidden";

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
    return (
        <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${checked ? "bg-blue-600" : "bg-gray-200"}`}>
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform duration-200 ease-in-out ${checked ? "translate-x-6" : "translate-x-1"}`} />
        </button>
    );
}

function SwitchRow({ label, help, checked, onChange }: { label: string; help?: string; checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
                <p className="text-sm font-bold text-gray-800">{label}</p>
                {help && <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{help}</p>}
            </div>
            <Switch checked={checked} onChange={onChange} label={label} />
        </div>
    );
}

interface Props {
    values: SiteBehaviourValues;
    onChange: (next: SiteBehaviourValues) => void;
    pages: Post[];
    /** The static front page, if any: the posts page applies only with one. */
    homepageId: string;
}

/** Settings → Reading: posts page, feed size, search engines, robots.txt rules. */
export function ReadingExtras({ values, onChange, pages, homepageId }: Props) {
    const { t } = useI18n();
    const set = (patch: Partial<SiteBehaviourValues>) => onChange({ ...values, ...patch });
    return (
        <div className="space-y-6 pt-2" data-testid="settings-reading-extras">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="space-y-2">
                    <ModernSelect
                        label={t("settings.postsPage")}
                        value={values.page_for_posts}
                        onChange={(e) => set({ page_for_posts: e.target.value })}
                        options={[
                            { value: "", label: t("settings.postsPage.none") },
                            ...pages.filter((p) => String(p.id) !== homepageId).map((p) => ({ value: String(p.id), label: p.title })),
                        ]}
                    />
                    <p className="text-xs text-gray-500">{homepageId ? t("settings.postsPage.help") : t("settings.postsPage.needsFrontPage")}</p>
                </div>
                <div className="space-y-2">
                    <label htmlFor="settings-posts-per-rss" className="text-sm font-bold text-gray-700">{t("settings.postsPerRss")}</label>
                    <input id="settings-posts-per-rss" type="number" min={1} max={100} value={values.posts_per_rss}
                        onChange={(e) => set({ posts_per_rss: e.target.value })} className={inputCls} />
                </div>
            </div>
            <div className="p-5 bg-amber-50/50 rounded-2xl border border-amber-100">
                <SwitchRow
                    label={t("settings.blogPublic")}
                    help={t("settings.blogPublic.help")}
                    checked={values.blog_public === "0"}
                    onChange={(discourage) => set({ blog_public: discourage ? "0" : "1" })}
                />
            </div>
            <div className="space-y-2">
                <label htmlFor="settings-robots-extra" className="text-sm font-bold text-gray-700">{t("settings.robotsExtra")}</label>
                <textarea id="settings-robots-extra" rows={5} maxLength={5000} spellCheck={false}
                    value={values.robots_txt_extra} onChange={(e) => set({ robots_txt_extra: e.target.value })}
                    placeholder={"User-agent: GPTBot\nDisallow: /"}
                    disabled={values.blog_public === "0"}
                    className={`${inputCls} font-mono text-sm disabled:opacity-50`} />
                <p className="text-xs text-gray-500">
                    {values.blog_public === "0" ? t("settings.robotsExtra.discouraged") : t("settings.robotsExtra.help")}{" "}
                    <a href="/robots.txt" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">/robots.txt</a>
                </p>
            </div>
        </div>
    );
}

/** Settings → General: date and time formats. */
export function DateTimeFormats({ values, onChange }: Pick<Props, "values" | "onChange">) {
    const { t } = useI18n();
    return (
        <>
            <div className="space-y-2">
                <ModernSelect
                    label={t("settings.dateFormat")}
                    value={values.date_format}
                    onChange={(e) => onChange({ ...values, date_format: e.target.value })}
                    options={[{ value: "", label: t("settings.dateFormat.language") }, ...DATE_FORMATS.map((f) => ({ value: f, label: sampleDate(f) }))]}
                />
            </div>
            <div className="space-y-2">
                <ModernSelect
                    label={t("settings.timeFormat")}
                    value={values.time_format}
                    onChange={(e) => onChange({ ...values, time_format: e.target.value })}
                    options={[{ value: "", label: t("settings.timeFormat.none") }, ...TIME_FORMATS.map((f) => ({ value: f, label: f === "H:i" ? "17:30" : "5:30 pm" }))]}
                />
                <p className="text-xs text-gray-400 mt-1">{t("settings.timeFormat.help")}</p>
            </div>
        </>
    );
}

/** Settings → Writing & Discussion: defaults for new entries and the comment moderation rules. */
export function WritingDiscussion({ values, onChange }: Pick<Props, "values" | "onChange">) {
    const { t } = useI18n();
    const [categories, setCategories] = useState<Category[]>([]);
    useEffect(() => {
        categoriesApi.listAll().then((r) => setCategories(r.data)).catch(() => { /* the select keeps "default" */ });
    }, []);
    const set = (patch: Partial<SiteBehaviourValues>) => onChange({ ...values, ...patch });
    return (
        <div className={cardCls} data-testid="settings-writing-discussion">
            <div className="px-8 py-6 border-b border-gray-50 bg-gray-50/30">
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                    <i className="fa-solid fa-pen-nib text-indigo-500" aria-hidden="true"></i> {t("settings.writing.title")}
                </h2>
            </div>
            <div className="p-8 space-y-8">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="space-y-2">
                        <ModernSelect
                            label={t("settings.defaultCategory")}
                            value={values.default_category}
                            onChange={(e) => set({ default_category: e.target.value })}
                            options={[{ value: "", label: t("settings.defaultCategory.first") }, ...categories.map((c) => ({ value: String(c.id), label: c.name }))]}
                        />
                    </div>
                    <div className="space-y-2">
                        <ModernSelect
                            label={t("settings.defaultCommentStatus")}
                            value={values.default_comment_status}
                            onChange={(e) => set({ default_comment_status: e.target.value })}
                            options={[{ value: "open", label: t("settings.defaultCommentStatus.open") }, { value: "closed", label: t("settings.defaultCommentStatus.closed") }]}
                        />
                    </div>
                </div>
                <div className="space-y-5">
                    <SwitchRow label={t("settings.requireNameEmail")} checked={values.require_name_email === "1"} onChange={(v) => set({ require_name_email: v ? "1" : "0" })} />
                    <SwitchRow label={t("settings.commentModeration")} help={t("settings.commentModeration.help")} checked={values.comment_moderation === "1"} onChange={(v) => set({ comment_moderation: v ? "1" : "0" })} />
                    {values.comment_moderation !== "1" && (
                        <div className="pl-4 border-l-2 border-gray-100 space-y-5">
                            <SwitchRow label={t("settings.commentPreviouslyApproved")} checked={values.comment_previously_approved === "1"} onChange={(v) => set({ comment_previously_approved: v ? "1" : "0" })} />
                            <div className="space-y-2 max-w-xs">
                                <label htmlFor="settings-comment-max-links" className="text-sm font-bold text-gray-700">{t("settings.commentMaxLinks")}</label>
                                <input id="settings-comment-max-links" type="number" min={0} max={100} value={values.comment_max_links}
                                    onChange={(e) => set({ comment_max_links: e.target.value })} className={inputCls} />
                                <p className="text-xs text-gray-500">{t("settings.commentMaxLinks.help")}</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

/** Settings → Media: the sizes the image derivatives are made at. */
export function ImageSizes({ values, onChange }: Pick<Props, "values" | "onChange">) {
    const { t } = useI18n();
    const rows: Array<[string, keyof SiteBehaviourValues, keyof SiteBehaviourValues]> = [
        [t("settings.imageSizes.thumbnail"), "thumbnail_size_w", "thumbnail_size_h"],
        [t("settings.imageSizes.medium"), "medium_size_w", "medium_size_h"],
        [t("settings.imageSizes.large"), "large_size_w", "large_size_h"],
    ];
    return (
        <div className="px-8 pb-8 space-y-3" data-testid="settings-image-sizes">
            <h3 className="text-sm font-bold text-gray-700">{t("settings.imageSizes")}</h3>
            <p className="text-xs text-gray-500">{t("settings.imageSizes.help")}</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {rows.map(([label, w, h]) => (
                    <fieldset key={w} className="space-y-2">
                        <legend className="text-xs font-bold text-gray-600">{label}</legend>
                        <div className="flex items-center gap-2">
                            <input type="number" min={0} max={4000} aria-label={label + " — " + t("settings.imageSizes.width")} value={values[w]}
                                onChange={(e) => onChange({ ...values, [w]: e.target.value })} className={inputCls} />
                            <span className="text-gray-400" aria-hidden="true">×</span>
                            <input type="number" min={0} max={4000} aria-label={label + " — " + t("settings.imageSizes.height")} value={values[h]}
                                onChange={(e) => onChange({ ...values, [h]: e.target.value })} className={inputCls} />
                        </div>
                    </fieldset>
                ))}
            </div>
        </div>
    );
}
