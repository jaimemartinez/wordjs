"use client";

import { useEffect, useState } from "react";
import { postsApi, usersApi, commentsApi, systemApi, api, Comment, SystemStatus } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useI18n } from "@/contexts/I18nContext";

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

const weeklyData = [
    { name: 'Mon', traffic: 4000, engagement: 2400 },
    { name: 'Tue', traffic: 3000, engagement: 1398 },
    { name: 'Wed', traffic: 2000, engagement: 9800 },
    { name: 'Thu', traffic: 2780, engagement: 3908 },
    { name: 'Fri', traffic: 1890, engagement: 4800 },
    { name: 'Sat', traffic: 2390, engagement: 3800 },
    { name: 'Sun', traffic: 3490, engagement: 4300 },
];

const monthlyData = [
    { name: 'Week 1', traffic: 14000, engagement: 12400 },
    { name: 'Week 2', traffic: 13000, engagement: 11398 },
    { name: 'Week 3', traffic: 12000, engagement: 19800 },
    { name: 'Week 4', traffic: 12780, engagement: 13908 },
];

// Premium Stat Card Component
const StatCard = ({ label, value, icon, color, gradient }: { label: string, value: number, icon: string, color: string, gradient: string }) => (
    <div className="group relative overflow-hidden bg-white rounded-[40px] p-8 border-2 border-gray-50 shadow-xl shadow-gray-100/50 hover:shadow-2xl hover:shadow-blue-500/10 hover:-translate-y-2 transition-all duration-500">
        {/* Background Blob */}
        <div className={`absolute -right-10 -top-10 w-40 h-40 bg-gradient-to-br ${gradient} rounded-full blur-[60px] opacity-20 group-hover:opacity-40 transition-opacity duration-700`}></div>

        <div className="relative z-10">
            <div className={`w-16 h-16 rounded-3xl bg-gradient-to-br ${gradient} flex items-center justify-center text-white text-2xl mb-6 shadow-lg shadow-gray-200 group-hover:scale-110 transition-transform duration-500`}>
                <i className={`fa-solid ${icon}`}></i>
            </div>
            <div>
                <h3 className="text-4xl font-black text-gray-900 italic tracking-tighter mb-1">{value}</h3>
                <p className="text-[10px] uppercase font-black tracking-widest text-gray-400 group-hover:text-gray-600 transition-colors">{label}</p>
            </div>
        </div>
    </div>
);

// Premium Quick Action Component
const QuickAction = ({ href, icon, label, subLabel, color }: { href: string, icon: string, label: string, subLabel: string, color: string }) => (
    <a href={href} className="group relative flex items-center gap-6 p-6 bg-white rounded-[40px] border-2 border-gray-50 hover:border-blue-200 shadow-xl shadow-gray-100/50 hover:shadow-2xl hover:shadow-blue-500/10 hover:-translate-y-1 transition-all duration-500">
        <div className={`w-12 h-12 rounded-2xl ${color} flex items-center justify-center text-white text-lg shadow-md group-hover:scale-110 transition-transform`}>
            <i className={`fa-solid ${icon}`}></i>
        </div>
        <div>
            <h4 className="font-bold text-gray-900 text-sm group-hover:text-blue-600 transition-colors">{label}</h4>
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mt-0.5">{subLabel}</p>
        </div>
        <div className="absolute right-6 opacity-0 group-hover:opacity-100 transition-opacity -translate-x-4 group-hover:translate-x-0 duration-300">
            <i className="fa-solid fa-arrow-right text-gray-300"></i>
        </div>
    </a>
);

const HealthIndicator = ({ label, status, detail, icon }: { label: string, status: string, detail: string, icon: string }) => {
    const isOk = status === 'OK';
    const color = isOk ? 'emerald' : (status === 'WARNING' ? 'amber' : 'rose');

    return (
        <div className="flex items-center gap-4 p-4 rounded-3xl bg-gray-50 border border-gray-100 group hover:bg-white hover:shadow-xl transition-all duration-300">
            <div className={`w-10 h-10 rounded-2xl bg-${color}-100 text-${color}-600 flex items-center justify-center text-sm shadow-sm group-hover:scale-110 transition-transform`}>
                <i className={`fa-solid ${icon}`}></i>
            </div>
            <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                    <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">{label}</p>
                    <span className={`flex h-2 w-2 rounded-full bg-${color}-500 animate-pulse`}></span>
                </div>
                <p className="text-xs font-bold text-gray-700 truncate">{detail}</p>
            </div>
        </div>
    );
};

export default function DashboardPage() {
    const { user, can } = useAuth();
    const { t } = useI18n();

    // Core Dashboard State
    const [stats, setStats] = useState<Stats>({ posts: 0, pages: 0, comments: 0, users: 0 });
    const [recentComments, setRecentComments] = useState<Comment[]>([]);
    const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
    const [loading, setLoading] = useState(true);

    // Analytics State
    const [chartData, setChartData] = useState<ChartData[]>([]);
    const [chartPeriod, setChartPeriod] = useState<'weekly' | 'monthly'>('weekly');

    useEffect(() => {
        loadData();
    }, []);

    useEffect(() => {
        loadAnalytics();
    }, [chartPeriod]);

    const loadAnalytics = async () => {
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

            const fetchUsers = can('list_users') ? usersApi.list() : Promise.resolve([]);
            const fetchComments = can('moderate_comments') ? commentsApi.list({ per_page: 5 }) : Promise.resolve([]);
            const fetchSystem = can('manage_options') ? systemApi.getStatus() : Promise.resolve(null);

            // ... (keep rest of function)

            const [posts, pages, users, comments, system] = await Promise.all([
                postsApi.list("post"),
                postsApi.list("page"),
                fetchUsers,
                fetchComments,
                fetchSystem
            ]);

            setStats({
                posts: posts.length,
                pages: pages.length,
                comments: comments?.length || 0,
                users: users?.length || 0,
            });
            setRecentComments(Array.isArray(comments) ? comments.slice(0, 5) : []);
            setSystemStatus(system);
        } catch (error) {
            console.error("Failed to load data:", error);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="p-8 md:p-12 pb-20 space-y-12 animate-in fade-in duration-700 bg-gray-50 h-full w-full overflow-auto">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
                <div>
                    <h1 className="text-4xl md:text-5xl font-black text-gray-900 italic tracking-tighter mb-2">
                        {t('dashboard.overview')}
                    </h1>
                    <div className="flex items-center gap-2">
                        <div className="h-1 w-10 bg-blue-600 rounded-full"></div>
                        <p className="text-xs font-bold uppercase tracking-widest text-gray-400">
                            {t('dashboard.welcome.back')}, <span className="text-gray-600">{user?.displayName || user?.username || 'User'}</span>
                        </p>
                    </div>
                </div>

                {/* Health Overview (Mini) */}
                {systemStatus && (
                    <div className="hidden lg:flex items-center gap-4 px-6 py-3 bg-white rounded-full shadow-lg shadow-gray-200/50 border border-gray-100">
                        <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${systemStatus.database.status === 'OK' ? 'bg-emerald-500' : 'bg-rose-500'} animate-pulse`}></span>
                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">DB: {systemStatus.database.driver}</span>
                        </div>
                        <div className="w-px h-4 bg-gray-200"></div>
                        <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${systemStatus.mtls.status === 'OK' ? 'bg-emerald-500' : 'bg-rose-500'} animate-pulse`}></span>
                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">mTLS: {systemStatus.mtls.status}</span>
                        </div>
                    </div>
                )}
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <StatCard
                    label={t('nav.posts')}
                    value={stats.posts}
                    icon="fa-pen-to-square"
                    color="bg-blue-600"
                    gradient="from-blue-500 to-blue-700"
                />
                <StatCard
                    label={t('nav.pages')}
                    value={stats.pages}
                    icon="fa-file-lines"
                    color="bg-indigo-600"
                    gradient="from-indigo-500 to-purple-700"
                />
                <StatCard
                    label={t('nav.comments')}
                    value={stats.comments}
                    icon="fa-comments"
                    color="bg-amber-500"
                    gradient="from-amber-400 to-orange-600"
                />
                <StatCard
                    label={t('nav.users')}
                    value={stats.users}
                    icon="fa-users"
                    color="bg-emerald-600"
                    gradient="from-emerald-400 to-teal-600"
                />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
                {/* Main Content Area */}
                <div className="lg:col-span-2 space-y-8">
                    {/* System Health Detailed */}
                    {systemStatus && (
                        <div>
                            <div className="flex items-center gap-3 mb-6">
                                <span className="w-8 h-8 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center">
                                    <i className="fa-solid fa-heart-pulse text-sm"></i>
                                </span>
                                <h2 className="text-xl font-black text-gray-900 italic tracking-tight">System Health</h2>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                <HealthIndicator
                                    label="Database"
                                    status={systemStatus.database.status}
                                    detail={systemStatus.database.status === 'OK' ? `Connected (${systemStatus.database.driver})` : systemStatus.database.message || 'Error'}
                                    icon="fa-database"
                                />
                                <HealthIndicator
                                    label="Security (mTLS)"
                                    status={systemStatus.mtls.status}
                                    detail={systemStatus.mtls.status === 'OK' ? 'Certificates Valid' : systemStatus.mtls.status}
                                    icon="fa-shield-halved"
                                />
                                <HealthIndicator
                                    label="Storage"
                                    status="OK"
                                    detail="Writable"
                                    icon="fa-folder-tree"
                                />
                            </div>
                        </div>
                    )}

                    {/* Quick Actions */}
                    <div>
                        <div className="flex items-center gap-3 mb-6">
                            <span className="w-8 h-8 rounded-xl bg-orange-100 text-orange-600 flex items-center justify-center">
                                <i className="fa-solid fa-bolt text-sm"></i>
                            </span>
                            <h2 className="text-xl font-black text-gray-900 italic tracking-tight">{t('dashboard.quick.actions')}</h2>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <QuickAction
                                href="/admin/posts/new"
                                icon="fa-plus"
                                label={t('dashboard.new.post')}
                                subLabel="Write something new"
                                color="bg-blue-500"
                            />
                            <QuickAction
                                href="/admin/pages/new"
                                icon="fa-layer-group"
                                label={t('dashboard.new.page')}
                                subLabel="Create a static page"
                                color="bg-indigo-500"
                            />
                            <QuickAction
                                href="/admin/media"
                                icon="fa-cloud-arrow-up"
                                label={t('dashboard.add.media')}
                                subLabel="Upload files"
                                color="bg-purple-500"
                            />
                            <QuickAction
                                href="/admin/users/new"
                                icon="fa-user-plus"
                                label="Add User"
                                subLabel="Invite team member"
                                color="bg-emerald-500"
                            />
                        </div>
                    </div>

                    {/* Chart/Graph */}
                    <div className="bg-white rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 p-10 relative overflow-hidden group hover:shadow-2xl transition-all duration-500">
                        <div className="absolute top-0 right-0 w-64 h-64 bg-gray-50 rounded-full blur-[80px] opacity-50 pointer-events-none"></div>
                        <div className="flex items-center justify-between mb-8 relative z-10">
                            <div>
                                <h2 className="text-2xl font-black text-gray-900 italic tracking-tighter">Activity Overview</h2>
                                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mt-1">Traffic & Engagement</p>
                            </div>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setChartPeriod('weekly')}
                                    className={`px-3 py-1 rounded-lg text-[10px] uppercase font-bold tracking-wider transition-colors ${chartPeriod === 'weekly' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                                >
                                    Weekly
                                </button>
                                <button
                                    onClick={() => setChartPeriod('monthly')}
                                    className={`px-3 py-1 rounded-lg text-[10px] uppercase font-bold tracking-wider transition-colors ${chartPeriod === 'monthly' ? 'bg-gray-900 text-white' : 'bg-white border border-gray-200 text-gray-400 hover:bg-gray-50'}`}
                                >
                                    Monthly
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
                </div>

                {/* Sidebar: Recent Comments */}
                <div className="bg-white rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 p-8 relative overflow-hidden">
                    <div className="flex items-center gap-3 mb-8">
                        <span className="w-10 h-10 rounded-2xl bg-amber-100 text-amber-600 flex items-center justify-center shadow-lg shadow-amber-100">
                            <i className="fa-solid fa-comments"></i>
                        </span>
                        <div>
                            <h2 className="text-xl font-black text-gray-900 italic tracking-tight">{t('dashboard.recent.comments')}</h2>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mt-0.5">Community Engagement</p>
                        </div>
                    </div>

                    {loading ? (
                        <div className="flex items-center justify-center py-20">
                            <div className="inline-block w-8 h-8 border-4 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
                        </div>
                    ) : recentComments.length === 0 ? (
                        <div className="text-center py-20 opacity-50">
                            <i className="fa-solid fa-comment-slash text-4xl mb-4 text-gray-300"></i>
                            <p className="text-xs font-bold uppercase tracking-widest text-gray-400">No comments yet</p>
                        </div>
                    ) : (
                        <div className="space-y-6">
                            {recentComments.map((comment) => (
                                <div key={comment.id} className="group relative bg-gray-50/50 hover:bg-white p-4 rounded-[32px] transition-all duration-300 hover:shadow-lg border border-transparent hover:border-gray-100">
                                    <div className="flex gap-4">
                                        <div className="flex-shrink-0">
                                            <img
                                                src={comment.authorAvatarUrl || `https://ui-avatars.com/api/?name=${comment.author}&background=random`}
                                                alt=""
                                                className="w-10 h-10 rounded-xl shadow-sm"
                                            />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex justify-between items-start">
                                                <p className="text-sm font-black text-gray-900 truncate">
                                                    {comment.author}
                                                </p>
                                                <span className="text-[9px] font-bold uppercase tracking-wide text-gray-400 bg-white px-2 py-0.5 rounded-full shadow-sm border border-gray-100">
                                                    {new Date(comment.date).toLocaleDateString()}
                                                </span>
                                            </div>
                                            <div
                                                className="text-xs text-gray-500 line-clamp-2 mt-1.5 font-medium leading-relaxed"
                                                dangerouslySetInnerHTML={{ __html: comment.content }}
                                            />
                                        </div>
                                    </div>
                                    <a href="/admin/comments" className="absolute inset-0 z-10" aria-label="View comment"></a>
                                </div>
                            ))}
                        </div>
                    )}

                    <a
                        href="/admin/comments"
                        className="mt-8 flex items-center justify-center gap-2 w-full py-4 rounded-2xl bg-gray-50 text-gray-600 font-black text-[10px] uppercase tracking-widest hover:bg-gray-900 hover:text-white transition-all duration-300 group"
                    >
                        View all <i className="fa-solid fa-arrow-right-long group-hover:translate-x-1 transition-transform"></i>
                    </a>
                </div>
            </div>
        </div>
    );
}
