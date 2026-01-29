"use client";

import { useEffect, useState, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";

type MonitorEvent = {
    timestamp: number;
    type: 'action' | 'filter';
    hook: string;
    args: any[];
};

export default function LiveTimeline() {
    const { user } = useAuth();
    const [events, setEvents] = useState<MonitorEvent[]>([]);
    const [isConnected, setIsConnected] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    const isPausedRef = useRef(false); // Ref for loop access

    useEffect(() => {
        isPausedRef.current = isPaused;
    }, [isPaused]);

    // Auto-scroll
    useEffect(() => {
        if (!isPaused && bottomRef.current) {
            bottomRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [events, isPaused]);

    useEffect(() => {
        if (!user) return;

        let active = true;
        const controller = new AbortController();

        const connect = async () => {
            try {
                // Determine API URL (relative to current origin to handle Gateway/Proxy)
                const baseUrl = "/api/v1";

                const response = await fetch(`${baseUrl}/hooks/stream`, {
                    credentials: 'include', // Send HttpOnly cookies
                    signal: controller.signal
                });

                if (!response.ok) throw new Error(response.statusText);
                if (!response.body) throw new Error("No body");

                setIsConnected(true);
                const reader = response.body.getReader();
                const decoder = new TextDecoder();

                while (active) {
                    const { value, done } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\n\n');

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(line.substring(6));
                                if (data.type === 'connected') continue;

                                if (!isPausedRef.current) {
                                    setEvents(prev => {
                                        const newEvents = [...prev, data];
                                        return newEvents.slice(-100); // Keep last 100
                                    });
                                }
                            } catch (e) {
                                // console.log('Keep alive/Parse error', line);
                            }
                        }
                    }
                }
            } catch (error: any) {
                if (error.name !== 'AbortError') {
                    console.error("Stream error:", error);
                    setIsConnected(false);
                    // Retry logic could go here
                }
            }
        };

        connect();

        return () => {
            active = false;
            controller.abort();
            setIsConnected(false);
        };
    }, [user]);

    return (
        <div className="bg-slate-900 rounded-2xl overflow-hidden shadow-2xl border border-slate-700 font-mono text-xs h-[600px] flex flex-col items-stretch">
            {/* Toolbar */}
            <div className="bg-slate-800 p-3 flex items-center justify-between border-b border-slate-700">
                <div className="flex items-center gap-4">
                    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-colors ${isConnected ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-500 border border-red-500/20'}`}>
                        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}></div>
                        {isConnected ? 'Live Connection' : 'Disconnected'}
                    </div>
                    <span className="text-slate-400 font-medium">Buffer: {events.length}/100 events</span>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => setEvents([])}
                        className="px-4 py-2 bg-slate-700 text-slate-300 rounded-lg hover:bg-slate-600 transition-colors flex items-center gap-2 font-bold hover:text-white"
                        title="Clear console"
                    >
                        <i className="fa-solid fa-trash-can"></i> Clear
                    </button>
                    <button
                        onClick={() => setIsPaused(!isPaused)}
                        className={`px-4 py-2 rounded-lg transition-colors flex items-center gap-2 font-bold ${isPaused ? 'bg-amber-500 text-slate-900 shadow-lg shadow-amber-500/20' : 'bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white'}`}
                    >
                        {isPaused ? <><i className="fa-solid fa-play"></i> Resume</> : <><i className="fa-solid fa-pause"></i> Pause</>}
                    </button>
                </div>
            </div>

            {/* Console Output */}
            <div className="flex-1 overflow-y-auto p-4 space-y-1.5 scroll-smooth bg-[#0f172a]">
                {events.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-slate-600 space-y-4">
                        <i className="fa-solid fa-wave-square text-4xl opacity-20"></i>
                        <p className="italic">Waiting for system events...</p>
                        <p className="text-[10px] bg-slate-800 px-3 py-1 rounded-full text-slate-500">Perform actions in another tab to see them here</p>
                    </div>
                )}
                {events.map((ev, i) => (
                    <div key={i} className="flex gap-3 hover:bg-slate-800/50 p-1.5 rounded group animate-in fade-in slide-in-from-left-2 duration-300 border-l-2 border-transparent hover:border-indigo-500">
                        <span className="text-slate-600 w-16 text-right flex-shrink-0 select-none">
                            +{((ev.timestamp - (events[0]?.timestamp || ev.timestamp)) / 1000).toFixed(3)}s
                        </span>

                        <span className={`font-bold w-12 text-center uppercase text-[9px] rounded px-1 py-0.5 self-start select-none ${ev.type === 'action' ? 'text-blue-400 bg-blue-500/10' : 'text-pink-400 bg-pink-500/10'}`}>
                            {ev.type}
                        </span>

                        <div className="flex-1 min-w-0 break-all font-medium text-slate-300">
                            <span className={`${ev.type === 'action' ? 'text-blue-300' : 'text-pink-300'} mr-2 hover:underline cursor-pointer`} title="Filter by this hook">{ev.hook}</span>
                            <span className="text-slate-500">
                                {ev.args.map(a => {
                                    if (typeof a === 'string') return `"${a}"`;
                                    if (typeof a === 'object') return JSON.stringify(a);
                                    return String(a);
                                }).join(', ')}
                            </span>
                        </div>
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>
        </div>
    );
}
