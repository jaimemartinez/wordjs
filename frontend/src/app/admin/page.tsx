"use client";

import { useEffect, useState } from "react";
import { postsApi, usersApi, systemApi, api, apiGetPaged, Comment, SystemStatus } from "@/lib/api";
import { parseServerDate } from "@/lib/serverDate";
import { useAuth } from "@/contexts/AuthContext";
import { useI18n } from "@/contexts/I18nContext";
import { sanitizeHTML } from "@/lib/sanitize";
import { canOpenAdminPath } from "@/lib/adminAccess";
import {
    dashboardSections, STAT_GRID_COLS, HEALTH_GRID_CLASS, QUICK_ACTIONS_GRID_CLASS, DASHBOARD_COLUMNS_CLASS, dashboardMainSpanClass,
    HEALTH_LABEL_ROW_CLASS, HEALTH_LABEL_CLASS, HEALTH_DOT_CLASS, type DashboardStatKey,
} from "@/lib/dashboardStats";

interface Stats {
    posts: number;
    pages: number;
    comments: number;
    users: number;
}

interface ChartData {
    name: string;
    traffic: number;
    engagement: number;
}

import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

// Local initials avatar — no external avatar-service request. Deterministic gradient pick
// via a simple char-code hash (Tailwind needs literal class names, hence the map).
const AVATAR_GRADIENTS = [
    "from-blue-500 to-indigo-600",
    "from-purple-500 to-pink-600",
    "from-emerald-500 to-teal-600",
    "from-orange-500 to-amber-600",
];

const InitialsAvatar = ({ name }: { name: string }) => {
    const initials = (name || "").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
    let hash = 0;
    for (let i = 0; i < (name || "").length; i++) hash = (hash + name.charCodeAt(i)) % AVATAR_GRADIENTS.length;
    return (
        <div
            className={`w-10 h-10 shrink-0 rounded-xl shadow-sm bg-gradient-to-br ${AVATAR_GRADIENTS[hash]} flex items-center justify-center text-white text-sm font-black select-none`}
            aria-hidden="true"
        >
            {initials}
        </div>
    );
};

// Premium Stat Card Component
const StatCard = ({ statKey, label, value, icon, gradient }: { statKey: DashboardStatKey, label: string, value: number, icon: string, color: string, gradient: string }) => (
    <div data-dashboard-stat={statKey} className="group relative overflow-hidden bg-white rounded-3xl sm:rounded-[40px] p-5 sm:p-8 border-2 border-gray-50 shadow-xl shadow-gray-100/50 hover:shadow-2xl hover:shadow-blue-500/10 hover:-translate-y-2 transition-all duration-500">
        {/* Background Blob */}
        <div aria-hidden="true" className={`pointer-events-none absolute -right-10 -top-10 w-40 h-40 bg-gradient-to-br ${gradient} rounded-full blur-[60px] opacity-20 group-hover:opacity-40 transition-opacity duration-700`}></div>

        {/* A row (icon beside the count) on a phone, where a stacked card was a screen tall per number. */}
        <div className="relative z-10 flex items-center gap-4 sm:block">
            <div aria-hidden="true" className={`w-12 h-12 sm:w-16 sm:h-16 shrink-0 rounded-2xl sm:rounded-3xl bg-gradient-to-br ${gradient} flex items-center justify-center text-white text-xl sm:text-2xl sm:mb-6 shadow-lg shadow-gray-200 group-hover:scale-110 transition-transform duration-500`}>
                <i className={`fa-solid ${icon}`}></i>
            </div>
            <div className="min-w-0">
                <h3 className="text-3xl sm:text-4xl font-black text-gray-900 italic tracking-tighter mb-1">{value}</h3>
                <p className="text-[11px] uppercase font-black tracking-widest text-gray-500 group-hover:text-gray-600 transition-colors break-words">{label}</p>
            </div>
        </div>
    </div>
);

// Premium Quick Action Component
const QuickAction = ({ href, icon, label, subLabel, color }: { href: string, icon: string, label: string, subLabel: string, color: string }) => (
    <a href={href} className="group relative flex items-center gap-4 sm:gap-6 p-4 sm:p-6 bg-white rounded-3xl sm:rounded-[40px] border-2 border-gray-50 hover:border-blue-200 shadow-xl shadow-gray-100/50 hover:shadow-2xl hover:shadow-blue-500/10 hover:-translate-y-1 transition-all duration-500">
        <div className={`w-12 h-12 shrink-0 rounded-2xl ${color} flex items-center justify-center text-white text-lg shadow-md group-hover:scale-110 transition-transform`}>
            <i className={`fa-solid ${icon}`}></i>
        </div>
        <div className="min-w-0" data-quick-action-text="">
            <h4 className="font-bold text-gray-900 text-sm group-hover:text-blue-600 transition-colors break-words">{label}</h4>
            <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mt-0.5 break-words">{subLabel}</p>
        </div>
        <div className="absolute right-6 opacity-0 group-hover:opacity-100 transition-opacity -translate-x-4 group-hover:translate-x-0 duration-300 pointer-events-none">
            <i className="fa-solid fa-arrow-right text-gray-300"></i>
        </div>
    </a>
);

const HealthIndicator = ({ label, status, detail, icon }: { label: string, status: string, detail: string, icon: string }) => {
    const isOk = status === 'OK';
    const color = isOk ? 'emerald' : (status === 'WARNING' ? 'amber' : 'rose');
    const C = {
        emerald: { bg: 'bg-emerald-100', text: 'text-emerald-600', dot: 'bg-emerald-500' },
        amber: { bg: 'bg-amber-100', text: 'text-amber-600', dot: 'bg-amber-500' },
        rose: { bg: 'bg-rose-100', text: 'text-rose-600', dot: 'bg-rose-500' },
    }[color];

    return (
        <div className="flex items-center gap-4 p-4 rounded-3xl bg-gray-50 border border-gray-100 group hover:bg-white hover:shadow-xl transition-all duration-300">
            <div className={`w-10 h-10 shrink-0 rounded-2xl ${C.bg} ${C.text} flex items-center justify-center text-sm shadow-sm group-hover:scale-110 transition-transform`}>
                <i className={`fa-solid ${icon}`}></i>
            </div>
            <div className="flex-1 min-w-0">
                {/* The label wraps between words only and the dot keeps its gap (lib/dashboardStats.ts). */}
                <div className={HEALTH_LABEL_ROW_CLASS}>
                    <p className={HEALTH_LABEL_CLASS} data-health-label="">{label}</p>
                    <span className={`${HEALTH_DOT_CLASS} ${C.dot} animate-pulse`} data-health-dot=""></span>
                </div>
                {/* Wraps between words instead of being cut («Conectado (…», «Certificados …»); `break-words`
                    only ever splits a token longer than the whole line, such as a path in an error message. */}
                <p className="text-xs font-bold text-gray-700 break-words" data-health-detail="">{detail}</p>
            </div>
        </div>
    );
};

export default function DashboardPage() {
    const { user, can } = useAuth();
    const { t } = useI18n();

    // Access gate: the dashboard is for content managers. A subscriber (no edit_posts) must never see
    // dashboard data — not even by typing the URL. The admin layout's route guard (lib/adminAccess.ts)
    // never renders this page for them and sends them to the first page their sidebar offers (their
    // account page, or a plugin screen their role opens); this flag only keeps the data loads below
    // from ever firing for such a user.
    const allowed = can('edit_posts');
    // The dashboard's shortcuts lead only to screens this user may open (lib/adminAccess.ts): a link the
    // route guard refuses would just flash the loading screen and come back. Core paths only, so the
    // plugin menu is not needed to decide.
    const mayOpen = (href: string) => canOpenAdminPath(href, user, []);
    // Only the numbers and panels this viewer can actually read (lib/dashboardStats.ts): an editor
    // cannot list users, so a «0 USUARIOS» card was a number made up by the page, not by the site.
    const sections = dashboardSections(user, can);

    // Core Dashboard State
    const [stats, setStats] = useState<Stats>({ posts: 0, pages: 0, comments: 0, users: 0 });
    const [recentComments, setRecentComments] = useState<Comment[]>([]);
    const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
    const [loading, setLoading] = useState(true);

    // Analytics State
    const [chartData, setChartData] = useState<ChartData[]>([]);
    const [chartPeriod, setChartPeriod] = useState<'weekly' | 'monthly'>('weekly');

    useEffect(() => {
        if (allowed) loadData();
    }, [allowed]);

    useEffect(() => {
        if (allowed && sections.activityChart) loadAnalytics();
    }, [chartPeriod, allowed, sections.activityChart]);

    const loadAnalytics = async () => {
        if (!sections.activityChart) return; // administrators only (GET /analytics/stats answers 403 otherwise)
        try {
            const data = await api(`/analytics/stats?period=${chartPeriod}`);
            setChartData(data as ChartData[]);
        } catch (e) {
            console.error('Failed to load analytics', e);
        }
    };

    const loadData = async () => {
        try {
            loadAnalytics();

            // COUNTS COME FROM X-WP-Total. They used to be `array.length` of the first page — "10 POSTS ·
            // 5 COMMENTS" on a site with 540 posts — and downloaded whole records (content included) just to
            // count them. One row per list is enough to read the total.
            const fetchUsers = sections.stats.includes('users') ? usersApi.listPaged({ perPage: 1 }).then((r) => r.total) : Promise.resolve(0);
            const fetchComments = sections.recentComments ? apiGetPaged<Comment[]>('/comments?per_page=5') : Promise.resolve({ data: [] as Comment[], total: 0, totalPages: 0 });
            // Administrators only, like its endpoint; and a failure here must not blank every count above.
            const fetchSystem = sections.systemHealth ? systemApi.getStatus().catch(() => null) : Promise.resolve(null);

            // ... (keep rest of function)

            const [posts, pages, users, comments, system] = await Promise.all([
                postsApi.listPaged({ type: "post", perPage: 1 }),
                postsApi.listPaged({ type: "page", perPage: 1 }),
                fetchUsers,
                fetchComments,
                fetchSystem
            ]);

            setStats({
                posts: posts.total,
                pages: pages.total,
                comments: comments.total || 0,
                users: users || 0,
            });
            setRecentComments(Array.isArray(comments.data) ? comments.data.slice(0, 5) : []);
            setSystemStatus(system);
        } catch (error) {
            console.error("Failed to load data:", error);
        } finally {
            setLoading(false);
        }
    };

    // Don't render dashboard content for users without access (redirect is in flight).
    if (!allowed) return null;

    return (
        <div className="@container px-4 py-6 sm:p-8 md:p-12 pb-20 space-y-8 md:space-y-12 animate-in fade-in duration-700 bg-gray-50 h-full w-full overflow-auto" data-dashboard-root="">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
                <div>
                    <h1 className="text-3xl sm:text-4xl md:text-5xl font-black text-gray-900 italic tracking-tighter mb-2">
                        {t('dashboard.overview')}
                    </h1>
                    <div className="flex items-center gap-2">
                        <div className="h-1 w-10 shrink-0 bg-blue-600 rounded-full"></div>
                        <p className="text-xs font-bold uppercase tracking-widest text-gray-500" data-dashboard-welcome="">
                            {t('dashboard.welcome.back')}, <span className="text-gray-600">{user?.displayName || user?.username || 'User'}</span>
                        </p>
                    </div>
                </div>

                {/* Health Overview (Mini) */}
                {systemStatus && (
                    <div className="hidden lg:flex shrink-0 items-center gap-4 px-6 py-3 bg-white rounded-full shadow-lg shadow-gray-200/50 border border-gray-100" data-dashboard-mini-pill="">
                        <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 shrink-0 rounded-full ${systemStatus.database.status === 'OK' ? 'bg-emerald-500' : 'bg-rose-500'} animate-pulse`}></span>
                            <span className="text-[11px] font-black uppercase tracking-widest text-gray-500 whitespace-nowrap" data-dashboard-mini-health="">DB: {systemStatus.database.driver}</span>
                        </div>
                        <div className="w-px h-4 bg-gray-200"></div>
                        <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 shrink-0 rounded-full ${systemStatus.mtls.status === 'OK' ? 'bg-emerald-500' : 'bg-rose-500'} animate-pulse`}></span>
                            <span className="text-[11px] font-black uppercase tracking-widest text-gray-500 whitespace-nowrap" data-dashboard-mini-health="">mTLS: {systemStatus.mtls.status}</span>
                        </div>
                    </div>
                )}
            </div>

            {/* Stats Grid — only the counts this viewer can read; columns by the grid's own width (@container) */}
            <div className="@container">
            <div className={`grid ${STAT_GRID_COLS[sections.stats.length] || STAT_GRID_COLS[4]} gap-6`} data-dashboard-stats="">
                {sections.stats.includes('posts') && <StatCard
                    statKey="posts"
                    label={t('nav.posts')}
                    value={stats.posts}
                    icon="fa-pen-to-square"
                    color="bg-blue-600"
                    gradient="from-blue-500 to-blue-700"
                />}
                {sections.stats.includes('pages') && <StatCard
                    statKey="pages"
                    label={t('nav.pages')}
                    value={stats.pages}
                    icon="fa-file-lines"
                    color="bg-indigo-600"
                    gradient="from-indigo-500 to-purple-700"
                />}
                {sections.stats.includes('comments') && <StatCard
                    statKey="comments"
                    label={t('nav.comments')}
                    value={stats.comments}
                    icon="fa-comments"
                    color="bg-amber-500"
                    gradient="from-amber-400 to-orange-600"
                />}
                {sections.stats.includes('users') && <StatCard
                    statKey="users"
                    label={t('nav.users')}
                    value={stats.users}
                    icon="fa-users"
                    color="bg-emerald-600"
                    gradient="from-emerald-400 to-teal-600"
                />}
            </div>
            </div>

            {/* Two columns by the page's own width (the root is the @container; lib/dashboardStats.ts) */}
            <div className={DASHBOARD_COLUMNS_CLASS} data-dashboard-columns="">
                {/* Main Content Area — the full width when there is no comments panel beside it */}
                <div className={`${dashboardMainSpanClass(sections.recentComments)} space-y-8`} data-dashboard-main="">
                    {/* System Health Detailed */}
                    {systemStatus && (
                        <div>
                            <div className="flex items-center gap-3 mb-6">
                                <span className="w-8 h-8 shrink-0 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center">
                                    <i className="fa-solid fa-heart-pulse text-sm"></i>
                                </span>
                                <h2 className="text-xl font-black text-gray-900 italic tracking-tight">{t('dashboard.system.health')}</h2>
                            </div>
                            <div className="@container">
                            <div className={HEALTH_GRID_CLASS} data-dashboard-health="">
                                <HealthIndicator
                                    label={t('dashboard.health.database')}
                                    status={systemStatus.database.status}
                                    detail={systemStatus.database.status === 'OK' ? `${t('dashboard.health.connected')} (${systemStatus.database.driver})` : systemStatus.database.message || t('dashboard.health.error')}
                                    icon="fa-database"
                                />
                                <HealthIndicator
                                    label={t('dashboard.health.security')}
                                    status={systemStatus.mtls.status}
                                    detail={systemStatus.mtls.status === 'OK' ? t('dashboard.health.certs.valid') : systemStatus.mtls.status}
                                    icon="fa-shield-halved"
                                />
                                <HealthIndicator
                                    label={t('dashboard.health.storage')}
                                    status="OK"
                                    detail={t('dashboard.health.writable')}
                                    icon="fa-folder-tree"
                                />
                            </div>
                            </div>
                        </div>
                    )}

                    {/* Quick Actions */}
                    <div>
                        <div className="flex items-center gap-3 mb-6">
                            <span className="w-8 h-8 shrink-0 rounded-xl bg-orange-100 text-orange-600 flex items-center justify-center">
                                <i className="fa-solid fa-bolt text-sm"></i>
                            </span>
                            <h2 className="text-xl font-black text-gray-900 italic tracking-tight">{t('dashboard.quick.actions')}</h2>
                        </div>
                        <div className="@container">
                        <div className={QUICK_ACTIONS_GRID_CLASS} data-dashboard-quick-actions="">
                            {mayOpen("/admin/posts/new") && <QuickAction
                                href="/admin/posts/new"
                                icon="fa-plus"
                                label={t('dashboard.new.post')}
                                subLabel={t('dashboard.new.post.sub')}
                                color="bg-blue-500"
                            />}
                            {mayOpen("/admin/pages/new") && <QuickAction
                                href="/admin/pages/new"
                                icon="fa-layer-group"
                                label={t('dashboard.new.page')}
                                subLabel={t('dashboard.new.page.sub')}
                                color="bg-indigo-500"
                            />}
                            {mayOpen("/admin/media") && <QuickAction
                                href="/admin/media"
                                icon="fa-cloud-arrow-up"
                                label={t('dashboard.add.media')}
                                subLabel={t('dashboard.add.media.sub')}
                                color="bg-purple-500"
                            />}
                            {mayOpen("/admin/users/new") && <QuickAction
                                href="/admin/users/new"
                                icon="fa-user-plus"
                                label={t('dashboard.add.user')}
                                subLabel={t('dashboard.add.user.sub')}
                                color="bg-emerald-500"
                            />}
                        </div>
                        </div>
                    </div>

                    {/* Chart/Graph — administrators only (so is its endpoint) */}
                    {sections.activityChart && (
                    <div data-dashboard-activity-chart="" className="bg-white rounded-3xl md:rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 p-10 relative overflow-hidden group hover:shadow-2xl transition-all duration-500">
                        <div className="absolute top-0 right-0 w-64 h-64 bg-gray-50 rounded-full blur-[80px] opacity-50 pointer-events-none"></div>
                        <div className="flex flex-wrap items-center justify-between gap-y-3 mb-8 relative z-10">
                            <div>
                                <h2 className="text-2xl font-black text-gray-900 italic tracking-tighter">{t('dashboard.activity.overview')}</h2>
                                <p className="text-[11px] font-bold uppercase tracking-widest text-gray-500 mt-1">{t('dashboard.traffic.engagement')}</p>
                            </div>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setChartPeriod('weekly')}
                                    className={`px-3 py-1 rounded-lg text-[11px] uppercase font-bold tracking-wider transition-colors ${chartPeriod === 'weekly' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                                >
                                    {t('dashboard.weekly')}
                                </button>
                                <button
                                    onClick={() => setChartPeriod('monthly')}
                                    className={`px-3 py-1 rounded-lg text-[11px] uppercase font-bold tracking-wider transition-colors ${chartPeriod === 'monthly' ? 'bg-gray-900 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                                >
                                    {t('dashboard.monthly')}
                                </button>
                            </div>
                        </div>

                        <div className="h-64 w-full">
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart
                                    data={chartData}
                                    margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                                >
                                    <defs>
                                        <linearGradient id="colorTraffic" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#2563eb" stopOpacity={0.3} />
                                            <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                                        </linearGradient>
                                        <linearGradient id="colorEngagement" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.3} />
                                            <stop offset="95%" stopColor="#7c3aed" stopOpacity={0} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                                    <XAxis
                                        dataKey="name"
                                        axisLine={false}
                                        tickLine={false}
                                        tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 'bold' }}
                                        dy={10}
                                    />
                                    <YAxis
                                        axisLine={false}
                                        tickLine={false}
                                        tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 'bold' }}
                                    />
                                    <Tooltip
                                        contentStyle={{ backgroundColor: '#fff', borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)' }}
                                        itemStyle={{ fontSize: '12px', fontWeight: 'bold' }}
                                        labelStyle={{ fontSize: '10px', color: '#94a3b8', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}
                                    />
                                    <Area
                                        type="monotone"
                                        dataKey="traffic"
                                        stroke="#2563eb"
                                        strokeWidth={3}
                                        fillOpacity={1}
                                        fill="url(#colorTraffic)"
                                    />
                                    <Area
                                        type="monotone"
                                        dataKey="engagement"
                                        stroke="#7c3aed"
                                        strokeWidth={3}
                                        fillOpacity={1}
                                        fill="url(#colorEngagement)"
                                    />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                    )}
                </div>

                {/* Sidebar: Recent Comments — only for whoever may moderate them (the only viewers they load for) */}
                {sections.recentComments && (
                <div data-dashboard-recent-comments="" className="bg-white rounded-3xl md:rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 p-5 sm:p-8 relative overflow-hidden">
                    <div className="flex items-center gap-3 mb-8">
                        <span className="w-10 h-10 shrink-0 rounded-2xl bg-amber-100 text-amber-600 flex items-center justify-center shadow-lg shadow-amber-100" data-recent-comments-icon="">
                            <i className="fa-solid fa-comments"></i>
                        </span>
                        <div className="min-w-0">
                            <h2 className="text-xl font-black text-gray-900 italic tracking-tight">{t('dashboard.recent.comments')}</h2>
                            <p className="text-[11px] font-bold uppercase tracking-widest text-gray-500 mt-0.5">{t('dashboard.community.engagement')}</p>
                        </div>
                    </div>

                    {loading ? (
                        <div className="flex items-center justify-center py-20">
                            <div className="inline-block w-8 h-8 border-4 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
                        </div>
                    ) : recentComments.length === 0 ? (
                        // No opacity-50 over gray-400 text any more: «AÚN NO HAY COMENTARIOS» was 1.56:1.
                        <div className="text-center py-20" data-dashboard-no-comments="">
                            <i className="fa-solid fa-comment-slash text-4xl mb-4 text-gray-300" aria-hidden="true"></i>
                            <p className="text-xs font-bold uppercase tracking-widest text-gray-500">{t('dashboard.no.comments.yet')}</p>
                        </div>
                    ) : (
                        <div className="space-y-6">
                            {recentComments.map((comment) => (
                                <div key={comment.id} className="group relative bg-gray-50/50 hover:bg-white p-4 rounded-[32px] transition-all duration-300 hover:shadow-lg border border-transparent hover:border-gray-100">
                                    <div className="flex gap-4">
                                        <div className="flex-shrink-0">
                                            {comment.authorAvatarUrl ? (
                                                <img
                                                    src={comment.authorAvatarUrl}
                                                    alt=""
                                                    className="w-10 h-10 rounded-xl shadow-sm"
                                                />
                                            ) : (
                                                <InitialsAvatar name={comment.author} />
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex justify-between items-start">
                                                <p className="text-sm font-black text-gray-900 truncate">
                                                    {comment.author}
                                                </p>
                                                <span className="shrink-0 text-[11px] font-bold uppercase tracking-wide text-gray-500 bg-white px-2 py-0.5 rounded-full shadow-sm border border-gray-100">
                                                    {(parseServerDate(comment.dateGmt, comment.date) ?? new Date(NaN)).toLocaleDateString()}
                                                </span>
                                            </div>
                                            <div
                                                className="text-xs text-gray-500 line-clamp-2 mt-1.5 font-medium leading-relaxed"
                                                dangerouslySetInnerHTML={{ __html: sanitizeHTML(comment.content) }}
                                            />
                                        </div>
                                    </div>
                                    {mayOpen("/admin/comments") && <a href="/admin/comments" className="absolute inset-0 z-10" aria-label="View comment"></a>}
                                </div>
                            ))}
                        </div>
                    )}

                    {mayOpen("/admin/comments") && (
                    <a
                        href="/admin/comments"
                        className="mt-8 flex items-center justify-center gap-2 w-full py-4 rounded-2xl bg-gray-50 text-gray-600 font-black text-[11px] uppercase tracking-widest hover:bg-gray-900 hover:text-white transition-all duration-300 group"
                    >
                        {t('dashboard.view.all')} <i className="fa-solid fa-arrow-right-long group-hover:translate-x-1 transition-transform"></i>
                    </a>
                    )}
                </div>
                )}
            </div>
        </div>
    );
}
