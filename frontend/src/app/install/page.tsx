"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { apiPost, apiGet } from "@/lib/api";
import { FaServer, FaUserShield, FaMagic, FaCheckCircle, FaArrowRight, FaArrowLeft, FaDatabase, FaExclamationTriangle } from 'react-icons/fa';

type DbDriver = 'sqlite-native' | 'sqlite-legacy' | 'postgres' | 'mysql';
type TestState = { status: 'idle' | 'testing' | 'ok' | 'fail'; message: string };

const INSTALL_STAGES = [
    'Saving configuration…',
    'Initializing the database…',
    'Generating security certificates…',
    'Creating your admin account…',
    'Finishing up…'
];

function passwordStrength(pw: string): { score: number; label: string; color: string } {
    let score = 0;
    if (pw.length >= 10) score++;
    if (pw.length >= 14) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    score = Math.min(score, 4);
    const labels = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'];
    const colors = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-lime-500', 'bg-green-600'];
    return { score, label: labels[score], color: colors[score] };
}

export default function InstallPage() {
    const router = useRouter();
    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [stageMsg, setStageMsg] = useState("");
    const [siteUrl, setSiteUrl] = useState("");
    const stageTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    // Set when install succeeds but no email provider is registered — we pause on a warning screen
    // (instead of auto-redirecting) so the admin learns password recovery won't work before moving on.
    const [installWarning, setInstallWarning] = useState<{ redirectTo: string } | null>(null);

    // Step 1: Site
    const [siteName, setSiteName] = useState("");
    const [siteDescription, setSiteDescription] = useState("Just another WordJS site");
    // One-time install token printed to the server console/logs while WordJS is not yet installed —
    // authorizes the pre-install setup endpoints so a network-exposed instance can't be hijacked first.
    const [installToken, setInstallToken] = useState("");
    const [demoContent, setDemoContent] = useState(true);

    // Step 2: Database
    const [dbDriver, setDbDriver] = useState<DbDriver>('sqlite-native');
    const [dbHost, setDbHost] = useState("localhost");
    const [dbPort, setDbPort] = useState("5432");
    const [dbName, setDbName] = useState("wordjs");
    const [dbUser, setDbUser] = useState("");
    const [dbPassword, setDbPassword] = useState("");
    const [dbSsl, setDbSsl] = useState(false);
    const [dbTest, setDbTest] = useState<TestState>({ status: 'idle', message: '' });

    // Step 3: Admin
    const [adminUser, setAdminUser] = useState("admin");
    const [adminEmail, setAdminEmail] = useState("");
    const [adminPassword, setAdminPassword] = useState("");
    const [adminPassword2, setAdminPassword2] = useState("");

    useEffect(() => {
        // Compute origin after mount to avoid an SSR/client hydration mismatch.
        setSiteUrl(window.location.origin);
        // Prefill the install token from the clickable ?token= URL the server console prints
        // (plain URLSearchParams, NOT useSearchParams — this page is statically prerendered).
        // Scrub it from the address bar right away so it doesn't linger in history.
        try {
            const params = new URLSearchParams(window.location.search);
            const tok = params.get('token');
            if (tok) {
                setInstallToken(tok.trim());
                window.history.replaceState({}, '', window.location.pathname);
            }
        } catch { /* no URL access — manual paste still works */ }
        apiGet<{ installed: boolean }>('/setup/status')
            .then(data => { if (data.installed) router.push('/login'); })
            .catch(() => { });
        return () => { if (stageTimer.current) clearInterval(stageTimer.current); };
    }, [router]);

    const pgConn = () => ({ host: dbHost, port: dbPort, user: dbUser, password: dbPassword, database: dbName, ssl: dbSsl });
    const needsConn = dbDriver === 'postgres' || dbDriver === 'mysql';
    const pgFilled = !needsConn || (dbHost && dbName && dbUser);
    const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail);
    const pwStrength = passwordStrength(adminPassword);
    const pwValid = adminPassword.length >= 10;
    const pwMatch = adminPassword === adminPassword2 && adminPassword2.length > 0;

    const testConnection = async () => {
        setDbTest({ status: 'testing', message: '' });
        try {
            const res = await apiPost<{ ok: boolean; message?: string; error?: string }>('/setup/test-db', { dbDriver, db: pgConn(), installToken });
            setDbTest(res.ok ? { status: 'ok', message: res.message || 'Connection successful.' } : { status: 'fail', message: res.error || 'Connection failed.' });
        } catch (e: any) {
            setDbTest({ status: 'fail', message: e.message || 'Connection failed.' });
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!emailValid) { setError('Please enter a valid admin email.'); return; }
        if (!pwValid) { setError('Password must be at least 10 characters.'); return; }
        if (!pwMatch) { setError('Passwords do not match.'); return; }

        setLoading(true);
        setError("");
        // Staged, informative progress while the single install call runs.
        let i = 0;
        setStageMsg(INSTALL_STAGES[0]);
        stageTimer.current = setInterval(() => {
            i = Math.min(i + 1, INSTALL_STAGES.length - 1);
            setStageMsg(INSTALL_STAGES[i]);
        }, 1200);

        try {
            const res = await apiPost<{ success: boolean; redirectTo?: string; emailProviderAvailable?: boolean }>('/setup/install', {
                siteName,
                siteDescription,
                adminUser,
                adminEmail,
                adminPassword,
                dbDriver,
                ...(needsConn ? { db: pgConn() } : {}),
                frontendUrl: siteUrl || window.location.origin,
                installToken,
                demoContent
            });
            if (stageTimer.current) clearInterval(stageTimer.current);
            const redirectTo = res?.redirectTo || '/login?installed=true';
            // A fresh site has no mail plugin, so there is no email provider and no self-service password
            // recovery. Pause on a warning screen so the admin knows before landing in /admin.
            if (res && res.emailProviderAvailable === false) {
                setInstallWarning({ redirectTo });
                setLoading(false);
                setStageMsg("");
                return;
            }
            // Auto-login sets an HttpOnly cookie on the response, so redirectTo can be /admin.
            router.push(redirectTo);
        } catch (err: any) {
            if (stageTimer.current) clearInterval(stageTimer.current);
            setError(err.message || "Installation failed.");
            setLoading(false);
            setStageMsg("");
        }
    };

    const steps = [
        { n: 1, icon: <FaServer size={16} />, label: 'Site' },
        { n: 2, icon: <FaDatabase size={16} />, label: 'Database' },
        { n: 3, icon: <FaUserShield size={16} />, label: 'Admin' }
    ];
    const inputCls = "block w-full px-4 py-3 rounded-lg border border-gray-300 bg-white/50 text-gray-900 placeholder-gray-500 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all duration-200 outline-none";
    const labelCls = "block text-sm font-semibold text-gray-700 mb-2 group-focus-within:text-blue-600 transition-colors";

    // Post-install warning: setup succeeded but the site has no email provider, so password recovery
    // won't work. Shown once, with an explicit Continue, before landing the admin in the dashboard.
    if (installWarning) {
        return (
            <div className="min-h-screen relative flex items-center justify-center overflow-hidden bg-gray-50 dark:bg-gray-900 py-10">
                <div className="relative z-10 w-full max-w-lg px-4">
                    <div className="glass-panel rounded-2xl shadow-2xl overflow-hidden">
                        <div className="bg-gradient-to-r from-amber-500 to-orange-500 p-8 text-center">
                            <div className="mx-auto bg-white/20 w-16 h-16 rounded-full flex items-center justify-center backdrop-blur-sm mb-4 shadow-lg border border-white/30">
                                <FaCheckCircle className="text-3xl text-white" aria-hidden="true" />
                            </div>
                            <h1 className="text-2xl font-bold text-white tracking-tight font-oswald">WordJS is installed</h1>
                            <p className="text-amber-50 mt-2 font-medium">One thing to know before you start</p>
                        </div>
                        <div className="p-8 md:p-10 space-y-5">
                            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4">
                                <FaExclamationTriangle className="text-amber-500 mt-0.5 shrink-0" aria-hidden="true" />
                                <div>
                                    <h2 className="text-sm font-bold text-amber-900">No email provider — password recovery is off</h2>
                                    <p className="text-sm text-amber-800/90 mt-1 leading-relaxed">
                                        WordJS core cannot send email on its own, and no mail plugin is active. Until you
                                        install one (e.g. mail-server) and grant it the <code className="font-mono text-xs">email:provider</code>{" "}
                                        permission, the &ldquo;Forgot password?&rdquo; flow will not work — a locked-out user must be
                                        reset by an administrator. Keep your admin password somewhere safe.
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => router.push(installWarning.redirectTo)}
                                className="w-full flex items-center justify-center bg-blue-600 text-white py-3.5 px-6 rounded-lg font-semibold hover:bg-blue-700 transition-all"
                            >
                                Continue to Dashboard <FaArrowRight className="ml-2" aria-hidden="true" />
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen relative flex items-center justify-center overflow-hidden bg-gray-50 dark:bg-gray-900 transition-colors duration-500 py-10">
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0">
                <div className="absolute top-0 left-1/4 w-96 h-96 bg-purple-300 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob"></div>
                <div className="absolute top-0 right-1/4 w-96 h-96 bg-yellow-300 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob animation-delay-2000"></div>
                <div className="absolute -bottom-32 left-1/3 w-96 h-96 bg-pink-300 rounded-full mix-blend-multiply filter blur-xl opacity-70 animate-blob animation-delay-4000"></div>
            </div>

            <div className="relative z-10 w-full max-w-2xl px-4">
                <div className="glass-panel rounded-2xl shadow-2xl overflow-hidden transition-all duration-300">
                    <div className="relative bg-gradient-to-r from-blue-600 to-indigo-600 p-8 text-center overflow-hidden">
                        <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10"></div>
                        <div className="relative z-10">
                            <div className="mx-auto bg-white/20 w-16 h-16 rounded-full flex items-center justify-center backdrop-blur-sm mb-4 shadow-lg border border-white/30">
                                <FaMagic className="text-3xl text-white" aria-hidden="true" />
                            </div>
                            <h1 className="text-3xl font-bold text-white tracking-tight font-oswald">WordJS Setup</h1>
                            <p className="text-blue-100 mt-2 font-medium">Build something meaningful</p>
                        </div>
                    </div>

                    <div className="p-8 md:p-10">
                        {/* Progress Steps */}
                        <div className="flex items-center justify-center mb-10">
                            {steps.map((s, idx) => (
                                <div key={s.n} className="flex items-center">
                                    <div className={`flex items-center ${step >= s.n ? 'text-blue-600' : 'text-gray-400'}`}>
                                        <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 ${step >= s.n ? 'border-blue-600 bg-blue-50' : 'border-gray-300'} transition-all duration-300`}>
                                            {step > s.n ? <FaCheckCircle size={16} /> : s.icon}
                                        </div>
                                        <span className="ml-3 font-semibold hidden md:block">{s.label}</span>
                                    </div>
                                    {idx < steps.length - 1 && (
                                        <div className={`w-10 md:w-16 h-1 mx-3 md:mx-4 rounded ${step > s.n ? 'bg-blue-600' : 'bg-gray-200'} transition-all duration-300`}></div>
                                    )}
                                </div>
                            ))}
                        </div>

                        {error && (
                            <div role="alert" className="bg-red-50 border-l-4 border-red-500 text-red-700 p-4 rounded mb-6 flex items-start shadow-sm">
                                <div className="mr-3 mt-1" aria-hidden="true">⚠️</div>
                                <div>
                                    <p className="font-bold">Installation Error</p>
                                    <p className="text-sm">{error}</p>
                                </div>
                            </div>
                        )}

                        <form onSubmit={handleSubmit} className="space-y-6">
                            {/* STEP 1 — SITE */}
                            {step === 1 && (
                                <div className="space-y-5 animate-in fade-in slide-in-from-right-8 duration-500">
                                    <div className="group">
                                        <label className={labelCls}>Site Title</label>
                                        <input type="text" required className={inputCls} value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="e.g. My Amazing Portfolio" />
                                    </div>
                                    <div className="group">
                                        <label className={labelCls}>Tagline</label>
                                        <input type="text" className={inputCls} value={siteDescription} onChange={(e) => setSiteDescription(e.target.value)} placeholder="Just another WordJS site" />
                                    </div>
                                    <div className="group">
                                        <label className={labelCls}>Install Token</label>
                                        <input type="text" required className={inputCls} value={installToken} onChange={(e) => setInstallToken(e.target.value.trim())} placeholder="Paste the token from your server console" autoComplete="off" spellCheck={false} />
                                        <p className="text-xs text-gray-500 mt-1">For security, WordJS prints a one-time <span className="font-semibold">install token</span> to the server console/logs while it is not yet installed. Paste it here to authorize setup.</p>
                                    </div>
                                    <label className="flex items-start gap-3 cursor-pointer select-none rounded-lg border border-gray-200 p-3.5 hover:border-gray-300 transition-colors">
                                        <input type="checkbox" checked={demoContent} onChange={(e) => setDemoContent(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-400" />
                                        <span>
                                            <span className="block text-sm font-semibold text-gray-800">Start with example content</span>
                                            <span className="block text-xs text-gray-500 mt-0.5">A designed home page (built with the visual editor), a welcome post, an About page and a menu — so your site looks alive from minute one. You can delete it all later.</span>
                                        </span>
                                    </label>
                                    {siteUrl && <p className="text-xs text-gray-500">This site will be installed at <span className="font-mono font-semibold">{siteUrl}</span></p>}
                                    <div className="pt-4">
                                        <button type="button" onClick={() => setStep(2)} disabled={!siteName.trim() || !installToken.trim()}
                                            className="w-full flex items-center justify-center bg-gray-900 text-white py-3.5 px-6 rounded-lg font-semibold hover:bg-gray-800 focus:ring-4 focus:ring-gray-300 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl transform hover:-translate-y-0.5">
                                            Next Step <FaArrowRight className="ml-2" aria-hidden="true" />
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* STEP 2 — DATABASE */}
                            {step === 2 && (
                                <div className="space-y-5 animate-in fade-in slide-in-from-right-8 duration-500">
                                    <div className="grid grid-cols-1 gap-3">
                                        {([
                                            { id: 'sqlite-native', title: 'SQLite (recommended)', desc: 'Zero-config, fast, file-based. Perfect for a single host.' },
                                            { id: 'postgres', title: 'PostgreSQL', desc: 'For higher concurrency or multi-node. Needs a running server.' },
                                            { id: 'mysql', title: 'MySQL / MariaDB', desc: 'For MySQL 8.0+ or MariaDB. Needs a running server.' },
                                            { id: 'sqlite-legacy', title: 'SQLite (legacy / WASM)', desc: 'Pure-JS fallback when the native binary can\'t load.' }
                                        ] as { id: DbDriver; title: string; desc: string }[]).map(opt => (
                                            <button key={opt.id} type="button" onClick={() => { setDbDriver(opt.id); if (opt.id === 'mysql') setDbPort('3306'); else if (opt.id === 'postgres') setDbPort('5432'); setDbTest({ status: 'idle', message: '' }); }}
                                                className={`text-left p-4 rounded-lg border-2 transition-all ${dbDriver === opt.id ? 'border-blue-600 bg-blue-50/60 ring-2 ring-blue-200' : 'border-gray-200 hover:border-gray-300 bg-white/40'}`}>
                                                <div className="flex items-center justify-between">
                                                    <span className="font-semibold text-gray-900">{opt.title}</span>
                                                    {dbDriver === opt.id && <FaCheckCircle className="text-blue-600" aria-hidden="true" />}
                                                </div>
                                                <p className="text-sm text-gray-500 mt-1">{opt.desc}</p>
                                            </button>
                                        ))}
                                    </div>

                                    {needsConn && (
                                        <div className="space-y-4 rounded-lg border border-gray-200 bg-white/40 p-4 animate-in fade-in duration-300">
                                            <div className="grid grid-cols-2 gap-3">
                                                <div className="group col-span-2 sm:col-span-1"><label className={labelCls}>Host</label><input className={inputCls} value={dbHost} onChange={e => { setDbHost(e.target.value); setDbTest({ status: 'idle', message: '' }); }} placeholder="localhost" /></div>
                                                <div className="group col-span-2 sm:col-span-1"><label className={labelCls}>Port</label><input className={inputCls} value={dbPort} onChange={e => setDbPort(e.target.value)} placeholder={dbDriver === 'mysql' ? '3306' : '5432'} /></div>
                                                <div className="group col-span-2"><label className={labelCls}>Database</label><input className={inputCls} value={dbName} onChange={e => { setDbName(e.target.value); setDbTest({ status: 'idle', message: '' }); }} placeholder="wordjs" /></div>
                                                <div className="group col-span-2 sm:col-span-1"><label className={labelCls}>User</label><input className={inputCls} value={dbUser} onChange={e => { setDbUser(e.target.value); setDbTest({ status: 'idle', message: '' }); }} placeholder={dbDriver === 'mysql' ? 'root' : 'postgres'} /></div>
                                                <div className="group col-span-2 sm:col-span-1"><label className={labelCls}>Password</label><input type="password" className={inputCls} value={dbPassword} onChange={e => setDbPassword(e.target.value)} /></div>
                                            </div>
                                            <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={dbSsl} onChange={e => setDbSsl(e.target.checked)} /> Use SSL</label>
                                            <div className="flex items-center gap-3">
                                                <button type="button" onClick={testConnection} disabled={!pgFilled || dbTest.status === 'testing'}
                                                    className="px-4 py-2 rounded-lg bg-white border border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 disabled:opacity-50 text-sm">
                                                    {dbTest.status === 'testing' ? 'Testing…' : 'Test connection'}
                                                </button>
                                                {dbTest.status === 'ok' && <span className="text-sm text-green-600 font-medium">✓ {dbTest.message}</span>}
                                                {dbTest.status === 'fail' && <span className="text-sm text-red-600 font-medium">✕ {dbTest.message}</span>}
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex gap-4 pt-2">
                                        <button type="button" onClick={() => setStep(1)} className="w-1/3 flex items-center justify-center bg-white text-gray-700 border border-gray-300 py-3.5 px-6 rounded-lg font-semibold hover:bg-gray-50 transition-all"><FaArrowLeft className="mr-2" aria-hidden="true" /> Back</button>
                                        <button type="button" onClick={() => setStep(3)} disabled={!pgFilled}
                                            className="w-2/3 flex items-center justify-center bg-gray-900 text-white py-3.5 px-6 rounded-lg font-semibold hover:bg-gray-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg">
                                            Next Step <FaArrowRight className="ml-2" aria-hidden="true" />
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* STEP 3 — ADMIN */}
                            {step === 3 && (
                                <div className="space-y-5 animate-in fade-in slide-in-from-right-8 duration-500">
                                    <div className="group">
                                        <label className={labelCls}>Username</label>
                                        <input type="text" required className={inputCls} value={adminUser} onChange={(e) => setAdminUser(e.target.value)} />
                                    </div>
                                    <div className="group">
                                        <label className={labelCls}>Email Address</label>
                                        <input type="email" required className={inputCls} value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="you@example.com" />
                                        {adminEmail.length > 0 && !emailValid && <p className="text-xs text-red-600 mt-1">Enter a valid email address.</p>}
                                    </div>
                                    <div className="group">
                                        <label className={labelCls}>Password</label>
                                        <input type="password" required className={inputCls} value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
                                        {adminPassword.length > 0 && (
                                            <div className="mt-2">
                                                <div className="h-1.5 w-full bg-gray-200 rounded overflow-hidden">
                                                    <div className={`h-full ${pwStrength.color} transition-all duration-300`} style={{ width: `${(pwStrength.score / 4) * 100}%` }}></div>
                                                </div>
                                                <p className="text-xs text-gray-500 mt-1">Strength: <span className="font-semibold">{pwStrength.label}</span> {!pwValid && '· min 10 characters'}</p>
                                            </div>
                                        )}
                                    </div>
                                    <div className="group">
                                        <label className={labelCls}>Confirm Password</label>
                                        <input type="password" required className={inputCls} value={adminPassword2} onChange={(e) => setAdminPassword2(e.target.value)} />
                                        {adminPassword2.length > 0 && !pwMatch && <p className="text-xs text-red-600 mt-1">Passwords do not match.</p>}
                                    </div>

                                    <div className="flex gap-4 pt-4">
                                        <button type="button" onClick={() => setStep(2)} disabled={loading} className="w-1/3 flex items-center justify-center bg-white text-gray-700 border border-gray-300 py-3.5 px-6 rounded-lg font-semibold hover:bg-gray-50 transition-all disabled:opacity-50"><FaArrowLeft className="mr-2" aria-hidden="true" /> Back</button>
                                        <button type="submit" disabled={loading || !emailValid || !pwValid || !pwMatch}
                                            className="w-2/3 flex items-center justify-center bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-3.5 px-6 rounded-lg font-semibold hover:from-blue-700 hover:to-indigo-700 focus:ring-4 focus:ring-blue-300 transition-all duration-300 disabled:opacity-60 disabled:cursor-not-allowed shadow-lg hover:shadow-xl transform hover:-translate-y-0.5">
                                            {loading ? (
                                                <span className="flex items-center">
                                                    <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                                    </svg>
                                                    {stageMsg || 'Installing…'}
                                                </span>
                                            ) : (
                                                <span className="flex items-center">Install WordJS <FaCheckCircle className="ml-2" aria-hidden="true" /></span>
                                            )}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </form>
                    </div>
                </div>

                <p className="text-center text-gray-500 mt-8 text-sm font-medium relative z-10">
                    &copy; {new Date().getFullYear()} WordJS. The future of content management.
                </p>
            </div>
        </div>
    );
}
