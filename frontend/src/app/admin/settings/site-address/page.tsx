"use client";

import { useEffect, useId, useRef, useState } from "react";
import { DatePicker } from "@/components/ui/DatePicker";
import DialogLayer from "@/components/DialogLayer";
import { useSearchParams } from "next/navigation";
import { Button, Checkbox, DataTable, IconButton, Input, PageHeader, Radio, RadioGroup, Select } from "@/components/ui";
import { LABEL_CLASS } from "@/components/ui/Field";
import { useAuth } from "@/contexts/AuthContext";
import { useI18n } from "@/contexts/I18nContext";
import { useModal } from "@/contexts/ModalContext";
import { useToast } from "@/contexts/ToastContext";
import {
    aliasesForWrite,
    buildAlias,
    canManageSiteAddress,
    siteAddressRefusalKey,
    canonicalChangeNotes,
    canonicalChoice,
    classifyWriteError,
    dateInputToExpiry,
    defaultExpiryFor,
    expiryToDateInput,
    fillTemplate,
    ipLiteralsLabelKey,
    isCurrentAddress,
    isLanName,
    needsLocalConfirmation,
    oldAddressApplies,
    ownAddressesHeadingKey,
    parseSiteAddress,
    policyWrite,
    signInPolicy,
    siteAddressApi,
    suggestedCanonical,
    upsertAlias,
    withoutAlias,
    type AliasMode,
    type AliasView,
    type Dependent,
    type IpLiteralMode,
    type OldAddressAction,
    type SiteAddressState,
    type WriteResult,
} from "@/lib/siteAddress";
import { RefusedByLabel } from "./RefusedByLabel";

/**
 * Settings → Site address (SPEC §6). The ONLY screen that changes where the site answers and which
 * address goes into links. Every write is sudo-gated (current password), carries the `rev` it was
 * based on (a concurrent change from the CLI or another tab answers 409 instead of being overwritten),
 * and goes through the backend's single writer, which audits and notifies every administrator.
 *
 * There is deliberately no "use the address I am on" button: adopting the request's own host is
 * exactly what the retired /migration flow did, and what made a DNS-rebinding or phishing page able
 * to steer the site. Addresses come from what the admin types, from the alias list, or from the
 * recently-refused list (with a warning about DNS control).
 */

type T = (key: string) => string;

const card = "bg-white rounded-3xl md:rounded-[40px] shadow-xl shadow-gray-100/50 border-2 border-gray-50 overflow-hidden";
const cardHead = "px-5 sm:px-8 py-5 sm:py-6 border-b border-gray-50 bg-gray-50/30";
const cardTitle = "text-lg font-bold text-gray-900 flex items-center gap-2";

const formatTime = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toLocaleString());

/** A label from the catalogue when there is one for this value, the raw value otherwise. */
function labelFor(t: T, prefix: string, value: string, fallback?: string): string {
    const key = `${prefix}.${value}`;
    const text = t(key);
    return text === key ? (fallback ?? value) : text;
}

// ─── Dialog shell ────────────────────────────────────────────────────────────────────────────────────

function Dialog({ title, t, onClose, children, wide = false }: { title: string; t: T; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
    const titleId = useId();
    return (
        <DialogLayer
            className="flex items-center justify-center bg-gray-900/40 p-4"
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        >
            <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={`w-full ${wide ? "max-w-2xl" : "max-w-lg"} max-h-[90dvh] overflow-auto rounded-[32px] bg-white p-8 shadow-2xl`}>
                <div className="mb-6 flex items-start justify-between gap-4">
                    <h2 id={titleId} className="text-lg font-bold text-gray-900">{title}</h2>
                    <IconButton icon="fa-xmark" label={t("close")} onClick={onClose} />
                </div>
                {children}
            </div>
        </DialogLayer>
    );
}

// ─── The sudo step every write ends in ───────────────────────────────────────────────────────────────

interface PendingWrite {
    /** One line saying what is about to change. */
    summary: string;
    run: (currentPassword: string, force: boolean) => Promise<WriteResult>;
}

function SudoDialog({ pending, t, onDone, onStale, onClose }: {
    pending: PendingWrite;
    t: T;
    onDone: (result: WriteResult) => void;
    onStale: () => void;
    onClose: () => void;
}) {
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dependents, setDependents] = useState<Dependent[] | null>(null);

    const submit = async (force: boolean) => {
        setBusy(true);
        setError(null);
        try {
            onDone(await pending.run(password, force));
        } catch (err) {
            const failure = classifyWriteError(err);
            if (failure.kind === "bad-password") setError(t("siteAddress.sudo.badPassword"));
            else if (failure.kind === "in-use") setDependents(failure.dependents);
            else if (failure.kind === "stale") onStale();
            else setError(fillTemplate(t("siteAddress.failed"), { message: failure.message }));
        } finally {
            setBusy(false);
        }
    };

    if (dependents) {
        return (
            <Dialog title={t("siteAddress.inUse.title")} t={t} onClose={onClose}>
                <p className="text-sm text-gray-700">{t("siteAddress.inUse.body")}</p>
                <ul className="mt-3 list-disc space-y-1 pl-6 text-sm text-gray-700">
                    {dependents.map((d, i) => (
                        <li key={i}>
                            {d.host && <span className="font-mono">{d.host}</span>}
                            {d.host && ": "}
                            {labelFor(t, "siteAddress.dependent", d.kind, d.detail ?? d.kind)}
                        </li>
                    ))}
                </ul>
                {error && <p role="alert" className="mt-4 text-sm font-medium text-red-600">{error}</p>}
                <div className="mt-6 flex justify-end gap-3">
                    <Button variant="ghost" size="md" onClick={onClose}>{t("cancel")}</Button>
                    <Button variant="danger" size="md" pending={busy} onClick={() => submit(true)}>
                        {t("siteAddress.inUse.force")}
                    </Button>
                </div>
            </Dialog>
        );
    }

    return (
        <Dialog title={t("siteAddress.sudo.title")} t={t} onClose={onClose}>
            <form onSubmit={(e) => { e.preventDefault(); void submit(false); }} className="space-y-4">
                <p className="text-sm text-gray-700">{pending.summary}</p>
                <Input
                    id="site-address-sudo"
                    size="md"
                    type="password"
                    revealable
                    label={t("siteAddress.sudo.password")}
                    autoComplete="current-password"
                    required
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                />
                {error && <p role="alert" className="text-sm font-medium text-red-600">{error}</p>}
                <div className="flex justify-end gap-3 pt-2">
                    <Button variant="ghost" size="md" onClick={onClose}>{t("cancel")}</Button>
                    <Button type="submit" size="md" disabled={!password} pending={busy}>
                        {t("siteAddress.sudo.confirm")}
                    </Button>
                </div>
            </form>
        </Dialog>
    );
}

// ─── Add / edit an alias ─────────────────────────────────────────────────────────────────────────────

function AliasDialog({ state, previous, prefillUrl, fromRefused, t, onSubmit, onClose }: {
    state: SiteAddressState;
    previous: AliasView | null;
    prefillUrl: string;
    fromRefused: boolean;
    t: T;
    onSubmit: (alias: AliasView) => void;
    onClose: () => void;
}) {
    const [url, setUrl] = useState(previous?.origin ?? prefillUrl);
    const [label, setLabel] = useState(previous?.label ?? "");
    const [mode, setMode] = useState<AliasMode>(previous?.mode ?? "serve");
    const [signIn, setSignIn] = useState<boolean | null>(previous?.signIn ?? null);
    const [expiryDate, setExpiryDate] = useState(expiryToDateInput(previous?.expiresAt ?? null));
    // Until the admin touches the date, an edited entry keeps its exact expiry and a new tunnel name
    // gets the one-week default (computed at submit time, so it is a week from the save).
    const [expiryTouched, setExpiryTouched] = useState(false);
    const [localConfirmed, setLocalConfirmed] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The clock the dialog shows defaults against; the saved default is recomputed at submit.
    const [openedAt] = useState(() => Date.now());

    const site = parseSiteAddress(url);
    const tunnelDefault = !previous && site ? defaultExpiryFor(site.hostname, openedAt) : null;
    const shownExpiry = expiryTouched ? expiryDate : expiryToDateInput(previous ? previous.expiresAt : tunnelDefault);
    const policy = site ? signInPolicy({ ...site, signIn }, state.canonical) : null;
    const isLocal = !!site && isLanName(site.hostname);
    const localAlreadyAccepted = !!previous && previous.hostname === site?.hostname;

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        if (isLocal && !localAlreadyAccepted && !localConfirmed) {
            setError(t("siteAddress.error.localConfirm"));
            return;
        }
        const now = Date.now();
        const freshDefault = !previous && site ? defaultExpiryFor(site.hostname, now) : null;
        const expiresAt = expiryTouched ? dateInputToExpiry(expiryDate) : (previous ? previous.expiresAt : freshDefault);
        const built = buildAlias(
            { url, label, mode, signIn, expiresAt },
            { canonical: state.canonical, existing: state.aliases, previous, now },
        );
        if ("error" in built) {
            setError(t(`siteAddress.error.${built.error}`));
            return;
        }
        onSubmit(built.alias);
    };

    return (
        <Dialog title={t(previous ? "siteAddress.edit.title" : "siteAddress.add.title")} t={t} onClose={onClose}>
            <form onSubmit={submit} className="space-y-5">
                {fromRefused && (
                    <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
                        <i className="fa-solid fa-triangle-exclamation mr-2 text-amber-500" aria-hidden="true"></i>
                        {t("siteAddress.dnsWarning")}
                    </p>
                )}
                <Input
                    id="alias-url"
                    size="md"
                    type="url"
                    required
                    label={t("siteAddress.field.url")}
                    help={t("siteAddress.field.url.help")}
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    className="font-mono"
                    placeholder="https://www.example.com"
                    autoComplete="off"
                    spellCheck={false}
                />
                <Input id="alias-label" size="md" label={t("siteAddress.field.label")} maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} />
                <Select
                    id="alias-mode"
                    label={t("siteAddress.field.mode")}
                    value={mode}
                    onChange={(v) => setMode(v === "redirect" ? "redirect" : "serve")}
                    options={[
                        { value: "serve", label: t("siteAddress.mode.serve") },
                        { value: "redirect", label: t("siteAddress.mode.redirect") },
                    ]}
                />
                <div>
                    <DatePicker
                        id="alias-expires"
                        label={t("siteAddress.field.expires")}
                        value={shownExpiry}
                        onChange={(v) => { setExpiryTouched(true); setExpiryDate(v); }}
                        className="rounded-2xl border-2 px-4 py-3 text-sm"
                    />
                    <p className="mt-1 text-xs text-gray-400">
                        {tunnelDefault ? t("siteAddress.field.expires.tunnelHelp") : (!shownExpiry ? t("siteAddress.field.expires.none") : null)}
                    </p>
                </div>
                {policy?.relevant && (
                    <div className="rounded-2xl border border-gray-100 bg-gray-50/60 p-4">
                        <Checkbox label={t("siteAddress.field.signIn")} checked={policy.effective} onChange={(e) => setSignIn(e.target.checked)} />
                        {policy.warning && (
                            <p className={`mt-2 text-xs leading-relaxed ${policy.effective ? "font-semibold text-red-700" : "text-gray-500"}`}>
                                {t(`siteAddress.signIn.warn.${policy.warning}`)}
                            </p>
                        )}
                    </div>
                )}
                {isLocal && !localAlreadyAccepted && (
                    <Checkbox
                        containerClassName="rounded-2xl border border-amber-200 bg-amber-50 p-4"
                        label={<span className="font-medium text-amber-900">{t("siteAddress.localConfirm")}</span>}
                        checked={localConfirmed}
                        onChange={(e) => setLocalConfirmed(e.target.checked)}
                    />
                )}
                {error && <p role="alert" className="text-sm font-medium text-red-600">{error}</p>}
                <div className="flex justify-end gap-3 pt-2">
                    <Button variant="ghost" size="md" onClick={onClose}>{t("cancel")}</Button>
                    <Button type="submit" size="md" disabled={!site}>{t("save")}</Button>
                </div>
            </form>
        </Dialog>
    );
}

// ─── Change the main address ─────────────────────────────────────────────────────────────────────────

function CanonicalDialog({ state, prefillUrl, usingCurrent, t, onSubmit, onClose }: {
    state: SiteAddressState;
    prefillUrl: string;
    usingCurrent: boolean;
    t: T;
    onSubmit: (url: string, oldAddress: OldAddressAction) => void;
    onClose: () => void;
}) {
    const [url, setUrl] = useState(prefillUrl);
    const [oldAddress, setOldAddress] = useState<OldAddressAction>("keep");
    // During an upgrade conflict the configured address is a choice too ("Use A" opens this prefilled with it).
    const choice = canonicalChoice(url, state.canonical, { conflict: !!state.conflict });
    const next = "site" in choice ? choice.site : null;
    const askOld = !!next && oldAddressApplies(next, state.canonical);
    const notes = next ? canonicalChangeNotes({ next, current: state.canonical, oldAddress: askOld ? oldAddress : "keep", usingCurrent }) : [];

    return (
        <Dialog title={t("siteAddress.change.title")} t={t} onClose={onClose} wide>
            <form
                onSubmit={(e) => { e.preventDefault(); if (next) onSubmit(next.origin, askOld ? oldAddress : "keep"); }}
                className="space-y-6"
            >
                <fieldset className="space-y-3">
                    <legend className={LABEL_CLASS}>{t("siteAddress.change.pick")}</legend>
                    {state.aliases.length > 0 && (
                        <Select
                            aria-label={t("siteAddress.change.pickAlias")}
                            placeholder={t("siteAddress.change.pickAlias")}
                            value=""
                            onChange={(v) => { if (v) setUrl(v); }}
                            options={state.aliases.map((a) => ({ value: a.origin, label: a.origin }))}
                        />
                    )}
                    <Input
                        size="md"
                        type="url"
                        required
                        aria-label={t("siteAddress.change.orType")}
                        placeholder={t("siteAddress.change.orType")}
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        className="font-mono"
                        autoComplete="off"
                        spellCheck={false}
                    />
                    {url && "error" in choice && (
                        <p role="alert" className="text-sm font-medium text-red-600">{t(`siteAddress.error.${choice.error}`)}</p>
                    )}
                </fieldset>

                {askOld && state.canonical && (
                    <RadioGroup
                        label={fillTemplate(t("siteAddress.change.old"), { old: state.canonical.origin })}
                        name="old-address"
                        value={oldAddress}
                        onChange={(v) => setOldAddress(v as typeof oldAddress)}
                    >
                        {(["keep", "redirect", "drop"] as const).map((option) => (
                            <Radio key={option} value={option} label={t(`siteAddress.old.${option}`)} />
                        ))}
                    </RadioGroup>
                )}

                {next && (
                    <div className="rounded-2xl border border-gray-100 bg-gray-50/60 p-4">
                        <p className="mb-2 text-sm font-bold text-gray-800">{t("siteAddress.change.consequences")}</p>
                        <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
                            {notes.map((note) => (
                                <li key={note} className={note === "downgrade" || note === "dropCurrent" ? "font-semibold text-red-700" : undefined}>
                                    {t(`siteAddress.consequence.${note}`)}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                <div className="flex justify-end gap-3">
                    <Button variant="ghost" size="md" onClick={onClose}>{t("cancel")}</Button>
                    <Button type="submit" size="md" disabled={!next}>{t("siteAddress.change.submit")}</Button>
                </div>
            </form>
        </Dialog>
    );
}

// ─── The page ───────────────────────────────────────────────────────────────────────────────────────

type OpenDialog =
    | { kind: "alias"; previous: AliasView | null; prefillUrl: string; fromRefused: boolean }
    | { kind: "canonical"; prefillUrl: string }
    | null;

export default function SiteAddressPage() {
    const { t } = useI18n();
    const { user, isLoading } = useAuth();
    const { confirm } = useModal();
    const { addToast } = useToast();
    const isAdmin = canManageSiteAddress(user);

    const [state, setState] = useState<SiteAddressState | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [dialog, setDialog] = useState<OpenDialog>(null);
    const [pending, setPending] = useState<PendingWrite | null>(null);
    const [ipChoice, setIpChoice] = useState<IpLiteralMode>("any");
    const [ipSignInChoice, setIpSignInChoice] = useState(false);
    // Client-only page (it renders nothing before the auth probe resolves), so window is read once here.
    const [hostname] = useState(() => (typeof window === "undefined" ? "" : window.location.hostname));
    // When the state was loaded: what "expired" is judged against in the table.
    const [loadedAt, setLoadedAt] = useState(0);
    // `?suggest=<url>`: the security page sends the admin here after an SSL or port change made the
    // gateway serve another address. Honoured once, and only if the backend reports that address too
    // (see suggestedCanonical); a re-read after a save must not reopen the dialog.
    const suggestParam = useSearchParams().get("suggest");
    const suggestionOpened = useRef<string | null>(null);

    // Bumped after every write (and after a stale-rev refusal) to read the state again.
    const [reloadKey, setReloadKey] = useState(0);
    const reload = () => setReloadKey((k) => k + 1);

    useEffect(() => {
        if (!isAdmin) return;
        let active = true;
        siteAddressApi.get().then(
            (next) => {
                if (!active) return;
                setLoadedAt(Date.now());
                setState(next);
                setIpChoice(next.ipLiterals);
                setIpSignInChoice(next.ipSignIn);
                setLoadError(null);
                const suggestion = suggestedCanonical(suggestParam, next);
                if (suggestion && suggestionOpened.current !== suggestion) {
                    suggestionOpened.current = suggestion;
                    setDialog({ kind: "canonical", prefillUrl: suggestion });
                }
            },
            (err) => { if (active) setLoadError(err instanceof Error ? err.message : String(err)); },
        );
        return () => { active = false; };
    }, [isAdmin, reloadKey, suggestParam]);

    if (isLoading) return null;
    if (!isAdmin) {
        return <div className="px-4 py-6 sm:p-8 md:p-12"><p className="text-sm text-gray-600" data-testid="site-address-refused">{t(siteAddressRefusalKey(user) || "siteAddress.adminOnly")}</p></div>;
    }

    const finished = (result: WriteResult) => {
        setPending(null);
        setDialog(null);
        const warnings = (result?.warnings ?? []).filter((w) => typeof w === "string" && w);
        // A warning (e.g. the gateway could not be told yet) needs reading, so it stays up longer.
        if (warnings.length) for (const warning of warnings) addToast(fillTemplate(t("siteAddress.savedWithWarning"), { warning }), "warning", 10000);
        else addToast(t("siteAddress.saved"), "success");
        reload();
    };

    const stale = () => {
        setPending(null);
        setDialog(null);
        addToast(t("siteAddress.stale"), "warning", 10000);
        reload();
    };

    const saveAliases = (list: AliasView[], summary: string) => {
        if (!state) return;
        const rev = state.rev;
        setPending({
            summary,
            run: (currentPassword, force) => siteAddressApi.putAliases({
                aliases: aliasesForWrite(list),
                currentPassword,
                rev,
                ...(force ? { force: true } : {}),
                // The dialog asked before a .local name went into the list (see AliasDialog).
                ...(needsLocalConfirmation(list) ? { confirmLocal: true } : {}),
            }),
        });
    };

    const removeAlias = async (alias: AliasView) => {
        if (!state) return;
        const current = isCurrentAddress(alias.hostname, state, hostname);
        const ok = await confirm(
            fillTemplate(t(current ? "siteAddress.remove.current" : "siteAddress.remove.confirm"), { host: alias.origin }),
            t("siteAddress.action.remove"),
            true,
        );
        if (ok) saveAliases(withoutAlias(state.aliases, alias.hostname), fillTemplate(t("siteAddress.remove.confirm"), { host: alias.origin }));
    };

    const submitAlias = (alias: AliasView, previous: AliasView | null) => {
        if (!state) return;
        setDialog(null);
        saveAliases(upsertAlias(state.aliases, alias, previous?.hostname ?? null), `${t(previous ? "siteAddress.edit.title" : "siteAddress.add.title")}: ${alias.origin}`);
    };

    const submitCanonical = (url: string, oldAddress: OldAddressAction) => {
        if (!state) return;
        const rev = state.rev;
        setDialog(null);
        setPending({
            summary: `${t("siteAddress.change.title")}: ${url}`,
            run: (currentPassword, force) => siteAddressApi.putCanonical({ url, oldAddress, currentPassword, rev, ...(force ? { force: true } : {}) }),
        });
    };

    const policyChange = state ? policyWrite(state, { ipLiterals: ipChoice, ipSignIn: ipSignInChoice }) : null;

    const submitPolicy = () => {
        if (!state || !policyChange) return;
        const rev = state.rev;
        const body = policyChange;
        const signInOn = body.ipSignIn ?? state.ipSignIn;
        const signInText = t(signInOn ? "siteAddress.ipSignIn.on" : "siteAddress.ipSignIn.off");
        setPending({
            summary: `${t("siteAddress.accepted.ipPolicy")}: ${t(ipLiteralsLabelKey(body.ipLiterals, state.ownAddressesFrom))}. ${signInText}`,
            run: (currentPassword) => siteAddressApi.putPolicy({ ...body, currentPassword, rev }),
        });
    };

    const openChange = (prefillUrl: string) => setDialog({ kind: "canonical", prefillUrl });

    return (
        <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50">
            <div className="max-w-5xl mx-auto space-y-8">
                <PageHeader title={t("siteAddress.title")} subtitle={t("siteAddress.subtitle")} />

                {loadError && !state && (
                    <p role="alert" className="rounded-3xl border-2 border-red-100 bg-red-50 px-6 py-4 text-sm font-medium text-red-700">
                        {t("siteAddress.loadFailed")} <span className="text-red-500">{loadError}</span>
                    </p>
                )}

                {!state && !loadError && (
                    <div className="flex justify-center py-16">
                        <i className="fa-solid fa-spinner fa-spin text-2xl text-gray-400" aria-hidden="true"></i>
                    </div>
                )}

                {state && (
                    <>
                        {state.connectedVia && (
                            <p className="text-sm text-gray-600">
                                <i className="fa-solid fa-plug mr-2 text-gray-400" aria-hidden="true"></i>
                                {fillTemplate(t("siteAddress.connectedVia"), {
                                    host: state.connectedVia.host,
                                    cls: labelFor(t, "siteAddress.cls", state.connectedVia.cls, t("siteAddress.cls.unknown")),
                                })}
                            </p>
                        )}

                        {state.conflict && (
                            <div role="alert" className="rounded-3xl border-2 border-amber-200 bg-amber-50 px-6 py-5">
                                <h3 className="text-sm font-bold text-amber-900">{t("siteAddress.conflict.title")}</h3>
                                <p className="mt-1 text-sm text-amber-900/90">{fillTemplate(t("siteAddress.conflict.body"), state.conflict)}</p>
                                <div className="mt-3 flex flex-wrap gap-3">
                                    {[state.conflict.config, state.conflict.db].map((address) => (
                                        <Button key={address} variant="secondary" size="md" onClick={() => openChange(address)}>
                                            {fillTemplate(t("siteAddress.useAddress"), { address })}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {state.gatewayDrift && (
                            <div role="alert" className="rounded-3xl border-2 border-amber-200 bg-amber-50 px-6 py-5">
                                <h3 className="text-sm font-bold text-amber-900">{t("siteAddress.drift.title")}</h3>
                                <p className="mt-1 text-sm text-amber-900/90">{fillTemplate(t("siteAddress.drift.body"), state.gatewayDrift)}</p>
                                <Button variant="secondary" size="md" className="mt-3" onClick={() => openChange(state.gatewayDrift!.gateway)}>
                                    {fillTemplate(t("siteAddress.useAddress"), { address: state.gatewayDrift.gateway })}
                                </Button>
                            </div>
                        )}

                        {state.notices.includes("proxy-collapse") && (
                            <div role="alert" className="rounded-3xl border-2 border-amber-200 bg-amber-50 px-6 py-5">
                                <h3 className="text-sm font-bold text-amber-900">{t("siteAddress.proxyCollapse.title")}</h3>
                                <p className="mt-1 text-sm text-amber-900/90">{t("siteBanner.proxyCollapse")}</p>
                            </div>
                        )}

                        {/* 1. Main address */}
                        <section className={card} aria-labelledby="sa-main">
                            <div className={cardHead}>
                                <h2 id="sa-main" className={cardTitle}><i className="fa-solid fa-house text-blue-500" aria-hidden="true"></i> {t("siteAddress.main.title")}</h2>
                            </div>
                            <div className="p-8 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                                <div className="min-w-0 flex-1">
                                    {state.canonical
                                        ? <p className="font-mono text-lg font-bold text-gray-900 break-all">{state.canonical.origin}</p>
                                        : <p className="text-sm font-semibold text-red-700">{t("siteAddress.main.none")}</p>}
                                    <p className="mt-1 text-sm text-gray-500">{t("siteAddress.main.note")}</p>
                                </div>
                                <Button size="md" className="shrink-0 self-start lg:self-auto" onClick={() => openChange("")}>{t("siteAddress.main.change")}</Button>
                            </div>
                        </section>

                        {/* 2. Other addresses */}
                        <section className={card} aria-labelledby="sa-aliases">
                            <div className={`${cardHead} flex flex-col lg:flex-row lg:items-center justify-between gap-4`}>
                                <div className="min-w-0 flex-1">
                                    <h2 id="sa-aliases" className={cardTitle}><i className="fa-solid fa-signs-post text-purple-500" aria-hidden="true"></i> {t("siteAddress.aliases.title")}</h2>
                                    <p className="mt-1 text-sm text-gray-500">{t("siteAddress.aliases.help")}</p>
                                </div>
                                <Button variant="secondary" size="md" icon="fa-plus" className="shrink-0 self-start lg:self-auto" onClick={() => setDialog({ kind: "alias", previous: null, prefillUrl: "", fromRefused: false })}>
                                    {t("siteAddress.aliases.add")}
                                </Button>
                            </div>
                            {state.aliases.length === 0 ? (
                                <p className="p-8 text-sm text-gray-500">{t("siteAddress.aliases.empty")}</p>
                            ) : (
                                <DataTable
                                    rows={state.aliases}
                                    rowKey={(alias) => alias.hostname}
                                    caption={t("siteAddress.aliases.title")}
                                    rowLabel={(alias) => alias.origin}
                                    actionsLabel={t("siteAddress.col.actions")}
                                    stackBelow="lg"
                                    density="compact"
                                    rowClassName={(alias) => (alias.expiresAt !== null && Date.parse(alias.expiresAt) <= loadedAt ? "text-gray-400" : "text-gray-800")}
                                    columns={[
                                        {
                                            key: "address",
                                            header: t("siteAddress.col.address"),
                                            primary: true,
                                            // An address reads as one unbroken line in the table; in a card it may break anywhere.
                                            cell: (alias) => <span className="font-mono text-sm lg:whitespace-nowrap break-all">{alias.origin}</span>,
                                        },
                                        { key: "label", header: t("siteAddress.col.label"), cell: (alias) => <span className="text-sm">{alias.label ?? ""}</span> },
                                        { key: "mode", header: t("siteAddress.col.mode"), cell: (alias) => <span className="text-sm">{t(`siteAddress.mode.${alias.mode}`)}</span> },
                                        {
                                            key: "signIn",
                                            header: t("siteAddress.col.signIn"),
                                            cell: (alias) => {
                                                const policy = signInPolicy(alias, state.canonical);
                                                return (
                                                    <span className="text-sm">
                                                        {policy.relevant && policy.effective && (
                                                            <i className="fa-solid fa-triangle-exclamation mr-1 text-amber-500" aria-hidden="true" title={policy.warning ? t(`siteAddress.signIn.warn.${policy.warning}`) : undefined}></i>
                                                        )}
                                                        {t(policy.effective ? "siteAddress.signIn.on" : "siteAddress.signIn.off")}
                                                    </span>
                                                );
                                            },
                                        },
                                        { key: "source", header: t("siteAddress.col.source"), showFrom: "xl", cell: (alias) => <span className="text-sm">{labelFor(t, "siteAddress.source", alias.source)}</span> },
                                        {
                                            key: "expires",
                                            header: t("siteAddress.col.expires"),
                                            cell: (alias) => {
                                                const expired = alias.expiresAt !== null && Date.parse(alias.expiresAt) <= loadedAt;
                                                return (
                                                    <span className="text-sm">
                                                        {alias.expiresAt === null
                                                            ? t("siteAddress.expires.never")
                                                            : expired ? t("siteAddress.expires.expired") : new Date(alias.expiresAt).toLocaleDateString()}
                                                    </span>
                                                );
                                            },
                                        },
                                        { key: "lastSeen", header: t("siteAddress.col.lastSeen"), showFrom: "xl", className: "lg:whitespace-nowrap", cell: (alias) => <span className="text-sm">{formatTime(alias.lastSeenAt) ?? t("siteAddress.lastSeen.never")}</span> },
                                    ]}
                                    actions={(alias) => [
                                        { key: "main", label: t("siteAddress.action.makeMain"), icon: "fa-star", onClick: () => openChange(alias.origin), tone: "primary" },
                                        { key: "edit", label: t("siteAddress.action.edit"), icon: "fa-pen", onClick: () => setDialog({ kind: "alias", previous: alias, prefillUrl: alias.origin, fromRefused: false }), tone: "primary" },
                                        { key: "remove", label: t("siteAddress.action.remove"), icon: "fa-trash", onClick: () => void removeAlias(alias), tone: "danger" },
                                    ]}
                                />
                            )}
                        </section>

                        {/* 3. Always accepted */}
                        <section className={card} aria-labelledby="sa-accepted">
                            <div className={cardHead}>
                                <h2 id="sa-accepted" className={cardTitle}><i className="fa-solid fa-circle-check text-emerald-500" aria-hidden="true"></i> {t("siteAddress.accepted.title")}</h2>
                            </div>
                            <div className="p-8 space-y-6 text-sm text-gray-700">
                                <p>{t("siteAddress.accepted.loopback")}</p>
                                <div>
                                    {/* Behind a gateway, `own` is the gateway's addresses: the ones browsers connect to. */}
                                    <h3 className="font-bold text-gray-900">{t(ownAddressesHeadingKey(state.ownAddressesFrom))}</h3>
                                    {state.ownAddresses.length === 0
                                        ? <p className="mt-1 text-gray-500">{t("siteAddress.accepted.ownNone")}</p>
                                        : <ul className="mt-1 flex flex-wrap gap-2">{state.ownAddresses.map((a) => <li key={a} className="rounded-xl bg-gray-100 px-3 py-1 font-mono text-xs">{a}</li>)}</ul>}
                                </div>
                                <div>
                                    <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                                        <Select
                                            id="sa-ip-policy"
                                            containerClassName="sm:max-w-xs flex-1"
                                            label={t("siteAddress.accepted.ipPolicy")}
                                            value={ipChoice}
                                            disabled={state.ipLiteralsSource === "env"}
                                            onChange={(v) => setIpChoice(v === "own" || v === "none" ? v : "any")}
                                            options={(["any", "own", "none"] as const).map((mode) => ({ value: mode, label: t(ipLiteralsLabelKey(mode, state.ownAddressesFrom)) }))}
                                        />
                                        <Button variant="secondary" size="md" disabled={!policyChange} onClick={submitPolicy}>
                                            {t("save")}
                                        </Button>
                                    </div>
                                    <p className="mt-2 text-xs text-gray-500">{t(state.ipLiteralsSource === "env" ? "siteAddress.ip.fromEnv" : "siteAddress.ip.help")}</p>
                                    {/* hostPolicy.ipSignIn, saved with the mode above (one sudo step). Read-only while
                                        WORDJS_IP_HOSTS sets the mode: see policyWrite. */}
                                    <div className="mt-3 rounded-2xl border border-gray-100 bg-gray-50/60 p-4">
                                        <Checkbox
                                            label={t(ipSignInChoice ? "siteAddress.ipSignIn.on" : "siteAddress.ipSignIn.off")}
                                            checked={ipSignInChoice}
                                            disabled={state.ipLiteralsSource === "env"}
                                            onChange={(e) => setIpSignInChoice(e.target.checked)}
                                        />
                                        <p className={`mt-2 text-xs leading-relaxed ${ipSignInChoice ? "font-semibold text-red-700" : "text-gray-500"}`}>
                                            {t("siteAddress.signIn.warn.ip")}
                                        </p>
                                    </div>
                                </div>
                                {state.envHosts.length > 0 && (
                                    <div>
                                        <h3 className="font-bold text-gray-900">{t("siteAddress.env.title")}</h3>
                                        <ul className="mt-1 flex flex-wrap gap-2">{state.envHosts.map((h) => <li key={h} className="rounded-xl bg-gray-100 px-3 py-1 font-mono text-xs">{h}</li>)}</ul>
                                    </div>
                                )}
                                {state.devOrigins.length > 0 && (
                                    <div>
                                        <h3 className="font-bold text-gray-900">{t("siteAddress.dev.title")}</h3>
                                        <ul className="mt-1 flex flex-wrap gap-2">{state.devOrigins.map((h) => <li key={h} className="rounded-xl bg-gray-100 px-3 py-1 font-mono text-xs">{h}</li>)}</ul>
                                        {!state.dev && <p className="mt-1 text-xs text-gray-500">{t("siteAddress.dev.inactive")}</p>}
                                    </div>
                                )}
                            </div>
                        </section>

                        {/* 4. Recently refused */}
                        <section className={card} aria-labelledby="sa-refused">
                            <div className={cardHead}>
                                <h2 id="sa-refused" className={cardTitle}><i className="fa-solid fa-ban text-red-500" aria-hidden="true"></i> {t("siteAddress.refused.title")}</h2>
                                <p className="mt-1 text-sm text-gray-500">{t("siteAddress.refused.help")}</p>
                            </div>
                            {state.recentlyRefused.length === 0 ? (
                                <p className="p-8 text-sm text-gray-500">{t("siteAddress.refused.empty")}</p>
                            ) : (
                                <DataTable
                                    rows={state.recentlyRefused}
                                    rowKey={(entry) => entry.host}
                                    caption={t("siteAddress.refused.title")}
                                    rowLabel={(entry) => entry.host}
                                    actionsLabel={t("siteAddress.col.actions")}
                                    density="compact"
                                    columns={[
                                        {
                                            key: "address",
                                            header: t("siteAddress.col.address"),
                                            primary: true,
                                            cell: (entry) => (
                                                <span className="font-mono text-sm text-gray-800 lg:whitespace-nowrap break-all">
                                                    {entry.host}
                                                    {/* Who refused it: the public listener's edge, the backend's own gate, or each. */}
                                                    <RefusedByLabel source={entry.source} t={t} />
                                                </span>
                                            ),
                                        },
                                        { key: "count", header: t("siteAddress.col.count"), cell: (entry) => <span className="text-sm">{entry.count}</span> },
                                        { key: "lastSeen", header: t("siteAddress.col.lastSeen"), className: "md:whitespace-nowrap", cell: (entry) => <span className="text-sm">{formatTime(entry.lastSeen) ?? ""}</span> },
                                        { key: "hint", header: t("siteAddress.col.hint"), cell: (entry) => <span className="text-xs text-gray-600">{entry.hint ? t(`siteAddress.hint.${entry.hint}`) : ""}</span> },
                                    ]}
                                    // A proxy that does not forward Host is fixed in the proxy: declaring the
                                    // address it substitutes would accept every name behind it.
                                    actions={(entry) => entry.hint === "forward-host" ? [] : [
                                        { key: "add", label: t("siteAddress.refused.add"), icon: "fa-plus", onClick: () => setDialog({ kind: "alias", previous: null, prefillUrl: `https://${entry.host}`, fromRefused: true }), tone: "primary" },
                                    ]}
                                />
                            )}
                        </section>
                    </>
                )}
            </div>

            {state && dialog?.kind === "alias" && (
                <AliasDialog
                    state={state}
                    previous={dialog.previous}
                    prefillUrl={dialog.prefillUrl}
                    fromRefused={dialog.fromRefused}
                    t={t}
                    onSubmit={(alias) => submitAlias(alias, dialog.previous)}
                    onClose={() => setDialog(null)}
                />
            )}
            {state && dialog?.kind === "canonical" && (
                <CanonicalDialog
                    state={state}
                    prefillUrl={dialog.prefillUrl}
                    usingCurrent={!!state.canonical && isCurrentAddress(state.canonical.hostname, state, hostname)}
                    t={t}
                    onSubmit={submitCanonical}
                    onClose={() => setDialog(null)}
                />
            )}
            {pending && (
                <SudoDialog pending={pending} t={t} onDone={finished} onStale={stale} onClose={() => setPending(null)} />
            )}
        </div>
    );
}
