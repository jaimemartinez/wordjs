// @ts-nocheck
"use client";

/**
 * Verso block "Polls" — a voting widget with animated result bars.
 *
 * Registered via manifest.frontend.versoComponents; the generated versoPluginRegistry composes
 * { ...versoComponentDef, render: default export }, so versoComponentDef must NOT carry a render.
 * Runs in the editor iframe AND on the public page, so data arrives via a client-mount fetch
 * against the plugin's PUBLIC endpoints, guarded with res.ok (an inactive plugin 404s — the
 * block degrades to a quiet placeholder instead of crashing the page).
 *
 * Vote dedupe: one vote per BROWSER via localStorage 'wjpoll_voted_<pollId>' (stores the chosen
 * option id). The sandboxed backend has no req.ip, so this is the WP-Polls "cookie mode"
 * tradeoff — see the backend header comment.
 *
 * Results visibility: show_results 'always' → the initial fetch already includes counts;
 * 'after' → the block re-fetches with &voted=1 once localStorage says this browser voted
 * (and the server also discloses counts when the poll is closed); 'never' → a thank-you
 * message replaces the bars.
 */

import React, { useEffect, useState } from "react";

const STYLES = `
.wjpl-box { max-width: 100%; border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.75rem); background: var(--wjs-bg-surface, #fff); padding: 1.25rem 1.25rem 1.1rem; font-family: inherit; color: var(--wjs-color-text, #111827); }
.wjpl-question { font-weight: 700; font-size: 1.05rem; line-height: 1.35; margin: 0 0 .9rem; }
.wjpl-closed-pill { display: inline-block; margin-left: .5rem; padding: .1rem .55rem; border-radius: 999px; background: #f3f4f6; color: #6b7280; font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; vertical-align: middle; }
.wjpl-choices { display: flex; flex-direction: column; gap: .45rem; margin: 0 0 1rem; }
.wjpl-choice { display: flex; align-items: center; gap: .6rem; padding: .55rem .75rem; border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: .6rem; cursor: pointer; transition: border-color .15s, background .15s; font-size: .95rem; }
.wjpl-choice:hover { background: rgba(0,0,0,.03); }
.wjpl-choice input { margin: 0; accent-color: var(--wjpl-accent, #3b82f6); }
.wjpl-choice.wjpl-selected { border-color: var(--wjpl-accent, #3b82f6); background: rgba(0,0,0,.02); }
.wjpl-vote-btn { display: inline-block; border: none; border-radius: .6rem; padding: .6rem 1.4rem; font-weight: 700; font-size: .9rem; color: #fff; background: var(--wjpl-accent, #3b82f6); cursor: pointer; transition: opacity .15s, transform .15s; }
.wjpl-vote-btn:hover { opacity: .88; }
.wjpl-vote-btn:disabled { opacity: .5; cursor: not-allowed; }
.wjpl-error { margin-top: .6rem; font-size: .85rem; color: #dc2626; }
.wjpl-results { display: flex; flex-direction: column; gap: .7rem; }
.wjpl-row-head { display: flex; justify-content: space-between; align-items: baseline; gap: .75rem; margin-bottom: .25rem; font-size: .88rem; }
.wjpl-row-label { font-weight: 500; overflow-wrap: anywhere; }
.wjpl-row.wjpl-mine .wjpl-row-label { font-weight: 800; color: var(--wjpl-accent, #3b82f6); }
.wjpl-row-stat { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--wjs-color-text-muted, #6b7280); font-size: .82rem; }
.wjpl-bar-bg { height: 10px; border-radius: 999px; background: var(--wjs-bg-muted, #f3f4f6); overflow: hidden; }
.wjpl-bar { height: 100%; border-radius: 999px; background: var(--wjpl-accent, #3b82f6); width: 0%; transition: width .7s cubic-bezier(.22,.9,.35,1); }
.wjpl-row.wjpl-mine .wjpl-bar { box-shadow: inset 0 0 0 100px rgba(0,0,0,.12); }
.wjpl-total { margin-top: .35rem; font-size: .8rem; color: var(--wjs-color-text-muted, #6b7280); }
.wjpl-note { font-size: .92rem; color: var(--wjs-color-text-muted, #6b7280); margin: 0; }
.wjpl-empty { padding: 1.5rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.5rem); font-size: .9rem; }
@media (max-width: 767.98px) { .wjpl-box { padding: 1rem .9rem .9rem; } .wjpl-question { font-size: .98rem; } }
`;

const VOTED_KEY_PREFIX = "wjpoll_voted_";

/** Read the option id this browser voted for (null = has not voted / storage blocked). */
function readVotedOption(pollId) {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(VOTED_KEY_PREFIX + pollId);
        if (raw == null || raw === "") return null;
        const n = parseInt(raw, 10);
        return Number.isInteger(n) && n > 0 ? n : null;
    } catch (e) {
        return null; // storage can be blocked (private mode / embedded contexts)
    }
}

// Module-level (never define a component inside a component — remounting steals input focus).
function WjplResults({ options, results, total, votedOption, accent }) {
    // Bars animate from 0 to their percentage right after mount.
    const [animated, setAnimated] = useState(false);
    useEffect(() => {
        const t = setTimeout(() => setAnimated(true), 60);
        return () => clearTimeout(t);
    }, []);
    const counts = results || {};
    const sum = Number(total) || 0;
    return (
        <div className="wjpl-results">
            {options.map((o) => {
                const count = Number(counts[o.id]) || 0;
                const pct = sum > 0 ? Math.round((count / sum) * 100) : 0;
                const mine = votedOption === o.id;
                return (
                    <div key={o.id} className={"wjpl-row" + (mine ? " wjpl-mine" : "")}>
                        <div className="wjpl-row-head">
                            <span className="wjpl-row-label">{o.label}{mine ? " · tu voto" : ""}</span>
                            <span className="wjpl-row-stat">{pct}% · {count} {count === 1 ? "voto" : "votos"}</span>
                        </div>
                        <div className="wjpl-bar-bg">
                            <div className="wjpl-bar" style={{ width: animated ? pct + "%" : "0%", background: accent }} />
                        </div>
                    </div>
                );
            })}
            <div className="wjpl-total">{sum} {sum === 1 ? "voto" : "votos"} en total</div>
        </div>
    );
}

function WjplVoteForm({ options, selected, onSelect, onVote, busy, error, accent }) {
    return (
        <div>
            <div className="wjpl-choices" role="radiogroup">
                {options.map((o) => (
                    <label key={o.id} className={"wjpl-choice" + (selected === o.id ? " wjpl-selected" : "")}>
                        <input
                            type="radio"
                            name="wjpl-option"
                            checked={selected === o.id}
                            onChange={() => onSelect(o.id)}
                        />
                        <span>{o.label}</span>
                    </label>
                ))}
            </div>
            <button
                type="button"
                className="wjpl-vote-btn"
                style={{ background: accent }}
                disabled={busy || selected == null}
                onClick={onVote}
            >
                {busy ? "Enviando…" : "Votar"}
            </button>
            {error ? <div className="wjpl-error">{error}</div> : null}
        </div>
    );
}

export const versoComponentDef = {
    category: "Encuestas",
    fields: {
        pollId: { type: "number", label: "ID de la encuesta" },
        accentColor: { type: "text", label: "Color de acento" },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        pollId: 0,
        accentColor: "#3b82f6",
        elementId: "",
    },
};

export default function PollsVerso({ pollId, accentColor, elementId }) {
    const id = Math.max(0, parseInt(pollId, 10) || 0);
    const accent = String(accentColor || "").trim() || "#3b82f6";

    // status: 'loading' | 'unconfigured' | 'missing' | 'ready'
    const [status, setStatus] = useState("loading");
    const [poll, setPoll] = useState(null);
    const [votedOption, setVotedOption] = useState(null);
    const [selected, setSelected] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!id) {
            setStatus("unconfigured");
            setPoll(null);
            return;
        }
        let alive = true;
        setStatus("loading");
        setSelected(null);
        setError("");
        const voted = readVotedOption(id);
        setVotedOption(voted);
        // voted=1 lets the server disclose counts for show_results === 'after'.
        fetch("/api/v1/plugin/polls/public/poll?id=" + id + (voted != null ? "&voted=1" : ""))
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (!alive) return;
                if (data && data.id) { setPoll(data); setStatus("ready"); }
                else { setPoll(null); setStatus("missing"); }
            })
            .catch(() => {
                if (alive) { setPoll(null); setStatus("missing"); }
            });
        return () => { alive = false; };
    }, [id]);

    const vote = async () => {
        if (selected == null || busy || !poll) return;
        setBusy(true);
        setError("");
        try {
            const res = await fetch("/api/v1/plugin/polls/public/vote", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ poll_id: id, option_id: selected }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError((data && data.error) || "No se pudo registrar el voto. Inténtalo de nuevo.");
                return;
            }
            try { window.localStorage.setItem(VOTED_KEY_PREFIX + id, String(selected)); } catch (e) { /* storage blocked */ }
            setVotedOption(selected);
            // The vote response carries fresh counts unless show_results is 'never'.
            setPoll((p) => (p ? { ...p, results: data.results || {}, total: data.total || 0 } : p));
        } catch (e) {
            setError("No se pudo registrar el voto. Inténtalo de nuevo.");
        } finally {
            setBusy(false);
        }
    };

    let content = null;
    if (status === "unconfigured") {
        content = <div className="wjpl-empty">Configura el ID de la encuesta en el bloque Polls (Admin → Encuestas).</div>;
    } else if (status === "loading") {
        content = <div className="wjpl-empty">Cargando encuesta…</div>;
    } else if (status === "missing" || !poll) {
        content = <div className="wjpl-empty">Encuesta no disponible.</div>;
    } else {
        const isOpen = Number(poll.is_open) === 1;
        const show = poll.show_results || "after";
        const hasResults = poll.results != null;
        const hasVoted = votedOption != null;

        let body;
        if (hasVoted || !isOpen) {
            // Results (or thanks/closed notice) — no voting possible in either case.
            if (show !== "never" && hasResults) {
                body = (
                    <WjplResults
                        options={poll.options || []}
                        results={poll.results}
                        total={poll.total}
                        votedOption={votedOption}
                        accent={accent}
                    />
                );
            } else if (hasVoted) {
                body = <p className="wjpl-note">Gracias por votar.</p>;
            } else {
                body = <p className="wjpl-note">Los resultados no están disponibles.</p>;
            }
        } else {
            body = (
                <>
                    <WjplVoteForm
                        options={poll.options || []}
                        selected={selected}
                        onSelect={setSelected}
                        onVote={vote}
                        busy={busy}
                        error={error}
                        accent={accent}
                    />
                    {/* 'always' shows the live counts alongside the vote form, pre-vote. */}
                    {show === "always" && hasResults && (
                        <div style={{ marginTop: "1rem" }}>
                            <WjplResults
                                options={poll.options || []}
                                results={poll.results}
                                total={poll.total}
                                votedOption={null}
                                accent={accent}
                            />
                        </div>
                    )}
                </>
            );
        }

        content = (
            <div className="wjpl-box" style={{ "--wjpl-accent": accent }}>
                <p className="wjpl-question">
                    {poll.question}
                    {!isOpen && <span className="wjpl-closed-pill">Encuesta cerrada</span>}
                </p>
                {body}
            </div>
        );
    }

    return (
        <div id={elementId || undefined}>
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {content}
        </div>
    );
}
